#!/bin/sh
# The dsh developer workspace, from a terminal on your Mac.
#
#   ./dsh.sh                 attach this terminal to the workspace and land in the dsh TUI
#   ./dsh.sh --takeover      take the input lease from whoever holds it, and start typing
#   ./dsh.sh <command...>    run one command in the workspace and print its output
#
# One client holds the input lease at a time. Any number of others may be attached and live - they
# see output as it happens - but they cannot type, and they say so. `--takeover` is how a second
# window takes over: the previous holder is told at once and drops to read-only.
#
# With no argument the WebSocket upgrade is itself a request to the Worker, so the sandbox starts on
# connect and stops five minutes after the last activity. Nothing polls to keep it up, by design:
# see docs/COST.md.
#
# Environment: DSH_URL (the one-shot endpoint's origin), DSH_TERMINAL_URL (the WebSocket URL),
# DSH_COMMAND (what the terminal runs; empty gives a bare shell), DSH_TAKEOVER=1 (the same as
# --takeover), DSH_CLIENT_ID (override this terminal's identity).
set -eu

URL="${DSH_URL:-https://dev-dsh.alphaville.space}"
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Waking a stopped container is a request round trip, not an instant, so give it room.
POST_TIMEOUT=300

# The request field POST /run expects, and the takeover flag the client reads. Both are named in
# src/names.ts (COMMAND_FIELD and TAKEOVER_FLAG); this script only carries them.
COMMAND_KEY=command
TAKEOVER_FLAG=--takeover

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }

# Encode one shell string as a JSON string, and read one field back out of the reply. jq is the
# first choice because it is the tool for this; python3 is the fallback, not an extra dependency.
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
    echo "missing: jq or python3 (either one can encode the command)" >&2
    exit 1
fi

TAKEOVER=0
if [ "$#" -gt 0 ] && [ "$1" = "$TAKEOVER_FLAG" ]; then
    TAKEOVER=1
    shift
fi

if [ "$#" -eq 0 ]; then
    need node
    if [ "$TAKEOVER" -eq 1 ]; then
        DSH_TAKEOVER=1
        export DSH_TAKEOVER
    fi
    exec node "$SELF_DIR/bin/dsh-client.mjs"
fi

if [ "$TAKEOVER" -eq 1 ]; then
    echo "$TAKEOVER_FLAG attaches a terminal; it means nothing in front of a command" >&2
    exit 2
fi

need curl

BODY=$(printf '%s' "$*" | encode | { printf '{"%s":' "$COMMAND_KEY"; cat; printf '}'; })

# --fail-with-body so a rejection (a bad request, a failed start) is shown rather than swallowed.
if ! RESP=$(curl -sS --fail-with-body -m "$POST_TIMEOUT" -X POST \
        -H 'content-type: application/json' --data "$BODY" "$URL/run"); then
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
