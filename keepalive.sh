#!/bin/sh
# Two listeners, because the platform needs something the shell cannot provide.
#
# The Container class health-checks an HTTP pingEndpoint during startup. sshd does not speak HTTP,
# so without a responder here the start fails and the Worker throws - which is what /start was
# reporting. A tiny HTTP server answers that check; sshd serves the actual session over
# `wrangler containers ssh`, which has no public port.
#
# The keepalive then holds the container open only while a session is attached: an SSH connection is
# not an incoming request, so it cannot reset the sleep timer by itself. When the last session
# disconnects, polling stops and the container shuts itself down.
set -u

mkdir -p /run/sshd
/usr/sbin/sshd -D -e &
SSHD=$!

# Health endpoint the Container class polls on startup ("/ping" by default).
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

poll() {
    while :; do
        sleep "${KEEPALIVE_INTERVAL:-60}"
        [ -n "${WORKER_HEALTH_URL:-}" ] || continue
        [ -n "$(who 2>/dev/null)" ] && curl -fsS -m 10 "$WORKER_HEALTH_URL" >/dev/null 2>&1
    done
}
poll &

trap 'kill $SSHD $HEALTH 2>/dev/null' EXIT INT TERM
wait "$SSHD"
