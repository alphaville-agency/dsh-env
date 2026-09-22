#!/bin/sh
# The workspace is the harness's BROWSER interface, bound to the tailnet address so it has no
# public surface at all. The platform port serves one constant health response and nothing else.
#
# Start order matters: the health server comes up first, so the service is never unhealthy while
# the tailnet join or the interface is still coming up. A container that refuses to boot when one
# optional component is missing exits 127 and tells you nothing.
set -u
PUBLIC_PORT="${PORT:-10000}"
WEB_PORT="${DSH_WEB_PORT:-8788}"
STATUS_PORT="${DSH_STATUS_PORT:-8787}"
TS_NAME="${TS_HOSTNAME:-dsh}"
WEB_HOSTNAME="${DSH_WEB_HOSTNAME:-dsh.alphaville.space}"

export DSH_PUBLIC_HEALTH_URL="http://127.0.0.1:${PUBLIC_PORT}/healthz"
export DSH_STATUS_PORT="$STATUS_PORT"

# 1. Always reachable: the only thing the internet may see.
python3 /work/keepalive.py &

# 2. Join the tailnet. Failure is reported, not fatal.
TAILNET_IP=127.0.0.1
if command -v tailscale >/dev/null 2>&1 && [ -n "${TAILSCALE_OAUTH_CLIENT_SECRET:-}" ]; then
    echo "joining tailnet as ${TS_NAME}..."
    if tailscale up --auth-key="$TAILSCALE_OAUTH_CLIENT_SECRET" \
                    --hostname="$TS_NAME" --ephemeral --accept-routes; then
        TAILNET_IP="$(tailscale ip -4 | head -1)"
        echo "tailnet address: ${TAILNET_IP}"
    else
        echo "tailnet join failed; the interface will bind loopback only"
    fi
else
    echo "no tailnet credential or binary; interface binds loopback only"
fi

# 3. The harness browser UI, on the tailnet address ONLY. Bound to the tailnet IP rather than
#    0.0.0.0, so it is unreachable from the public internet by construction, not by policy.
echo "starting dsh web on ${TAILNET_IP}:${WEB_PORT}"
exec dsh --profile web --host "$TAILNET_IP" --port "$WEB_PORT" --no-open \
         --trusted-host "$WEB_HOSTNAME" --trusted-host "${TAILNET_IP}:${WEB_PORT}"
