#!/bin/sh
# Runs inside the Cloudflare sandbox runtime, which owns the platform's health endpoint and port
# verification. This only owns the shell, the state, and shutting down when nobody is working.
set -u
export HOME=/root
IDLE_TIMEOUT="${DSH_IDLE_TIMEOUT:-1800}"
log() { echo "[dsh] $*"; }

log "starting"
mkdir -p /run/sshd
[ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -A || log "host key generation failed"

/usr/sbin/sshd -D -e >>/tmp/sshd.log 2>&1 &
SSHD=$!
sleep 3
if kill -0 "$SSHD" 2>/dev/null; then log "sshd listening on 22"
else log "sshd FAILED: $(tail -3 /tmp/sshd.log 2>/dev/null | tr '\n' ' ')"; fi

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

while :; do sleep 3600; done
