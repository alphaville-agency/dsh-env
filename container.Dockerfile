# The developer workspace. NOT the agency: it may disappear without affecting production, and the
# agency must never depend on it.
#
# There is no Tailscale here on purpose. Cloudflare Containers have no public port at all - access
# is `wrangler containers ssh`, authenticated against the Cloudflare account - so a tailnet would be
# a second access path to the same box, which is the "two ways to do one thing" defect this project
# keeps naming. It was in an earlier revision because Render needed it; Render is gone.
#
# Disk is EPHEMERAL: a sleeping container wakes with a fresh disk. The image carries the toolchain
# and git carries the state. That is an honest fit for an agent workspace and a poor one for
# anything else.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-server tmux less jq ripgrep \
      python3 python3-venv python3-pip nodejs npm \
 && rm -rf /var/lib/apt/lists/*

# The harness, so the workspace is the same one used locally.
RUN npm install -g @deepseek-ai/dsh

# mise: the repository's single test/build/deploy entry point.
RUN curl -fsSL https://mise.run | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /work

# sshd in the foreground. Containers reach this over `wrangler containers ssh` with an ed25519 key
# declared in wrangler.jsonc; nothing listens on a public interface.
RUN mkdir -p /run/sshd
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
