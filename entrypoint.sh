#!/bin/sh
# Start the workspace even if the tailnet join cannot happen. A container that refuses to boot when
# one optional component is missing is undebuggable: it exits 127 and tells you nothing. So the
# health server comes up first, the join is attempted and reported, and the box stays reachable
# enough to find out why.
set -u
PORT="${PORT:-10000}"
export DSH_PUBLIC_HEALTH_URL="http://127.0.0.1:${PORT}/healthz"

if command -v tailscale >/dev/null 2>&1; then
    if [ -n "${TAILSCALE_OAUTH_CLIENT_SECRET:-}" ]; then
        echo "joining tailnet as ${TS_HOSTNAME:-dsh}..."
        tailscale up --auth-key="$TAILSCALE_OAUTH_CLIENT_SECRET" \
                     --hostname="${TS_HOSTNAME:-dsh}" --ephemeral --accept-routes || \
            echo "tailnet join failed; continuing so the workspace is still inspectable"
    else
        echo "no tailnet credential in the environment; not joining"
    fi
else
    echo "tailscale binary absent; not joining"
fi

echo "starting status server on port ${PORT}"
exec python3 /work/keepalive.py
