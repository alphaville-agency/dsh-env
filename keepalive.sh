#!/bin/sh
# Four jobs: the session, the health responder the platform requires, state persistence, and
# shutting down when nobody is working.
set -u

IDLE_TIMEOUT="${DSH_IDLE_TIMEOUT:-1800}"   # 30 minutes without terminal activity
STATE_REMOTE="${DSH_STATE_REMOTE:-}"       # r2:alphaville-dsh/state, if configured
export HOME=/root

mkdir -p /run/sshd
/usr/sbin/sshd -D -e &
SSHD=$!

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

# The harness state is what makes this workspace ours rather than a fresh box: sessions, history,
# config, workspace list. It is small text, so it syncs cheaply to R2 and back.
# Build the object-store remote from the environment. Credentials arrive as Worker secrets passed at
# start, never baked into the image or committed - a secret in a repository is the defect this
# project keeps finding.
if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && [ -n "${R2_ENDPOINT:-}" ]; then
    export RCLONE_CONFIG_R2_TYPE=s3
    export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
    export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
    export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
    export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
    STATE_REMOTE="${STATE_REMOTE:-r2:dsh-state/home}"
fi

if [ -n "$STATE_REMOTE" ] && command -v rclone >/dev/null 2>&1; then
    echo "restoring state from $STATE_REMOTE"
    rclone sync "$STATE_REMOTE" /root --create-empty-src-dirs --quiet --exclude ".cache/**" --exclude "tmp/**" || \
        echo "state restore failed; starting fresh"
fi

save_state() {
    [ -n "$STATE_REMOTE" ] || return 0
    command -v rclone >/dev/null 2>&1 || return 0
    rclone sync /root "$STATE_REMOTE" --quiet --exclude ".cache/**" --exclude "tmp/**" || echo "state save failed"
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
                # Checkpoint state periodically: the sleep is unannounced, so saving only at the end
                # would lose the last stretch of work.
                [ $((idle % 300)) -lt 60 ] && save_state
            else
                # Idle past the timeout: persist and stop renewing, so sleepAfter shuts us down.
                save_state
            fi
        fi
    done
}
poll &

# Persist on the way out, whatever the reason.
trap 'save_state; kill $SSHD $HEALTH 2>/dev/null' EXIT INT TERM
wait "$SSHD"
