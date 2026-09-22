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
TS_KEY="${TAILSCALE_AUTHKEY:-${TAILSCALE_OAUTH_CLIENT_SECRET:-}}"
if command -v tailscale >/dev/null 2>&1 && [ -n "$TS_KEY" ]; then
    echo "joining tailnet as ${TS_NAME}..."
    if tailscale up --auth-key="$TS_KEY" \
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
# Seed a minimal harness home if the workspace has none: the web profile composes its config
# under ~/.dsh, so a container without it exits immediately and says nothing useful.
mkdir -p "${DSH_HOME:-/root/.dsh}/profiles/web"
if [ ! -f "${DSH_HOME:-/root/.dsh}/settings.yaml" ]; then
    printf 'version: 1\n' > "${DSH_HOME:-/root/.dsh}/settings.yaml"
fi

echo "starting dsh web on ${TAILNET_IP}:${WEB_PORT}"
# Run it in the background rather than exec: if the interface fails to start we want the health
# endpoint and the container to stay up, with the reason on stdout. A container that dies on one
# component's failure cannot be diagnosed from the outside.
dsh --profile web --host "$TAILNET_IP" --port "$WEB_PORT" --no-open \
    --trusted-host "$WEB_HOSTNAME" --trusted-host "${TAILNET_IP}:${WEB_PORT}" \
    > /tmp/dsh-web.log 2>&1 &
WEB_PID=$!
sleep 20
if kill -0 "$WEB_PID" 2>/dev/null; then
    echo "dsh web is up on ${TAILNET_IP}:${WEB_PORT}"
else
    echo "dsh web failed to start; last output:"
    tail -25 /tmp/dsh-web.log 2>/dev/null || true
fi
echo "workspace alive; health endpoint answering"
exec tail -f /dev/null
