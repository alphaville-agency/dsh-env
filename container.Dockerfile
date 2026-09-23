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
# `latest` (0.1.5-rc.2) is BROKEN. Transitively - through a UI sub-package that has since published a
# newer version - it requires `@deepseek-ai/dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`, which
# was NEVER PUBLISHED. The package stops at 0.1.5-rc.2, so a fresh `npm install` of the launcher
# fails outright with ETARGET. Pinning a lower launcher version does not help, because the
# requirement comes from a transitive package rather than the launcher's own manifest - which is why
# two attempts at pinning a launcher version both failed this build.
#
# The fix is an npm `overrides` entry pinning that one dependency to the newest version that exists.
# It lives in a committed manifest and lockfile under dsh-install/, installed with `npm ci` so the
# tree is identical for every build and the workaround cannot silently drift. This is a workaround
# for an upstream packaging defect, and the ceiling is that it must be revisited when upstream
# republishes.
COPY dsh-install/package.json dsh-install/package-lock.json /opt/dsh-install/
RUN cd /opt/dsh-install \
 && npm ci --no-audit --no-fund \
 && npm cache clean --force \
 && rm -rf /root/.npm \
 && ln -sf /opt/dsh-install/node_modules/.bin/dsh /usr/local/bin/dsh

# DSH_HOME is where the launcher looks for settings and profiles, and `dsh plugin add` writes
# the profile beneath it. Declared before anything uses it so the build and the container agree.
ENV DSH_HOME=/root/.dsh

# The session wrapper: one program on PATH that boots the TUI on the committed profile. See its
# own header for why the terminal runs a wrapper rather than a command with arguments.
COPY bin/dsh-session /usr/local/bin/dsh-session
RUN chmod 0755 /usr/local/bin/dsh-session

# The profile, installed the documented way.
#
# `dsh plugin --profile <name> add <bundle>` is how the harness itself populates a profile, and using
# it rather than a hand-written manifest is the difference between a profile that works and one that
# only looks right. What it does that a plain `npm install` does not:
#
#   * it resolves the bundle against the LAUNCHER's tree, so the harness has one copy of itself;
#   * it creates .dsh-module-fallback, which is how the profile reaches the launcher's packages.
#
# A hand-written manifest was tried first and failed with a SessionFormatError. The cause was that
# `@deepseek-harness-tui/dsh-tui` declares the harness packages as PEER dependencies, and npm
# auto-installs peers - so the profile got its own second copy of dsh-agent, dsh-session-format and
# cordis, at versions that disagreed with the launcher's. Two trees, two generations of the same
# codec, and a header that could not be encoded by the codec that received it.
#
# Pinning versions cannot fix that, which is why two rounds of pins changed nothing: the problem was
# never a version, it was a duplicate tree.
COPY dsh-profile/settings.yaml /root/.dsh/settings.yaml

ARG DSH_TUI_BUNDLE=@deepseek-harness-tui/dsh-tui@0.10.1
RUN dsh plugin --profile dsh-tui add "${DSH_TUI_BUNDLE}" \
 && npm cache clean --force \
 && rm -rf /root/.npm

# The patch layer, copied AFTER the profile exists because `dsh plugin add` creates the directory.
# It routes subagent children to a worker model instead of inheriting the parent route, which is a
# cost and quality decision rather than a default - see the file itself.
COPY dsh-profile/cordis.patch.yml /root/.dsh/profiles/dsh-tui/cordis.patch.yml

# Prove at build time that the harness runs and that the profile's bundle is actually present. An
# image that builds and then cannot boot its own harness is the failure this environment has spent
# longest on, and it costs nothing to catch here instead of in a session.
RUN command -v dsh \
 && dsh --version \
 && test -d /root/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
