#!/bin/sh
# First-run provisioning: install the node dependency trees into the durable state mount, once.
#
# WHY THIS IS A SEPARATE SCRIPT AND NOT PART OF bin/dsh-state.sh
#
# `dsh-state.sh` is how the operator (and the Worker) populates the harness home and the skill
# catalog, and it runs at container start. This script is the part of that work that the WORKER runs
# *before it mounts*, because the mount is what supplies the files this installs FROM:
#
#   * the committed install manifests (`dsh-install/package.json`, `dsh-install/package-lock.json`,
#     `.dsh/profiles/*/pnpm-lock.yaml`) live in the state-mount clone, and
#   * the resulting `node_modules` trees are written INTO the state mount.
#
# So this script cannot live behind `dsh-state.sh`, which itself lives in the clone: while the mount
# is not up, reading that script is exactly the read this script is trying to avoid. It ships in the
# image instead, and it is re-invoked on every wake against the durable marker.
#
# WHY THE IMAGE IS THE TOOLCHAIN AND THE WORKSPACE IS THE STATE
#
# ~400 MB of node modules used to be baked into the image. They are not toolchain, they are AGENT
# STATE: the harness CLI and the TUI profile are installed from committed lockfiles, so they are
# derived data that can be regenerated at any time, and they belong in the durable store that
# already exists rather than in an image Cloudflare refuses to deploy (2189 MB against a 2000 MB
# limit). The image keeps `gh`, `git`, `node`, `npm` and `corepack` - the things that DO the
# installing - and nothing else.
#
# WHAT IT COSTS, AND WHEN
#
# The install is paid ONCE, on the first wake, and never again: the marker (`$MARKER`) is written
# into the state mount, which survives a wake. A warm store is a handful of `test -x` calls and no
# network at all. If a wake finds the marker present but a binary missing (a mount that came back
# empty, a half-finished install), it re-installs and says so, because the marker is an accelerator
# and the binaries are the truth.
#
# IT DEGRADES HONESTLY
#
# If the registry is unreachable, this script prints what failed and the exact retry command, and
# exits NON-ZERO. The Worker ignores that code, because a container that refuses to start because
# npm was down is far worse than a container without the TUI: the terminal opens, the failure is on
# screen, and `dsh-provision` (or `dsh-state refresh`) retries it later. Nothing here polls, and
# nothing here runs in the background: it is one foreground command with a beginning and an end. See
# docs/COST.md - a loop here would convert "cost while I work" into "cost while I live".
#
# IT NEVER TOUCHES A PATH THAT IS NOT DURABLE. Every write below is inside the state mount. The
# registry and package caches are the only local-disk writes, and they are the only ones it has to
# clean up, which it does on the way out so the container's ephemeral 2 GB is not left holding a
# copy of what it just installed.
set -eu

# The mount, and the clone inside it. Mirrors the defaults in bin/dsh-state.sh; the Worker never
# overrides them, so these are the deployed values.
STATE_MOUNT=${DSH_STATE_MOUNT:-/mnt/state}
REPO_DIR=$STATE_MOUNT/repo

# The committed manifests, and where their trees land. Defining each once is the whole point of this
# block: nothing below spells a path inline.
DSH_INSTALL_DIR=$REPO_DIR/dsh-install
DSH_LOCKFILE=package-lock.json
DSH_MANIFEST=package.json
DSH_BIN=node_modules/.bin/dsh
PROFILES_DIR=$REPO_DIR/.dsh/profiles
PROFILE_MANIFEST=package.json
PROFILE_LOCKFILE=pnpm-lock.yaml
PROFILE_MODULES=node_modules

# The one marker. In the mount, so a wake finds it; named for the whole install rather than for each
# tree, because a partial install is not a warm store and its absence is what triggers the repair.
MARKER=$STATE_MOUNT/.provisioned

# Tools that do the installing. `npm` comes with the base image's Node. `corepack` also ships with
# Node but this base image symlinks only `npm` and `npx` into /usr/local/bin, so a bare
# `command -v corepack` failed and the previous image build silently fell back to npm for every
# profile - `pnpm-lock.yaml` was ignored and the install was not reproducible. corepack is therefore
# resolved through `npm root -g` as well as through PATH, below.
NPM_BIN=npm
COREPACK_BIN=corepack
PNPM_BIN=pnpm
PNPM_VERSION=10.4.0

# Where npm and corepack leave caches while they work. Local disk, removed below: the state mount is
# an s3fs FUSE mount and a package cache written through it would be slow and pointless.
NPM_CACHE=$HOME/.npm
COREPACK_CACHE=$HOME/.cache/node/corepack
COREPACK_HOME=$HOME/.cache/node/corepack

# The retry command, quoted in every failure message so the operator never has to guess it.
RETRY="dsh-provision"

say() { echo "[dsh-provision] $*" >&2; }
warn() { echo "[dsh-provision] $*" >&2; }

# --------------------------------------------------------------------------------------------------
# The marker, and why it is only an accelerator.
# --------------------------------------------------------------------------------------------------
# The install is complete when the artifacts are present, not when a marker file says so. A marker
# is how the common case avoids seven round trips to R2; the artifacts are how a store that lost
# them - a mount that came back empty, a partial install - is repaired instead of trusted.
installed() {
    [ -x "$DSH_INSTALL_DIR/$DSH_BIN" ] || return 1
    for profile in "$PROFILES_DIR"/*/; do
        [ -f "$profile$PROFILE_MANIFEST" ] || continue
        [ -d "$profile$PROFILE_MODULES" ] || return 1
    done
    return 0
}

# --------------------------------------------------------------------------------------------------
# The harness CLI: one tree from one committed lockfile.
# --------------------------------------------------------------------------------------------------
install_dsh() {
    if [ ! -f "$DSH_INSTALL_DIR/$DSH_LOCKFILE" ]; then
        warn "no $DSH_INSTALL_DIR/$DSH_LOCKFILE: the state-mount clone is missing or incomplete."
        warn "the harness CLI cannot be installed from anything else by design."
        warn "retry with:  dsh-state refresh"
        return 1
    fi

    say "installing the harness CLI into $DSH_INSTALL_DIR (one time; committed lockfile)"
    # `npm ci` and not `npm install`: the tree is exactly what the lockfile pins, which matters here
    # more than anywhere - the manifest carries an `overrides` pin that works around a transitive
    # @deepseek-ai/dsh-client-ui-sidebar-documentpreview version that was never published, and a
    # floating install would fail with ETARGET no matter which dsh version it asked for.
    if ! (cd "$DSH_INSTALL_DIR" && "$NPM_BIN" ci --no-audit --no-fund); then
        warn "npm ci failed for $DSH_INSTALL_DIR (registry unreachable, or the lockfile did not resolve)."
        warn "the environment is otherwise usable; only the harness CLI is missing."
        warn "retry with:  $RETRY"
        return 1
    fi
    return 0
}

# --------------------------------------------------------------------------------------------------
# The dsh profiles: what makes the terminal a TUI rather than a bare CLI.
# --------------------------------------------------------------------------------------------------
# pnpm from the committed lockfile is the plan, because that is what the lockfile was written by, and
# `--frozen-lockfile` means a lockfile that no longer resolves FAILS rather than quietly installing
# something else. corepack_invocation below is the resolution that makes that path reachable at all.
#
# npm is the fallback when pnpm genuinely cannot run: a weaker install - a hoisted tree from the same
# manifest, with `pnpm-lock.yaml` NOT honoured - and every message says so. The fallback exists so
# that a registry or corepack outage costs a weaker TUI rather than a terminal with no TUI at all.
# The README states the same, because a comment claiming reproducibility while taking the fallback is
# exactly the defect this replaced.

# Resolve corepack to something runnable, printing a command (which may be two words) or nothing.
# PATH first, then the copy Node ships, found through npm rather than by guessing the prefix. The
# image does the same thing at build time; this is the second net, so a base-image change that moves
# corepack cannot silently downgrade the install to a lockfile-less one again.
corepack_invocation() {
    if command -v "$COREPACK_BIN" >/dev/null 2>&1; then
        printf '%s' "$COREPACK_BIN"
        return 0
    fi
    global_root=$("$NPM_BIN" root -g 2>/dev/null || true)
    if [ -n "$global_root" ] && [ -x "$global_root/corepack/dist/corepack.js" ]; then
        printf 'node %s' "$global_root/corepack/dist/corepack.js"
        return 0
    fi
    return 1
}

install_one_profile() {
    profile=$1
    say "installing profile dependencies in $profile from its frozen lockfile"
    # shellcheck disable=SC2086 # deliberate: COREPACK may be "node /path/corepack.js", two words.
    # `pnpm@<version> install` is corepack's documented one-shot form, and it does not need
    # `corepack prepare` first: corepack fetches and activates that pnpm for the command.
    if [ -n "$COREPACK" ] \
       && (cd "$profile" && $COREPACK "$PNPM_BIN@$PNPM_VERSION" install --prod --frozen-lockfile); then
        say "pnpm installed $profile from $PROFILE_LOCKFILE (frozen)"
        return 0
    fi
    warn "pnpm could not run, or the frozen lockfile did not resolve; falling back to npm for $profile"
    warn "the fallback installs from $PROFILE_MANIFEST and does NOT honour $PROFILE_LOCKFILE"
    (cd "$profile" && "$NPM_BIN" install --omit=dev --no-audit --no-fund --no-package-lock)
}

install_profiles() {
    COREPACK=$(corepack_invocation || true)
    if [ -z "$COREPACK" ]; then
        warn "corepack is not on PATH and not under \`npm root -g\`; the profile install will be from"
        warn "the manifests with npm, and $PROFILE_LOCKFILE will not be honoured"
    fi
    found=0
    for profile in "$PROFILES_DIR"/*/; do
        [ -f "$profile$PROFILE_MANIFEST" ] || continue
        found=1
        if [ -f "$profile$PROFILE_LOCKFILE" ]; then
            install_one_profile "$profile" || {
                warn "profile install failed for $profile (registry unreachable, or the lockfile did not resolve)."
                warn "retry with:  $RETRY"
                return 1
            }
        else
            say "no $PROFILE_LOCKFILE in $profile; installing from the manifest with npm"
            (cd "$profile" && "$NPM_BIN" install --omit=dev --no-audit --no-fund --no-package-lock) || {
                warn "profile install failed for $profile."
                warn "retry with:  $RETRY"
                return 1
            }
        fi
    done
    if [ "$found" -eq 0 ]; then
        warn "no profile manifests under $PROFILES_DIR; the environment starts without a TUI"
        return 1
    fi
    return 0
}

# --------------------------------------------------------------------------------------------------
# Reclaim the install's own weight from local disk. Not an image concern: node_modules is in the
# state mount, and this only removes what npm and corepack left on the container's ephemeral disk.
# --------------------------------------------------------------------------------------------------
reclaim() {
    "$NPM_BIN" cache clean --force >/dev/null 2>&1 || true
    rm -rf "$NPM_CACHE" "$COREPACK_CACHE" "$COREPACK_HOME" 2>/dev/null || true
    return 0
}

# --------------------------------------------------------------------------------------------------
# Entry point.
# --------------------------------------------------------------------------------------------------
run() {
    # The mount must be there before anything here is meaningful, and a missing one is reported as
    # an ordering failure rather than papered over. The Worker mounts it first, on every request
    # path, so a missing mount means the caller is not the Worker - say so and stop.
    if [ ! -d "$STATE_MOUNT" ]; then
        warn "$STATE_MOUNT is absent, so the state mount is not ready."
        warn "this script installs INTO that mount and refuses to run before it exists."
        warn "retry with:  $RETRY"
        return 1
    fi

    for tool in "$NPM_BIN" node; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            warn "$tool is missing from the image, so nothing can be installed."
            return 1
        fi
    done

    if installed; then
        if [ -f "$MARKER" ]; then
            # The warm path, and the whole reason warm starts are cheap: no network, no install.
            say "already installed (marker: $MARKER); nothing to do"
            return 0
        fi
        say "the install is present without a marker; recording it"
        : >"$MARKER"
        return 0
    fi

    say "first run: installing the harness CLI and the TUI profile into $STATE_MOUNT"
    say "this is a one-time cost; it is cached in the mount and skipped on every later wake"
    say "the image carries the toolchain (node, npm, corepack); only the dependency trees move here"

    status=0
    install_dsh || status=1
    install_profiles || status=1
    reclaim

    if [ "$status" -ne 0 ] || ! installed; then
        warn "the dependency trees are still incomplete; the environment is usable and the TUI may not start."
        warn "retry with:  $RETRY"
        return 1
    fi

    : >"$MARKER"
    say "installed; the next wake finds $MARKER and does nothing"
    return 0
}

run