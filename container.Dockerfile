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

# corepack, made reachable on PATH. This is a correctness fix rather than housekeeping: Node ships
# corepack, but this base image symlinks only `npm` and `npx` into /usr/local/bin, so `corepack` is
# not on PATH and a bare `command -v corepack` fails. Without it the profile installs cannot use
# pnpm, `pnpm-lock.yaml` is quietly ignored, and a frozen-lockfile install silently becomes a
# floating npm one - a reproducibility claim that is false because the mechanism never ran.
#
# Layer 2 needs it because layer 2 is the first layer that installs a node tree from a lockfile.
RUN if ! command -v corepack >/dev/null 2>&1; then \
      global_root="$(npm root -g 2>/dev/null || true)"; \
      corepack_js="$global_root/corepack/dist/corepack.js"; \
      if [ -f "$corepack_js" ]; then \
        printf '#!/bin/sh\nexec node %s "$@"\n' "$corepack_js" > /usr/local/bin/corepack; \
        chmod 0755 /usr/local/bin/corepack; \
      fi; \
    fi \
 && command -v corepack \
 && corepack --version

# The two provisioning scripts. They ship in the IMAGE rather than in the clone on purpose: they have
# to run before the clone exists, because installing is what makes the clone's manifests usable. They
# are 0600 in the repository, so the chmod is load-bearing - a COPY without it ships a file nobody
# can execute, and the failure appears only at run time. tests/dockerfile.test.mjs pins both facts.
COPY bin/dsh-provision.sh bin/dsh-state.sh /usr/local/libexec/
RUN chmod 0755 /usr/local/libexec/dsh-provision.sh /usr/local/libexec/dsh-state.sh \
 && ln -sf /usr/local/libexec/dsh-provision.sh /usr/local/bin/dsh-provision \
 && ln -sf /usr/local/libexec/dsh-state.sh /usr/local/bin/dsh-state
