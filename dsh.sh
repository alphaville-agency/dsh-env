#!/bin/sh
# Open the dsh developer workspace, from a terminal on this machine.
#
#   ./dsh.sh        open a session and land in the dsh TUI
#
# THAT IS THE WHOLE INTERFACE. There is no one-shot command mode, because there is no command
# endpoint on the Worker: an earlier version served `POST /run`, which executed arbitrary commands as
# root, and it existed for the developer's convenience in verifying things. The terminal is how a
# person works in here, so the terminal is also how anyone verifies it.
#
# AUTHENTICATION IS CLOUDFLARE ACCESS. The hostname is behind an Access application whose only policy
# admits a service token, so the edge refuses everything else before it reaches the Worker - for HTTP
# and for the WebSocket upgrade alike. This script reads that service token and passes it through.
#
# WHY THIS IS NOT A `wrangler` CALL ANY MORE. The first version of this script minted a token and
# wrote it to the Worker with `wrangler secret put` on every session. That needed an authenticated
# wrangler 4 on whatever machine you were on, and it failed the first time it met the deprecated
# wrangler 1 - with an error about a config path, three steps away from the actual problem. There is
# also nothing to read back: Cloudflare secrets and Secrets Store secrets are both write-only, so
# "fetch the shared secret with wrangler" is not a thing this platform does. A service token is a
# credential the client can hold, which is the difference that matters.
#
# Environment:
#   DSH_URL                  origin of the Worker   (default https://dsh.alphaville.space)
#   DSH_TERMINAL_URL         WebSocket URL          (default wss://dsh.alphaville.space/ws/terminal)
#   DSH_SHELL                what the PTY runs      (default: the image's dsh-session wrapper)
#   DSH_ACCESS_FILE          where the token lives  (default ~/.dsh/access)
#   CF_ACCESS_CLIENT_ID      override, or set these two directly
#   CF_ACCESS_CLIENT_SECRET
set -eu

ACCESS_FILE="${DSH_ACCESS_FILE:-$HOME/.dsh/access}"
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }

# The service token, read from a file that holds exactly two lines:
#
#   line 1  the client id,     e.g. 1a2b3c....access
#   line 2  the client secret
#
# Written by whoever provisions the environment; never committed, never echoed.
read_access_token() {
    if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
        return 0
    fi
    [ -f "$ACCESS_FILE" ] || {
        cat >&2 <<EOF
the Cloudflare Access service token is not available.

  expected: $ACCESS_FILE
  containing two lines - the client id, then the client secret.

That file is how you prove to the Access gate that you may reach the workspace. It is not in the
repository and not in the image; whoever provisioned the environment has it.
EOF
        exit 1
    }
    CF_ACCESS_CLIENT_ID=$(sed -n '1p' "$ACCESS_FILE")
    CF_ACCESS_CLIENT_SECRET=$(sed -n '2p' "$ACCESS_FILE")
    if [ -z "$CF_ACCESS_CLIENT_ID" ] || [ -z "$CF_ACCESS_CLIENT_SECRET" ]; then
        echo "$ACCESS_FILE must contain the client id on line 1 and the client secret on line 2" >&2
        exit 1
    fi
    export CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET
}

if [ "$#" -gt 0 ]; then
    cat >&2 <<EOF
dsh.sh takes no arguments. It opens a session, and the only thing a session runs is the TUI.

  ./dsh.sh

There is deliberately no "run one command" mode: the Worker serves no command endpoint, because an
endpoint that exists so a developer can verify things from a shell script is an arbitrary-command
API on a public hostname. Run what you need inside the session.
EOF
    exit 2
fi

need node
read_access_token

# Exec, so the TUI replaces this shell and owns the terminal: Ctrl-C and window-resize reach it
# directly rather than through an intermediate process.
exec node "$SELF_DIR/bin/dsh-client.mjs"