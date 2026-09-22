#!/bin/sh
# The container sleeps after `sleepAfter` of no INCOMING REQUESTS. An SSH session is not one, so an
# idle shell would be killed mid-thought. This polls the Worker's own public health endpoint while
# at least one session is attached, which is an incoming request and resets the timer.
#
# When the last session disconnects the polling stops, and the container shuts itself down - which
# is the behaviour we want: it exists while someone is using it and costs nothing when nobody is.
set -u
/usr/sbin/sshd -D -e &
SSHD=$!

poll() {
    while :; do
        sleep "${KEEPALIVE_INTERVAL:-60}"
        [ -n "${WORKER_HEALTH_URL:-}" ] || continue
        # `who` lists attached sessions; sshd writes one entry per connection.
        if [ -n "$(who 2>/dev/null)" ]; then
            curl -fsS -m 10 "$WORKER_HEALTH_URL" >/dev/null 2>&1 || true
        fi
    done
}
poll &
wait "$SSHD"
