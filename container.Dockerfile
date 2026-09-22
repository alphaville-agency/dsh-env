# The dsh developer workspace: the machine an agent or the operator works in. NOT the agency, and
# the agency must never depend on it - it may disappear without affecting production.
#
# THIS IS THE FLOOR. The base image, one toolchain layer, and nothing else: no COPY, no runtime
# install, no entrypoint override. 202 lines of image history were parked on
# `archive/pre-floor-design` because not one command had ever run in this container, and an image
# that had never executed `echo` was not a foundation to build a provisioner on.
#
# Awake time is NOT set by the image. Containers bill memory and disk on the PROVISIONED resources
# for the instance type, so a thinner image does not lower the rate; the idle cost is driven by
# `sleepAfter` alone (5 minutes, src/names.ts) plus the rule that nothing inside the container may
# poll, ping or heartbeat to stay awake. See docs/COST.md.
#
# Size is still not nothing: Cloudflare refuses an image over the 2000 MB that comes with `lite`,
# and it counts the image differently from Docker (1572 MB by `docker image inspect` was reported as
# 2250 MB - a ratio of ~1.43). That is why the toolchain below is the minimum a shell needs and not
# the list the workspace eventually wants: tmux, ripgrep, less, make, python3, gnupg and `gh` were
# all parked with the rest, and each comes back with the layer that can be verified to use it.
#
# Disk is EPHEMERAL: everything outside the R2 mount is gone at the next wake. git is the source of
# truth for work. No credential is ever baked in here; live secrets come from Worker secrets.
FROM docker.io/cloudflare/sandbox:0.12.9

ENV DEBIAN_FRONTEND=noninteractive

# The minimum toolchain, in one layer.
#
#   git curl ca-certificates  clone, fetch, and TLS for both
#   jq                        reading JSON from the shell, and from the layer-2 provisioner
#
# `apt-get clean` plus the explicit `rm` of the archive directory is not tidiness, it is ~299 MB of
# the image. The base image sets `Binary::apt::APT::Keep-Downloaded-Packages "true"`, so apt keeps
# every downloaded .deb in /var/cache/apt/archives - and removing them in a LATER layer would not
# help at all, because Docker layers are additive and the bytes stay in the layer that fetched them.
# The purge is therefore in the same RUN as the install. tests/dockerfile.test.mjs pins this.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl jq ca-certificates \
 && apt-get clean \
 && rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/*

# The harness itself, which is the entire point of this environment: without it the container is a
# shell in the cloud rather than a place to work.
#
# Pinned to an exact version rather than a tag. `latest` on this package currently resolves to
# 0.1.5-rc.2, while the `next` tag is 0.1.5-rc.3 - and rc.3 is the one whose dependency tree is
# broken, so an unpinned install is a coin flip that changes without warning. The version installed
# here is the one the terminal runs, so it is part of the interface, not an implementation detail.
#
# The npm cache is purged in the SAME RUN that fills it. A later `rm -rf` would reclaim nothing:
# Docker layers are additive and those bytes would stay in this layer forever. That mistake cost
# 108 MB once already and tests/dockerfile.test.mjs now pins the pattern.
ARG DSH_HARNESS_VERSION=0.1.5-rc.2
RUN npm install --global "@deepseek-ai/dsh@${DSH_HARNESS_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm

# Prove the binary is on PATH at build time. An image that builds and then cannot run its own
# harness is the failure this environment has spent the longest on, and it is cheap to catch here.
RUN command -v dsh && dsh --version
