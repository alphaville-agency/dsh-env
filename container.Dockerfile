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

# The harness, which is the entire point of this environment: without it the container is a shell in
# the cloud rather than a place to work.
#
# It is TWO things, and getting only the first is the trap this file already fell into once:
#
#   1. `@deepseek-ai/dsh`, the launcher, installed globally so `dsh` is on PATH.
#   2. A PROFILE at $DSH_HOME/profiles/dsh-tui, whose package.json declares the TUI as a bundle.
#      The TUI is an out-of-tree mode bundle over `@deepseek-ai/dsh-base`, not a standalone binary,
#      so `npm install -g <tui>` installs nothing that can be run. `dsh plugin --profile dsh-tui add`
#      is the documented way to populate it, and the profile's package.json is committed rather than
#      generated so the tree is reviewable and reproducible.
#
# VERSIONS ARE THE WORKING ONES, TAKEN FROM A RUNNING SETUP, and that is not laziness: the launcher's
# `latest` (0.1.5-rc.2) is BROKEN. It depends on
# `@deepseek-ai/dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`, a version that was never
# published - the package stops at 0.1.5-rc.2 - so a plain `npm install` of latest fails outright
# with ETARGET. The first attempt at this layer did exactly that and broke the build. 0.1.5-rc.1 is
# the version proven to install and run.
#
# The npm cache is purged in the same RUN that fills it: layers are additive, so a later `rm -rf`
# would reclaim nothing of the ~100 MB it leaves behind.
ARG DSH_LAUNCHER_VERSION=0.1.5-rc.1
RUN npm install --global "@deepseek-ai/dsh@${DSH_LAUNCHER_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm

# The profile's manifest, patch layer and the harness settings, all committed under dsh-profile/ so
# the configuration the terminal boots with is reviewable in a diff like anything else.
#
# settings.yaml carries NO credential: the provider block names an environment variable
# (`apiKeyEnv: CHEAPINFERENCE_COM_API_KEY`) and the value is injected at run time from a Worker
# secret. That separation is the reason this file is safe to commit at all.
ENV DSH_HOME=/root/.dsh

# The session wrapper: one program on PATH that boots the TUI on the committed profile. See
# its own header for why the terminal runs a wrapper instead of a command with arguments.
COPY bin/dsh-session /usr/local/bin/dsh-session
RUN chmod 0755 /usr/local/bin/dsh-session
COPY dsh-profile/settings.yaml     /root/.dsh/settings.yaml
COPY dsh-profile/package.json      /root/.dsh/profiles/dsh-tui/package.json
COPY dsh-profile/cordis.patch.yml  /root/.dsh/profiles/dsh-tui/cordis.patch.yml

# Materialise the profile's bundle tree from its committed manifest, and purge the cache in the same
# layer. `--omit=dev` is not used here: the bundles are the runtime, not build-time tooling.
RUN cd /root/.dsh/profiles/dsh-tui \
 && npm install --no-audit --no-fund \
 && npm cache clean --force \
 && rm -rf /root/.npm

# Prove at build time that the harness runs and that the profile's bundle is actually present. An
# image that builds and then cannot boot its own harness is the failure this environment has spent
# longest on, and it costs nothing to catch here instead of in a session.
RUN command -v dsh \
 && dsh --version \
 && test -d /root/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
