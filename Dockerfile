# The developer environment: a tailnet-joined workspace. It is NOT the agency and the agency must
# never depend on it - it can disappear without affecting production.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-server tmux python3 python3-venv \
      jq less ripgrep \
 && curl -fsSL https://tailscale.com/install.sh | sh \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY . /work
RUN python3 -m venv /work/.venv || true
# Joins the tailnet as a tagged, ephemeral node using the OAuth client secret from the dsh-tui group, which Tailscale accepts in place of an auth key, then
# stays up. Ephemeral so a restarted container does not accumulate stale devices in the tailnet.
CMD ["/work/entrypoint.sh"]
