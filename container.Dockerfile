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
