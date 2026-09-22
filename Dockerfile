# Dev workspace image for Cloudflare Containers. Built for linux/amd64 as Containers require.
#
# Disk is EPHEMERAL: a sleeping container wakes with a fresh disk, so nothing that matters may live
# only here. The image carries the toolchain; git carries the state. That is an honest fit for an
# agent workspace and a bad one for anything else, which is why this is not the agency's runtime.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-server tmux less jq ripgrep \
      python3 python3-venv python3-pip nodejs npm \
 && rm -rf /var/lib/apt/lists/*
# The harness itself, so the workspace is the same one used locally.
RUN npm install -g @deepseek-ai/dsh || true
# mise for the repo's single test/build entry point.
RUN curl -fsSL https://mise.run | sh || true
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /work
# A login shell on SSH entry, and sshd in the foreground: Containers reach a shell over
# `wrangler containers ssh`, which authenticates against the Cloudflare account. There is no public
# port on the container at all - that is the property that makes this better than a public service.
RUN mkdir -p /run/sshd
EXPOSE 22
CMD ["/usr/sbin/sshd","-D","-e"]
