# The dsh developer workspace: the machine an agent or the operator works in. NOT the agency, and
# the agency must never depend on it - it may disappear without affecting production.
#
# Image size is secondary to awake time, and awake time is NOT set by the image. Containers bill
# memory and disk on the PROVISIONED resources for the instance type, so a thinner image does not
# lower the rate; the idle cost is driven by `sleepAfter` alone (5 minutes, src/worker.ts) plus the
# rule that nothing inside the container may poll, ping or heartbeat to stay awake. See docs/COST.md.
#
# But image size is not nothing: Cloudflare refuses an image over the 2000 MB that comes with `lite`,
# and it counts the image differently from Docker (1572 MB by `docker image inspect` was reported as
# 2250 MB - a ratio of ~1.43). This file therefore keeps only the TOOLCHAIN. Node dependency trees
# are agent state and are installed on first run into the durable state mount, by
# `bin/dsh-provision.sh`, which is the one thing here that makes the image do that.
#
# The base image is the official Cloudflare Sandbox runtime for the stable SDK. It already contains
# the container runtime server that answers port verification, exec and lifecycle, plus Node, so
# nothing is copied out of it, no entrypoint is overridden, and no sshd is installed. This file adds
# the workspace toolchain and stops there.
#
# Disk is EPHEMERAL: /workspace is gone at the next wake. git is the source of truth for work, and
# /mnt/state is the durable R2 binding mount. No credential is ever baked in here; live secrets come
# from Worker secrets at runtime.
FROM docker.io/cloudflare/sandbox:0.12.9

ENV DEBIAN_FRONTEND=noninteractive

# The workspace toolchain, in one layer.
#
# `apt-get clean` plus the explicit `rm` of the archive directory is not tidiness, it is ~299 MB of
# the image. The base image sets `Binary::apt::APT::Keep-Downloaded-Packages "true"`, so apt keeps
# every downloaded .deb in /var/cache/apt/archives - and removing them in a LATER layer would not
# help at all, because Docker layers are additive and the bytes stay in the layer that fetched them.
# The purge is therefore in the same RUN as the install, and the same rule applies to the gh layer
# below. (A final sweep layer was tried before and measured at 0 B of image.)
#
# What is here and why, because "an interactive shell does not need it" is how a working box gets
# broken:
#   git curl ca-certificates  work: clone, fetch, and TLS for both
#   jq                        bin/dsh-state.sh parses the skill manifest with it; dsh.sh uses it
#   ripgrep less tmux         the interactive editing and window tools
#   make                      Makefile-driven work; native module builds fail anyway without a
#                             compiler, so this is for the shell, not for npm
#   python3 python3-pip python3-venv
#                             scripts, the ontology validator, and Python work in general
#   gnupg                     git commit signing and any package verification done in the shell
# Removed from the previous list: `rclone`, 40 MB. It was kept for a state sync that the R2 binding
# mount replaced; nothing in this repository, the image or the Worker references it any more.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl jq ripgrep less tmux make \
      python3 python3-pip python3-venv \
      ca-certificates gnupg \
 && apt-get clean \
 && rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/*

# GitHub CLI. The base is Ubuntu 22.04, which has no `gh` package, so this is the documented
# official repository rather than a guess. Same-layer purge as above: `gh` pulls libicu70 and the
# archives for both are otherwise 40% of this layer.
# ponytail: not verified by a build - there is no Docker on the machine this was written on, so the
# image was never built locally. The ceiling is the availability of the cli.github.com apt repo;
# the upgrade path is the release tarball if this layer ever fails.
RUN mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get clean \
 && rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/*

# `mise` is deliberately absent. It was 135 MB of a single binary whose committed `mise.toml` has an
# EMPTY `[tools]` list, so it installed nothing and only its shims were on PATH. A toolchain
# manager with no declared tools is 135 MB of nothing; see README.md, "Why there is no mise".
# The `[tasks]` in mise.toml are still used - by a developer on their own machine, where mise is
# already installed - and that is why the file stays in the repository.
#
# corepack, made reachable on PATH, and this is a correctness fix rather than housekeeping.
#
# Node ships corepack, but this base image symlinks only `npm` and `npx` into /usr/local/bin, so
# `corepack` was NOT on PATH. The previous version of this file tested for corepack and silently
# fell through to `npm install --omit=dev --no-package-lock` for every profile: `pnpm-lock.yaml` was
# ignored entirely, the install was not reproducible, and the comment claiming `--frozen-lockfile`
# was false. The install now happens at run time (see bin/dsh-provision.sh), which resolves corepack
# for itself as well, so this layer exists to make the intended path the available one.
# ponytail: not verified by a build - no Docker here. The ceiling is where this base image puts
# Node's global modules; the upgrade path is `npm install --global corepack` (attempted below) and
# the runtime resolver in bin/dsh-provision.sh, which finds corepack through `npm root -g` and
# labels an npm install as lockfile-less if it genuinely cannot.
RUN set -eux; \
    if ! command -v corepack >/dev/null 2>&1; then \
      global_root="$(npm root -g)"; \
      corepack_js="$global_root/corepack/dist/corepack.js"; \
      if [ -f "$corepack_js" ]; then \
        printf '#!/bin/sh\nexec node %s "$@"\n' "$corepack_js" > /usr/local/bin/corepack; \
        chmod 0755 /usr/local/bin/corepack; \
      else \
        npm install --global corepack; \
      fi; \
    fi; \
    command -v corepack; \
    corepack --version; \
    corepack enable >/dev/null 2>&1 || corepack enable --install-directory /usr/local/bin >/dev/null 2>&1 || true

RUN mkdir -p /workspace
WORKDIR /workspace

# ==================================================================================================
# BEGIN AGENT WORKSPACE CONFIGURATION (vendored from .dsh/ and .agents/, installed declaratively)
# ==================================================================================================
#
# WHY THESE FILES ARE COMMITTED AND BAKED IN, WHEN CREDENTIALS MUST NEVER BE
#
# The disk is ephemeral: a sleeping container wakes with a fresh disk. Anything an agent needs on
# landing must therefore be IN THE IMAGE, or it is lost on every wake. These paths hold INSTRUCTIONS
# AND CONFIGURATION - the AGENTS.md router, the rules, the skill catalog, model routing, and the
# naming registry. They are not secrets. They are committed to this repository on purpose so the
# environment is reproducible, reviewable and identical for every session, and so a fresh container
# needs no manual setup.
#
# LIVE CREDENTIALS ARE THE OPPOSITE and must NEVER be baked in. .dsh/settings.yaml names the gateway
# key by ENVIRONMENT VARIABLE (apiKeyEnv: CHEAPINFERENCE_COM_API_KEY) and holds no value; the value
# is injected at run time from Worker secrets. tools/sync.sh refuses to finish if it finds a
# credential-shaped string in the vendored tree, and .dsh/ontology/check-drift.sh proves the tree
# still matches its pins.
#
# WHAT IS *NOT* HERE, AND THAT IS THE POINT. The instruction files travel because they are small and
# are read before any network is available. The NODE DEPENDENCY TREES do not: the harness CLI
# (~290 MB) and the TUI profile (~108 MB) are installed on first run into the durable state mount by
# bin/dsh-provision.sh, from the lockfiles the repository already commits. They are agent state, not
# toolchain, and they are the two largest things that used to be here.
#
# ONE SKILL CATALOG, IN THE CONVENTIONAL LOCATION. Skills are discovered by the harness from
# `.agents/skills/`, so the whole catalog - including the Plane skill - is installed there and
# nowhere else. There is no per-agent skill directory in this environment.
#
# HOME. Everything below is expressed as /root, and the base image runs as root. ENV HOME=/root makes
# that assumption explicit rather than inherited, so `~` in a vendored instruction resolves where
# these COPYs actually put things.
ENV HOME=/root

# The instruction and configuration files, plus the rules directory, in one layer. The rules are
# copied as a directory, so this lands at /root/.dsh/rules/ exactly as the AGENTS.md router links it.
COPY .dsh/AGENTS.md .dsh/MODEL-ROLES.md .dsh/settings.yaml .dsh/rules/ /root/.dsh/

# The few skills that exist only here, installed into the discovery path the harness already
# searches. The rest of the catalog is NOT vendored into the image: it is declared in `apm.yml` and
# deployed under `.agents/skills/`, so the image carries no third-party copies and skills stay
# current without a rebuild. These are the local-only ones, which have nowhere to be fetched from
# and so must ride in the image.
#
# NOTE FOR WHOEVER LANDS THE APM MIGRATION. That work moved these files from `.agents/local/` to
# `.apm/local/`, and `.agents/local/` is EMPTY in the working tree. The image installs them from the
# new location, which is what makes this COPY resolve today. APM's own `deploy` puts them at
# `.agents/skills/`; this COPY is what the CONTAINER needs, and it is the same three skills either
# way. Whoever finishes the migration should reconcile the two rather than leave both paths
# load-bearing.
COPY .apm/local/ /root/.agents/skills/

# The naming registry: a derived, READ-ONLY copy of the canonical registry in the capability repo,
# pinned by PIN.json - and, in apm.yml, by the commit SHA of the two files it takes from it. Copied
# as the artefacts only - registry.json, validate.py, PIN.json and its README - because the two
# scripts that live beside them in the repository (sync.sh and check-drift.sh) are REPO-SIDE
# TOOLING: sync.sh copies from the operator's laptop, which does not exist here, and check-drift.sh
# verifies the catalog's repository layout. validate.py resolves registry.json next to itself, so
# `python3 /root/.dsh/ontology/validate.py list` works as installed. python3 is already in the image
# from the apt layer above; nothing is added for this.
COPY .dsh/ontology/registry.json .dsh/ontology/validate.py .dsh/ontology/PIN.json .dsh/ontology/README.md /root/.dsh/ontology/

# DSH_HOME is the parent of profiles/, and profiles/ is now a symlink into the state mount rather
# than a directory in this image (see README.md, "First run"). It must still agree with where the
# instruction files land: a profile at the right path with DSH_HOME unset is still a TUI that does
# not start. It is set as ENV so a login shell and every process dsh spawns see it.
ENV DSH_HOME=/root/.dsh

# ==================================================================================================
# The first-run provisioner.
#
# `dsh-provision` is in the IMAGE and not in the clone on purpose: it has to run BEFORE the clone
# exists, because it installs the trees the clone's committed lockfiles describe, INTO the state
# mount the clone lives in. `dsh-state` cannot be in the image for the same reason - it lives in the
# clone, reads the clone's manifests, and is invoked by the Worker after the provisioner.
#
# Both are invoked by the Worker (src/worker.ts), in order, once per wake where the mount is freshly
# created. Nothing here starts them, nothing polls, and nothing runs in the background: they are two
# foreground commands with a beginning and an end, which is what docs/COST.md requires.
# ==================================================================================================
COPY bin/dsh-provision.sh bin/dsh-state.sh /usr/local/libexec/
RUN chmod 0755 /usr/local/libexec/dsh-provision.sh /usr/local/libexec/dsh-state.sh \
 && ln -sf /usr/local/libexec/dsh-provision.sh /usr/local/bin/dsh-provision \
 && ln -sf /usr/local/libexec/dsh-state.sh /usr/local/bin/dsh-state

# There is deliberately NO final "reclaim the build's weight" layer any more. There is nothing left
# to reclaim: no npm, pnpm, pip or mise cache is created during the build, because no dependency tree
# is installed during the build. The two apt layers purge their archives in their own RUN, which is
# where it counts. A later cleanup layer was measured at 0 B of image and changed only the runtime
# filesystem, which is why it is gone rather than kept for the look of it. Runtime hygiene for the
# first-run install lives in `reclaim()` in bin/dsh-provision.sh, and its comment says the same.

# Documentation only: the platform reads the port from the Durable Object, not from this line.
EXPOSE 8080