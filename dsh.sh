#!/bin/sh
# The dsh developer workspace, from a terminal on your laptop.
#
#   ./dsh.sh                 open a new session and land in the dsh TUI
#   ./dsh.sh <command...>    run one command in the workspace and print its output
#
# THE TOKEN IS MINTED HERE, ON EVERY SESSION, AND WRITTEN TO THE WORKER.
#
# There is no shared secret to copy around and none to store. Cloudflare secrets are write-only -
# `wrangler secret` has put/list/delete and no get, and the Secrets Store's `get` returns metadata
# rather than a value - so a token that can be *read back* is not something the platform offers.
# Rather than fight that, this script generates a fresh token, writes it to the Worker with
# `wrangler secret put`, and uses it immediately. It needs an authenticated `wrangler` on this
# machine, which is the same requirement as deploying, and it is the only credential involved.
#
# That is also what makes the workspace a SINGLETON. Opening a new session rotates the token, so any
# older client can no longer authenticate: the old session is superseded the moment a new one starts,
# and there is never a question of which window is authoritative. The trade-off, stated rather than
# implied: an already-connected older client is not force-disconnected, because its socket is
# established. It keeps working until it reconnects, and then it is refused. For one operator that is
# the right side of the trade; forcibly closing live sockets would mean holding them, which is
# machinery this environment does not otherwise need.
#
# The token is cached at $DSH_TOKEN_FILE so that one-shot commands do not pay for a `secret put`
# round trip each time. A session rotates it; a command reuses it.
#
# Environment:
#   DSH_URL            origin of the Worker            (default https://dsh.alphaville.space)
#   DSH_TERMINAL_URL   WebSocket URL                   (default wss://dsh.alphaville.space/ws/terminal)
#   DSH_COMMAND        what the terminal runs          (default `exec dsh`)
#   DSH_TOKEN_FILE     where the token is cached       (default ~/.dsh/token)
#   DSH_WORKER         Worker name for `secret put`    (default shared-tooling-dsh-shell)
set -eu

URL="${DSH_URL:-https://dsh.alphaville.space}"
WORKER="${DSH_WORKER:-shared-tooling-dsh-shell}"
TOKEN_FILE="${DSH_TOKEN_FILE:-$HOME/.dsh/token}"
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Waking a stopped container is a request round trip, not an instant, so give it room.
POST_TIMEOUT=300

# The request field POST /run expects. Named in src/names.ts (COMMAND_FIELD); carried here only
# because this script runs on the laptop, where nothing from src/ exists.
COMMAND_KEY=command

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
die() { echo "$*" >&2; exit 1; }

# Encode one shell string as JSON and read one field back. jq first because it is the tool for this;
# python3 is the fallback, not an extra dependency.
if command -v jq >/dev/null 2>&1; then
    encode() { jq -Rs .; }
    field() { jq -r --arg key "$1" '.[$key] // empty'; }
elif command -v python3 >/dev/null 2>&1; then
    encode() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }
    field() {
        python3 -c 'import json,sys
value = json.load(sys.stdin).get(sys.argv[1], "")
sys.stdout.write("" if value is None else str(value))' "$1"
    }
else
    die "missing: jq or python3 (either one can encode the command)"
fi

# A fresh token. 32 random bytes, hex, so it is safe in a header and safe in a shell variable.
mint_token() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        need node
        node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
    fi
}

# Write the token to the Worker, and keep it locally so a one-shot command can reuse it.
publish_token() {
    token=$(mint_token)
    printf '%s' "$token" | wrangler secret put DSH_TOKEN --name "$WORKER" >/dev/null 2>&1 \
        || die "could not write DSH_TOKEN to the Worker '$WORKER' (is wrangler authenticated? run: wrangler whoami)"
    mkdir -p "$(dirname "$TOKEN_FILE")"
    (umask 077 && printf '%s' "$token" > "$TOKEN_FILE")
    printf '%s' "$token"
}

# Reuse the cached token when there is one; the Worker refuses everything if it is stale, and the
# caller sees a 401 rather than a mystery. One-shot commands do not need a new session.
cached_token() {
    [ -s "$TOKEN_FILE" ] && cat "$TOKEN_FILE"
}

# A session rotates; a command reuses.
SESSION=0
if [ "$#" -eq 0 ]; then
    SESSION=1
fi

if [ "$SESSION" -eq 1 ]; then
    need wrangler
    TOKEN=$(publish_token)
    echo "[new session: the workspace token has been rotated]" >&2
else
    need curl
    TOKEN=$(cached_token)
    if [ -z "$TOKEN" ]; then
        need wrangler
        TOKEN=$(publish_token)
    fi
fi
export DSH_TOKEN="$TOKEN"

if [ "$SESSION" -eq 1 ]; then
    need node
    exec node "$SELF_DIR/bin/dsh-client.mjs"
fi

BODY=$(printf '%s' "$*" | encode | { printf '{"%s":' "$COMMAND_KEY"; cat; printf '}'; })

# --fail-with-body so a rejection (a bad request, a failed start) is shown rather than swallowed.
if ! RESP=$(curl -sS --fail-with-body -m "$POST_TIMEOUT" -X POST \
        -H 'content-type: application/json' \
        -H "Authorization: Bearer $TOKEN" \
        --data "$BODY" "$URL/run"); then
    echo "the workspace could not run that: ${RESP:-no response}" >&2
    exit 1
fi

OUT=$(printf '%s' "$RESP" | field stdout)
ERR=$(printf '%s' "$RESP" | field stderr)
CODE=$(printf '%s' "$RESP" | field exitCode)

if [ -n "$OUT" ]; then printf '%s\n' "$OUT"; fi
if [ -n "$ERR" ]; then printf '%s\n' "$ERR" >&2; fi

# The container command's own exit code is this script's exit code.
case "$CODE" in
    ''|*[!0-9-]*) exit 1 ;;
    *) exit "$CODE" ;;
esac