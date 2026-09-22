#!/bin/sh
# Wake the remote workspace and open a shell in it.
#
# `wrangler containers ssh` does not start a stopped container, so this wakes it first and waits for
# it to be healthy, then hands over the shell. One command, because a two-step wake is a step that
# gets forgotten.
set -eu
WORKER="${DSH_WORKER:-prod-tooling-dsh-shell}"
URL="${DSH_WAKE_URL:-https://dsh.alphaville.space}"

echo "waking the workspace at ${URL} ..."
curl -fsS -m 120 "$URL" >/dev/null || { echo "failed to wake it"; exit 1; }

APP=$(wrangler containers list --json 2>/dev/null | python3 -c "
import json,sys
for c in json.load(sys.stdin):
    if c.get('name') == '$WORKER': print(c['id']); break" 2>/dev/null)
[ -n "${APP:-}" ] || { echo "container application '$WORKER' not found"; exit 1; }

for i in $(seq 1 20); do
    ID=$(wrangler containers instances "$APP" --json 2>/dev/null | python3 -c "
import json,sys
try:
    xs=json.load(sys.stdin)
    xs=[x for x in (xs if isinstance(xs,list) else []) if x.get('state') in ('running','healthy')]
    print(xs[0]['id'] if xs else '')
except Exception: print('')" 2>/dev/null)
    [ -n "$ID" ] && break
    sleep 5
done
[ -n "${ID:-}" ] || { echo "container did not become healthy"; exit 1; }

echo "connected:"
exec wrangler containers ssh "$ID"
