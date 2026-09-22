# The developer workspace. NOT the agency: it may disappear without affecting production.
#
# Alpine, not Debian: this image exists to give one developer a shell, so every megabyte is a
# megabyte pulled on every cold start. No Tailscale - Cloudflare Containers have no public port and
# are reached with `wrangler containers ssh`, so a tailnet would be a second path to the same box.
#
# Disk is EPHEMERAL. The image carries the toolchain; git carries the state.
FROM alpine:3.20

RUN apk add --no-cache \
      openssh git curl jq ripgrep less tmux \
      python3 py3-pip nodejs npm

# The harness, so the workspace is the same one used locally.
RUN npm install -g @deepseek-ai/dsh

# mise: the repository's single test/build/deploy entry point.
RUN curl -fsSL https://mise.run | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /work

# Keeps the container awake only while a session is attached. An SSH connection is not an incoming
# request, so it does not reset the sleep timer on its own - this is what does.
COPY keepalive.sh /usr/local/bin/keepalive.sh
RUN chmod +x /usr/local/bin/keepalive.sh

RUN mkdir -p /run/sshd
EXPOSE 22
CMD ["/usr/local/bin/keepalive.sh"]
