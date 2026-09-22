#!/bin/sh
# Open the remote developer workspace.
#
#   ./dsh.sh            the harness TUI, as if it were local
#   ./dsh.sh <command>  run one command and exit
#
# The workspace has no public port: access is `wrangler containers ssh`, authenticated against the
# Cloudflare account with the ed25519 key in wrangler.jsonc. But SSH does not wake a stopped
# container - documented behaviour, not an oversight - so this wakes it first and waits for it to
# report healthy. That is why the wake lives here rather than in a separate step to remember.
#
# The container is on the `lite` instance and shuts down five minutes after its last request, so an
# idle workspace costs nothing.
set -eu

WORKER="${DSH_WORKER:-dev-tooling-dsh-shell}"
URL="${DSH_WAKE_URL:-https://dev-dsh.alphaville.space}"
KEY="${DSH_KEY:-$HOME/.ssh/alphaville_dsh}"
USER_="${DSH_USER:-root}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1"; exit 1; }; }
need curl; need wrangler; need ssh

app_id() {
    wrangler containers list --json 2>/dev/null | python3 -c "
import json,sys
try:
    for c in json.load(sys.stdin):
        if c.get('name') == '$WORKER': print(c['id']); break
except Exception: pass"
}

instance_id() {
    wrangler containers instances "$1" --json 2>/dev/null | python3 -c "
import json,sys
try:
    xs = json.load(sys.stdin)
    xs = [x for x in (xs if isinstance(xs, list) else []) if x.get('state') in ('running','healthy')]
    print(xs[0]['id'] if xs else '')
except Exception: pass"
}

APP="$(app_id)"
[ -n "$APP" ] || { echo "container application '$WORKER' not found"; exit 1; }

# Wake it by touching the Worker. Any request starts the container and waits for its ports.
if [ -z "$(instance_id "$APP")" ]; then
    echo "waking $WORKER ..."
    curl -fsS -m 180 "$URL" >/dev/null || { echo "could not wake it"; exit 1; }
fi

ID=""
for _ in $(seq 1 24); do
    ID="$(instance_id "$APP")"
    [ -n "$ID" ] && break
    sleep 5
done
[ -n "$ID" ] || { echo "container did not become healthy"; exit 1; }

# Proxy the real SSH client through wrangler's authenticated tunnel.
if [ "$#" -gt 0 ]; then
    exec ssh -t -i "$KEY" -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR \
        -o "ProxyCommand=wrangler containers ssh --stdio %h" "$USER_@$ID" "$@"
fi

# No argument: the harness TUI. A login shell first, so PATH includes mise.
exec ssh -t -i "$KEY" -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR \
    -o "ProxyCommand=wrangler containers ssh --stdio %h" "$USER_@$ID" \
    'sh -lc "exec ${SHELL:-/bin/sh} -lc dsh"'
