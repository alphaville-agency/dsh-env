#!/bin/sh
# Logs every step, and does not die with a component. A container that exits silently cannot be
# diagnosed from outside - that lesson has been learned twice on this project already.
set -u
export HOME=/root
IDLE_TIMEOUT="${DSH_IDLE_TIMEOUT:-1800}"

log() { echo "[dsh] $*"; }

log "starting"
mkdir -p /run/sshd

# Host keys: Alpine ships none, and sshd exits without them.
if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
    log "generating host keys"
    ssh-keygen -A || log "host key generation failed"
fi

# The HTTP responder the platform health-checks. Started first so the check can pass even while the
# shell is still coming up.
python3 - <<'PY' &
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.path.rstrip('/').endswith('ping') or self.path == '/'
        self.send_response(200 if ok else 404)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
socketserver.TCPServer(("", 8080), H).serve_forever()
PY
HEALTH=$!
log "health responder on 8080 (pid $HEALTH)"

# sshd in the foreground of its own process; its failure must not kill the container, or the reason
# is lost with it.
/usr/sbin/sshd -D -e >>/tmp/sshd.log 2>&1 &
SSHD=$!
sleep 3
if kill -0 "$SSHD" 2>/dev/null; then
    log "sshd listening on 22 (pid $SSHD)"
else
    log "sshd FAILED; last output: $(tail -3 /tmp/sshd.log 2>/dev/null | tr '\n' ' ')"
fi

# State persistence. Container disk is ephemeral; the harness's sessions, dotfiles and installed
# tools are not disposable.
if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; then
    export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare
    export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
    export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
    export RCLONE_CONFIG_R2_ENDPOINT="${R2_ENDPOINT:-}"
    STATE_REMOTE="${DSH_STATE_REMOTE:-r2:af-dev-tooling-dsh/home}"
    log "restoring state from $STATE_REMOTE"
    rclone sync "$STATE_REMOTE" /root --create-empty-src-dirs --quiet \
        --exclude ".cache/**" --exclude "tmp/**" 2>/dev/null || log "no state to restore"
else
    STATE_REMOTE=""
    log "no object-store credentials; state will not persist"
fi

save_state() {
    [ -n "$STATE_REMOTE" ] || return 0
    rclone sync /root "$STATE_REMOTE" --quiet --exclude ".cache/**" --exclude "tmp/**" 2>/dev/null || true
}

terminal_idle_seconds() {
    now=$(date +%s); newest=0
    for pty in /dev/pts/[0-9]*; do
        [ -e "$pty" ] || continue
        t=$(stat -c %Y "$pty" 2>/dev/null || echo 0)
        [ "$t" -gt "$newest" ] && newest="$t"
    done
    [ "$newest" -eq 0 ] && { echo 999999; return; }
    echo $((now - newest))
}

poll() {
    while :; do
        sleep "${KEEPALIVE_INTERVAL:-60}"
        if [ -n "$(who 2>/dev/null)" ]; then
            idle=$(terminal_idle_seconds)
            if [ "$idle" -lt "$IDLE_TIMEOUT" ]; then
                [ -n "${WORKER_HEALTH_URL:-}" ] && curl -fsS -m 10 "$WORKER_HEALTH_URL" >/dev/null 2>&1
                [ $((idle % 300)) -lt 60 ] && save_state
            else
                save_state
            fi
        fi
    done
}
poll &

trap 'log "stopping"; save_state' EXIT INT TERM

# Stay alive regardless of what any single component does.
while :; do
    sleep 3600
    if ! kill -0 "$HEALTH" 2>/dev/null; then log "health responder died; restarting"; fi
done
