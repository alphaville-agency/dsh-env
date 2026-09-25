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
# THE WORKSPACE TOOLCHAIN, NOT A SHELLED-OUT ONE. The comment above says these "come back with the
# layer that can be verified to use it" - and that layer is here: the capability repository declares
# `requires-python = ">=3.12"` and its own toolchain (names/validate.py, the test suite) is python,
# so the agency cannot run its own repo without it. The rest are the shell the work happens in:
# tmux and less for sessions, ripgrep for search, make for builds, gnupg for signed commits.
#
# All in ONE RUN with the clean, because the base image keeps every .deb in /var/cache/apt/archives
# and Docker layers are additive - removing them in a later layer would not reclaim those bytes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl jq ca-certificates \
      tmux ripgrep less make python3 gnupg \
 && apt-get clean \
 && rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/*

# Every one of them must be present when the image is built. A package nobody exercises is a package
# nobody has proved is installed - and the brief path above was exactly that failure in reverse:
# python3 was absent, and the missing interpreter failed silently behind `|| true`.
RUN for t in tmux rg less make python3 gpg gh git; do \
        command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t" >&2; exit 1; }; \
    done \
 && python3 --version

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

# pnpm, because that is what the harness uses to manage profiles.
#
# `dsh plugin add` shells out to pnpm and fails with 127 without it, and the reason is not
# incidental: pnpm's default is `autoInstallPeers: false`, and that setting is what makes the
# documented install correct. npm auto-installs peer dependencies, so the profile's bundle - which
# declares the harness packages as PEERS, expecting the launcher to supply them - gets its own
# second copy of dsh-agent, dsh-session-format and cordis. A hand-written npm manifest produced
# exactly that, and the two copies then disagreed about the session header format. The working
# setup on the laptop has the same flag in its pnpm-lock.yaml.
#
# Pinned to the version that setup runs, so the profile resolves identically.
ARG PNPM_VERSION=12.4.0
RUN npm install --global "pnpm@${PNPM_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm

# gh, because this environment exists to work on repositories and cannot reach them without it.
#
# Installed from the official release tarball rather than the cli.github.com apt repository: the apt
# route pulls an entire ICU stack and measured 187 MB, where the static binary is ~40 MB. Both are
# verifiable; one is five times the size for the same command.
#
# It authenticates from GH_TOKEN, which is injected at run time as a Worker secret exactly like the
# model credential - never baked, never in this repository.
ARG GH_VERSION=2.101.0
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/gh.tgz \
 && tar -xzf /tmp/gh.tgz -C /tmp \
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64" \
 && gh --version

# The profile, installed the documented way.
#
# ONE PROFILE, NOT TWO. This machine also has a `web` profile, and it is deliberately not installed
# here: it is a browser UI, which needs a port. Containers have no public port except through a Worker
# route, and this Worker exposes exactly one - the terminal. Adding the web profile would mean
# exposing a second surface to make a local-only affordance work, which is the opposite of what the
# environment is for. `dsh-tui` is the interface, and the access gate is why it can be.
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

# Turn OFF live patch reloading, which is a laptop feature and cannot work here.
#
# `dsh plugin add` writes `patchReload: "live"`, the default for a custom profile, and live reload
# requires the Cordis HMR service. HMR arrives as a DEV dependency, and this image runs with
# NODE_ENV=production, so it is not installed - and the boot fails with
# "user patch-layer watching requires the Cordis HMR service" before the TUI draws.
#
# Installing the dev tree to satisfy it would be the wrong fix: the profile is baked into the image
# and nothing edits its patch layer at run time, so there is nothing to watch. `startup` reload is the
# honest setting - the layer is applied when the profile boots, which is the only moment it can
# change here.
RUN node -e "const f='/root/.dsh/profiles/dsh-tui/package.json';const fs=require('fs');const d=JSON.parse(fs.readFileSync(f,'utf8'));d.dsh.profile.patchReload='startup';fs.writeFileSync(f,JSON.stringify(d,null,2)+'\n')" \
 && node -e "const d=require('/root/.dsh/profiles/dsh-tui/package.json');if(d.dsh.profile.patchReload!=='startup'){throw new Error('patchReload was not set')}"

# The patch layer, copied AFTER the profile exists because `dsh plugin add` creates the directory.
# It routes subagent children to a worker model instead of inheriting the parent route, which is a
# cost and quality decision rather than a default - see the file itself.
COPY dsh-profile/cordis.patch.yml /root/.dsh/profiles/dsh-tui/cordis.patch.yml

# The agent's own configuration, which is what turns a shell with a model into a place that knows how
# this project works.
#
# None of this reached the container before: it sat in the repository, wired to nothing, so a session
# opened into a blank context with no rules and no naming registry. That is the "built and consumed
# by nothing" defect in the one place it costs most, because the agent re-derives a different set of
# conventions every time rather than inheriting the ones this project actually uses.
#
# Installed into $DSH_HOME, which is where the harness reads them, and the rules go in as a DIRECTORY
# so a rule added later travels with no change here.
COPY .dsh/AGENTS.md       /root/.dsh/AGENTS.md
COPY .dsh/MODEL-ROLES.md  /root/.dsh/MODEL-ROLES.md
COPY .dsh/rules/          /root/.dsh/rules/
COPY .dsh/ontology/       /root/.dsh/ontology/

# The skills the router names. Installing these where the harness discovers skills is what makes the
# router's references resolve: an instruction that points at a skill which is not there reads as
# correct and fails silently, which is the defect docs/rules/dangling-references.md exists for.
COPY dsh-skills/          /root/.agents/skills/

# A helper that fetches the repositories this environment works on. See its own header.
COPY bin/dsh-prime        /usr/local/bin/dsh-prime
RUN chmod 0755 /usr/local/bin/dsh-prime

# The identity is the ENTITY's, not the operator's, and that distinction is the point.
#
# The first version of this used the operator's personal GitHub account, because that is what
# `gh auth token` happened to return on this machine. Anything committed from this environment
# would then have been attributed to a person rather than to the agency - which is the line the
# project's own rules draw: signing up AS the entity is authorised, acting as somebody else is
# not.
#
# `alphaville@alphaville.space` is the domain the entity owns; Cloudflare routes it to the agency
# inbox. A mail-provider address is the wrong form to publish in a commit: it exposes the
# backend and is not the entity's identity.

RUN git config --global user.name "Alphaville" \
 && git config --global user.email "alphaville@alphaville.space" \
 && git config --global init.defaultBranch main \
 && git config --global --get user.email

# Prove at build time that what the router points at is present. A dangling reference is cheap to
# catch here and expensive to notice in a session.
RUN test -f /root/.dsh/AGENTS.md \
 && test -d /root/.dsh/rules \
 && test -f /root/.dsh/ontology/registry.json \
 && test -f /root/.agents/skills/plane/SKILL.md \
 && test -f /root/.gitconfig \
 && test -x /usr/local/bin/dsh-prime \
 && test -x /usr/local/bin/gh \
 && test -x /usr/local/bin/dsh-session

# Git identity, so a commit made in here is attributable rather than a failure.
#
# The container had no identity, which means `git commit` either refused or produced an
# unattributed commit - the same class of gap as a missing credential, and just as invisible until
# the moment it matters. The values are the identity this project already commits under.
#
# Non-secret, so they belong in the image rather than in a secret: a name and an address on a commit
# are published by design.

# The identity is the ENTITY's, not the operator's, and that distinction is the point.
#
# The first version of this used the operator's personal GitHub account, because that is what
# `gh auth token` happened to return on this machine. Anything committed from this environment would
# then have been attributed to a person rather than to the agency - which is the line the project's
# own rules draw: signing up AS the entity is authorised, acting as somebody else is not.
#
# `alphaville@alphaville.space` is the domain the entity owns; Cloudflare routes it to the agency
# inbox. A mail-provider address is the wrong form to publish in a commit: it exposes the backend and
# is not the entity's identity.

# Prove at build time that the harness runs and that the profile's bundle is actually present. An
# image that builds and then cannot boot its own harness is the failure this environment has spent
# longest on, and it costs nothing to catch here instead of in a session.
RUN command -v dsh \
 && dsh --version \
 && test -d /root/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
