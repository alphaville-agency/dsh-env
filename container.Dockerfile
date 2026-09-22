# The dsh developer workspace: the machine an agent or the operator works in. NOT the agency, and
# the agency must never depend on it - it may disappear without affecting production.
#
# Image size is secondary to awake time, and awake time is NOT set by the image. Containers bill
# memory and disk on the PROVISIONED resources for the instance type, so a thinner image does not
# lower the rate; the idle cost is driven by `sleepAfter` alone (5 minutes, src/worker.ts) plus the
# rule that nothing inside the container may poll, ping or heartbeat to stay awake. See docs/COST.md.
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

# The workspace toolchain, in one layer with the package lists dropped again so the image stays
# thin without chasing bytes at the cost of a usable environment.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl jq ripgrep less tmux rclone make \
      python3 python3-pip python3-venv \
      ca-certificates gnupg \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI. The base is Ubuntu 22.04, which has no `gh` package, so this is the documented
# official repository rather than a guess.
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
 && rm -rf /var/lib/apt/lists/*

# mise, because the toolchain that moves fast is declared in the committed mise.toml below rather
# than hand-installed into a disk that vanishes at the next wake.
RUN curl -fsSL https://mise.run | sh
ENV PATH="/root/.local/bin:/root/.local/share/mise/shims:${PATH}"

# The harness CLI, so the terminal can land straight in the dsh TUI.
#
# Installed from a committed manifest and lockfile rather than `npm install -g
# @deepseek-ai/dsh`. That form is not merely unpinned, it is currently BROKEN: the latest dsh
# resolves a transitive @deepseek-ai/dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3, and rc.3
# was never published, so a fresh install fails with ETARGET no matter which dsh version you ask
# for. An override pins that one dependency back to the latest version that does exist.
#
# This is a workaround for an upstream packaging defect, not a preference. The ceiling is that
# dsh-install/package.json must be revisited when upstream republishes; the upgrade path is to
# drop the override, regenerate the lockfile and rebuild. `npm ci` means the tree is identical
# for every build and the override cannot silently drift.
COPY dsh-install/package.json dsh-install/package-lock.json /opt/dsh-install/
RUN cd /opt/dsh-install \
 && npm ci --no-audit --no-fund \
 && ln -sf /opt/dsh-install/node_modules/.bin/dsh /usr/local/bin/dsh

RUN mkdir -p /workspace
WORKDIR /workspace

# The declared toolchain, baked in from a committed file so every session is identical. A declared
# tool that does not install is a broken image, so this fails the build instead of `|| true`-ing
# past it.
COPY mise.toml /workspace/mise.toml
RUN mise trust mise.toml && mise install

# ==================================================================================================
# BEGIN AGENT WORKSPACE CONFIGURATION (vendored from agent/, installed declaratively)
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
# LIVE CREDENTIALS ARE THE OPPOSITE and must NEVER be baked in. agent/settings.yaml names the gateway
# key by ENVIRONMENT VARIABLE (apiKeyEnv: CHEAPINFERENCE_COM_API_KEY) and holds no value; the value
# is injected at run time from Worker secrets. agent/sync.sh refuses to finish if it finds a
# credential-shaped string in the vendored tree, and agent/ontology/check-drift.sh proves the tree
# still matches its pins.
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
COPY agent/AGENTS.md agent/MODEL-ROLES.md agent/settings.yaml agent/rules/ /root/.dsh/

# The skill catalog, installed where the harness looks for skills and nowhere else. 25 skills,
# including plane, vendored verbatim and pinned by agent/skills-lock.json.
COPY agent/skills/ /root/.agents/skills/

# The naming registry: a derived, READ-ONLY copy of the canonical registry in the capability repo,
# pinned by PIN.json. Copied as the artefacts only - registry.json, validate.py, PIN.json and its
# README - because the two scripts that live beside them in the repository (sync.sh and
# check-drift.sh) are REPO-SIDE TOOLING: sync.sh copies from the operator's laptop, which does not
# exist here, and check-drift.sh verifies the catalog's repository layout. validate.py resolves
# registry.json next to itself, so `python3 /root/.dsh/ontology/validate.py list` works as installed.
# python3 is already in the image from the apt layer above; nothing is added for this.
COPY agent/ontology/registry.json agent/ontology/validate.py agent/ontology/PIN.json agent/ontology/README.md /root/.dsh/ontology/

# The dsh profiles, which are what make `dsh` a TUI rather than a bare CLI. DSH_HOME is the parent of
# profiles/, so it must agree with where this COPYs to and with where the instruction files above
# land: a profile at the right path with DSH_HOME unset is still a TUI that does not start. It is set
# as ENV so a login shell and every process dsh spawns see it.
ENV DSH_HOME=/root/.dsh

# Only the declarative profile files are committed - package.json, pnpm-lock.yaml, pnpm-workspace
# and the cordis layers. Installed dependencies are NOT in the repository and NOT in the build
# context: they are regenerated here from the lockfile, which is what a lockfile is for.
COPY agent/profiles/ /root/.dsh/profiles/

# The install, declarative and reproducible: corepack supplies pnpm at the version the lockfile was
# written by (lockfileVersion 9.0 needs pnpm 9 or newer; 10.4.0 satisfies it and the lockfile declares
# no packageManager field to pin), rather than a bespoke global install with its own version drift.
# --frozen-lockfile so a lockfile that no longer resolves FAILS the build instead of quietly
# installing something else. npm is the fallback when corepack or the registry is unreachable, which
# is a weaker install (a hoisted node_modules from the same manifests) and is named as such.
# ponytail: not verified by a build - there is no Docker on the machine this was written on. The
# ceiling is reachability of the npm registry and of corepack's pnpm; the upgrade path, if corepack
# ever fails here, is a committed pnpm tarball. The fallback exists so this cannot be a hard failure.
RUN set -eux; \
    for profile in /root/.dsh/profiles/*/; do \
      [ -f "$profile/package.json" ] || continue; \
      if command -v corepack >/dev/null 2>&1 \
         && corepack enable >/dev/null 2>&1 \
         && corepack prepare pnpm@10.4.0 --activate >/dev/null 2>&1 \
         && (cd "$profile" && pnpm install --frozen-lockfile); then \
        echo "pnpm installed $profile from its frozen lockfile"; \
      else \
        echo "pnpm unavailable or the lockfile did not resolve; falling back to npm for $profile"; \
        (cd "$profile" && npm install --no-audit --no-fund --no-package-lock); \
      fi; \
    done
# ==================================================================================================
# END AGENT WORKSPACE CONFIGURATION
# ==================================================================================================

# Documentation only: the platform reads the port from the Durable Object, not from this line.
EXPOSE 8080