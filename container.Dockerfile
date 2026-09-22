# The developer workspace. NOT the agency: it may disappear without affecting production.
#
# Alpine, because every megabyte is pulled on every cold start for a box that gives one developer a
# shell. No Tailscale: Containers have no public port and are reached with `wrangler containers ssh`.
#
# Container disk is EPHEMERAL, but the harness's state - sessions, history, dotfiles, installed
# tools - is not disposable. It lives in R2 and is synced here on start and before sleep.
FROM alpine:3.20

# The sandbox runtime. The `Container` SDK in the Worker talks to THIS binary inside the image: it
# is what answers port verification, exec and lifecycle. Without it the platform cannot verify the
# container's ports and every start fails - which is what "container is not running" and "failed to
# verify port" were telling us all along.
COPY --from=docker.io/cloudflare/sandbox:0.7.0 /container-server/sandbox /sandbox

RUN apk add --no-cache \
      openssh rclone \
      git curl jq ripgrep less tmux \
      python3 py3-pip nodejs npm

# sshd refuses to start without host keys and Alpine ships none.
RUN ssh-keygen -A

RUN npm install -g @deepseek-ai/dsh
RUN curl -fsSL https://mise.run | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /work
COPY mise.toml /work/mise.toml
RUN cd /work && mise trust mise.toml && mise install || true

# The platform's SSH proxy connects as `cloudchamber`, which Alpine does not have. The key is
# installed for that user and for root so whichever identity the proxy presents is accepted.
RUN adduser -D -s /bin/sh cloudchamber \
 && mkdir -p /run/sshd /root/.dsh /root/.ssh /home/cloudchamber/.ssh \
 && printf '%s\n' "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC+FNHSJUqtrnnyea86mdZmXNZJ+c+4LXXtc9ml47eA2 dsh@alphaville.space" > /root/.ssh/authorized_keys \
 && cp /root/.ssh/authorized_keys /home/cloudchamber/.ssh/authorized_keys \
 && chmod 700 /root/.ssh /home/cloudchamber/.ssh \
 && chmod 600 /root/.ssh/authorized_keys /home/cloudchamber/.ssh/authorized_keys \
 && chown -R cloudchamber:cloudchamber /home/cloudchamber/.ssh

COPY keepalive.sh /usr/local/bin/keepalive.sh
RUN chmod +x /usr/local/bin/keepalive.sh

EXPOSE 22
ENTRYPOINT ["/sandbox"]
CMD ["/usr/local/bin/keepalive.sh"]
