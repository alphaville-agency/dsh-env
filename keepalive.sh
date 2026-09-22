#!/bin/sh
# Three jobs, and the third is the interesting one.
#
# 1. sshd on 22 serves the session. Access is `wrangler containers ssh`; nothing listens publicly.
# 2. An HTTP responder on 8080 answers the platform's startup health check. The Container class
#    health-checks an HTTP pingEndpoint, and sshd cannot answer it - it does not speak HTTP. Without
#    this the start fails and the Worker throws.
# 3. A keepalive that holds the container open only while someone is actually working.
#
# On (3): the container sleeps after `sleepAfter` of no INCOMING REQUESTS, and an SSH connection is
# not one. But "a session is attached" is not the same as "someone is working" - an abandoned
# terminal would hold the box open indefinitely. So this polls the Worker only while the terminal
# has seen activity within IDLE_TIMEOUT. An idle session stops renewing, and the container shuts
# itself down: it exists while it is being used and costs nothing when it is not.
set -u

IDLE_TIMEOUT="${DSH_IDLE_TIMEOUT:-1800}"   # 30 minutes without terminal activity
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

# Seconds since a pseudo-terminal last carried traffic. The pty's mtime moves on every keystroke and
# every line of output, so it is a truer signal of "someone is working" than a session count.
terminal_idle_seconds() {
    now=$(date +%s)
    newest=0
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
        [ -n "${WORKER_HEALTH_URL:-}" ] || continue
        # No session at all: nothing to keep alive.
        [ -n "$(who 2>/dev/null)" ] || continue
        idle=$(terminal_idle_seconds)
        if [ "$idle" -lt "$IDLE_TIMEOUT" ]; then
            curl -fsS -m 10 "$WORKER_HEALTH_URL" >/dev/null 2>&1 || true
        fi
        # Idle past the timeout: stop renewing and let sleepAfter shut us down.
    done
}
poll &

trap 'kill $SSHD $HEALTH 2>/dev/null' EXIT INT TERM
wait "$SSHD"
