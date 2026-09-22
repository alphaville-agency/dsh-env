# The developer workspace. NOT the agency: it may disappear without affecting production.
#
# Alpine, because every megabyte is pulled on every cold start for a box that gives one developer a
# shell. No Tailscale: Containers have no public port and are reached with `wrangler containers ssh`,
# so a tailnet would be a second path to the same box.
#
# Container disk is EPHEMERAL, but the harness's state - sessions, history, config, workspaces - is
# not disposable. It lives in R2 and is synced here on start and before sleep. The image carries the
# toolchain; the state lives somewhere durable and free.
FROM alpine:3.20

RUN apk add --no-cache \
      openssh openssh-server-pam rclone \
      git curl jq ripgrep less tmux \
      python3 py3-pip nodejs npm

# sshd refuses to start without host keys, and Alpine's package does not generate them. Without
# this the entrypoint exits 1 immediately and the container fails with no useful message.
RUN ssh-keygen -A

RUN npm install -g @deepseek-ai/dsh
RUN curl -fsSL https://mise.run | sh
ENV PATH="/root/.local/bin:${PATH}"

# The declared toolchain is installed at build time, so a session starts ready to work rather than
# installing what it needs each time the ephemeral disk is reset.
COPY mise.toml /work/mise.toml
RUN cd /work && mise trust mise.toml && mise install || true

WORKDIR /work

COPY keepalive.sh /usr/local/bin/keepalive.sh
RUN chmod +x /usr/local/bin/keepalive.sh

RUN mkdir -p /run/sshd /root/.dsh
EXPOSE 22 8080
CMD ["/usr/local/bin/keepalive.sh"]
