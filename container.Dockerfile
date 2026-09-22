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
      openssh rclone \
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

# The platform's SSH proxy connects as `cloudchamber`, which Alpine does not have. The key is
# installed for both that user and root so whichever identity the proxy presents is accepted -
# guessing once already cost a round trip.
RUN adduser -D -s /bin/sh cloudchamber \
 && mkdir -p /run/sshd /root/.dsh /root/.ssh /home/cloudchamber/.ssh \
 && printf '%s\n' "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC+FNHSJUqtrnnyea86mdZmXNZJ+c+4LXXtc9ml47eA2 dsh@alphaville.space" > /root/.ssh/authorized_keys \
 && cp /root/.ssh/authorized_keys /home/cloudchamber/.ssh/authorized_keys \
 && chmod 700 /root/.ssh /home/cloudchamber/.ssh \
 && chmod 600 /root/.ssh/authorized_keys /home/cloudchamber/.ssh/authorized_keys \
 && chown -R cloudchamber:cloudchamber /home/cloudchamber/.ssh
EXPOSE 22 8080
CMD ["/usr/local/bin/keepalive.sh"]
