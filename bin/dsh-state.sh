#!/bin/sh
# Populate or link the agent's workspace state, once, at container start.
#
# WHY THIS EXISTS AT ALL
#
# The image is the TOOLCHAIN. The workspace is the STATE. Nothing agent-specific is baked in, so
# this script is what turns an empty durable store into a working harness home: it clones the
# tooling repository onto the R2 mount at /mnt/state, symlinks the harness home into that clone, and
# installs the skill catalog named by .agents/skills.json.
#
# It is a ONE-SHOT, IDEMPOTENT, TERMINATING step. It is not a daemon, a poll, a timer or a
# background loop, and it must never become one: every design decision here is subordinate to
# docs/COST.md, where awake time is the only cost that matters and a heartbeat is the defect the
# environment was rebuilt to remove. The Worker runs `dsh-state ensure` exactly once per container
# life, when the state mount is freshly created; a warm container never reaches it.
#
#   dsh-state ensure    populate-or-link, doing nothing on a warm store (the Worker's call)
#   dsh-state refresh   force a re-clone and a re-install of the catalog (the operator's call)
#   dsh-state status    print what is present, and where
#
# DEGRADES HONESTLY. If the network, the repository or the skill registry is unreachable, this
# script reports what could not be fetched and how to retry, and exits 0. A shell that starts with
# no skills is a far better outcome than a container that refuses to start at all.
#
# WHY NOTHING IS COPIED INTO THE IMAGE *OR* INTO THE DISCOVERY PATH
#
# The repository checkout IS the harness home: the clone's .dsh/ is the harness home and its
# .agents/ is the skill discovery path, mapped by symlink and by nothing else. That is what lets an
# agent edit its own rules, instructions or skills inside the container and have the edit persist
# across a wake - a copy would drift from the repository the moment either side changed, and a
# rebuild would be needed to move a one-line rule change. See README.md ("Repo to container").
set -eu

# --------------------------------------------------------------------------------------------------
# Every path and name, defined once. Nothing below spells a path inline.
# --------------------------------------------------------------------------------------------------
STATE_MOUNT=${DSH_STATE_MOUNT:-/mnt/state}
REPO_SLUG=${DSH_REPO:-alphaville-agency/tooling}
REPO_REF=${DSH_REF:-main}
REPO_DIR=$STATE_MOUNT/repo

# The clone's two state roots, named here exactly as they are named at their destination.
CLONE_DSH=$REPO_DIR/.dsh
CLONE_AGENTS=$REPO_DIR/.agents

HARNESS_HOME=${DSH_HOME:-$HOME/.dsh}
AGENTS_HOME=$HOME/.agents

SKILLS_MANIFEST=$CLONE_AGENTS/skills.json
SKILLS_DIR=$AGENTS_HOME/skills
SKILLS_MARKER=$AGENTS_HOME/.skills-installed
SKILL_FILE=SKILL.md

# The harness's own profile bundles need their node_modules on LOCAL disk, so profiles/ is the one
# entry of the clone's .dsh/ that is not symlinked: it is baked into the image at this path.
# An s3fs (R2 egress) mount answers every read with a network round trip, and a Node require() tree
# over it is unusable. Everything else travels by symlink.
PROFILES_DIR_NAME=profiles

# Credentials are read from the environment at run time by the Worker and are never stored on the
# mount: the token is used for one clone and the checkout's remote is reset immediately afterwards.
GIT_TOKEN=${GH_TOKEN:-${GITHUB_TOKEN:-}}
GIT_TOKEN_VAR=GH_TOKEN
GIT_HOST=github.com

# Tools this script drives. The Skills CLI is installed globally in the image so that a cold start
# does not re-download it through npx; npx is the named fallback, not the plan.
SKILLS_BIN=skills
GIT_BIN=git
GH_BIN=gh
JQ_BIN=jq
NPM_BIN=npx

say() { echo "[dsh-state] $*" >&2; }
warn() { echo "[dsh-state] $*" >&2; }

# --------------------------------------------------------------------------------------------------
# The clone. Fetched once; a warm store is never re-fetched, because a network round trip on the
# critical path of the operator connecting is exactly the cost this design exists to avoid.
# --------------------------------------------------------------------------------------------------
clone_repo() {
    clean_url="https://$GIT_HOST/$REPO_SLUG.git"
    if [ -n "$GIT_TOKEN" ]; then
        clone_url="https://x-access-token:$GIT_TOKEN@$GIT_HOST/$REPO_SLUG.git"
    else
        clone_url=$clean_url
        warn "no $GIT_TOKEN_VAR in the environment; cloning $REPO_SLUG anonymously"
        warn "(that only works while the repository is public; see README.md on Secrets Store)"
    fi

    say "cloning $REPO_SLUG@$REPO_REF into $REPO_DIR"
    mkdir -p "$STATE_MOUNT"
    if ! "$GIT_BIN" clone --depth 1 --branch "$REPO_REF" "$clone_url" "$REPO_DIR" >/dev/null 2>&1; then
        rm -rf "$REPO_DIR"
        return 1
    fi

    # The token was in the clone URL; it must not remain in the checkout. Resetting the remote keeps
    # nothing credential-shaped on the durable mount.
    "$GIT_BIN" -C "$REPO_DIR" remote set-url origin "$clean_url" >/dev/null 2>&1 || true

    # Push-back: `gh auth setup-git` installs a credential helper that reads $GIT_TOKEN_VAR from the
    # environment at push time, so a token never touches disk. Best-effort - if gh is absent or not
    # authenticated the clone still stands and push-back is simply unavailable.
    if [ -n "$GIT_TOKEN" ] && command -v "$GH_BIN" >/dev/null 2>&1; then
        "$GH_BIN" auth setup-git >/dev/null 2>&1 \
            || warn "gh auth setup-git failed; push-back from the container is unavailable"
    fi
    return 0
}

ensure_repo() {
    # A complete clone is its own marker: both state roots must be present, so an interrupted clone
    # is not mistaken for a warm store.
    if [ -d "$CLONE_DSH" ] && [ -d "$CLONE_AGENTS" ]; then
        return 0
    fi
    rm -rf "$REPO_DIR"
    clone_repo
}

# --------------------------------------------------------------------------------------------------
# The harness home. Every entry of the clone's .dsh/ is symlinked into the harness home under the
# same name, except profiles/, which the image supplies. No list of files is written down here: a
# rule or instruction file added to the repository later travels with no change to this script.
# --------------------------------------------------------------------------------------------------
link_harness_home() {
    case "$HARNESS_HOME" in
        /*) : ;;
        *) warn "refusing to link: the harness home must be an absolute path (got '$HARNESS_HOME')"; return 1 ;;
    esac
    mkdir -p "$HARNESS_HOME"
    for entry in "$CLONE_DSH"/*; do
        [ -e "$entry" ] || continue
        name=$(basename "$entry")
        [ "$name" = "$PROFILES_DIR_NAME" ] && continue
        target=$HARNESS_HOME/$name
        # Replace whatever is there. Removing a symlink unlinks the link, never the clone; a real
        # file or directory from an older image is superseded, because the clone is the source.
        rm -rf "$target"
        ln -s "$entry" "$target"
    done
    say "linked $HARNESS_HOME to the clone ($CLONE_DSH)"
    return 0
}

# --------------------------------------------------------------------------------------------------
# The skill catalog, from the manifest. Installed into the discovery path with the Skills CLI, which
# is the standard means - this script never copies skill content itself.
# --------------------------------------------------------------------------------------------------
skills_cli() {
    if command -v "$SKILLS_BIN" >/dev/null 2>&1; then
        "$SKILLS_BIN" "$@"
        return $?
    fi
    say "the skills CLI is not on PATH; falling back to npx (slower, and it re-fetches itself)"
    "$NPM_BIN" --yes "$SKILLS_BIN" "$@"
}

# The names the manifest declares but the discovery path does not have. Computed by observation, so
# an install that silently did nothing is still reported as missing.
manifest_missing_names() {
    missing=
    [ -f "$SKILLS_MANIFEST" ] || { printf ''; return 0; }
    names=$("$JQ_BIN" -r ".skills[].name" "$SKILLS_MANIFEST" 2>/dev/null || true)
    for name in $names; do
        [ -f "$SKILLS_DIR/$name/$SKILL_FILE" ] || missing="$missing $name"
    done
    printf '%s' "$missing"
}

install_skills() {
    if [ -f "$SKILLS_MARKER" ]; then
        return 0
    fi
    for tool in "$JQ_BIN" "$GIT_BIN"; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            warn "$tool is missing, so the catalog cannot be installed; the environment starts without skills"
            return 0
        fi
    done
    if [ ! -f "$SKILLS_MANIFEST" ]; then
        warn "no skills manifest at $SKILLS_MANIFEST; the environment starts without skills"
        return 0
    fi

    mkdir -p "$SKILLS_DIR"
    cd "$REPO_DIR" || { warn "cannot enter $REPO_DIR"; return 0; }

    # A tab-separated stream keeps this POSIX: no arrays, no readarray, no process substitution.
    entries=$("$JQ_BIN" -r '.skills[] | "\(.name)\t\(.source)"' "$SKILLS_MANIFEST" 2>/dev/null || true)
    if [ -z "$entries" ]; then
        warn "$SKILLS_MANIFEST lists no skills; the environment starts without skills"
        return 0
    fi

    # One skill per invocation, skipping what is already present, so an interrupted or partly
    # offline run resumes instead of re-fetching everything on the next start.
    printf '%s\n' "$entries" | while IFS="$(printf '\t')" read -r name source; do
        [ -n "$name" ] || continue
        [ -n "$source" ] || continue
        [ -f "$SKILLS_DIR/$name/$SKILL_FILE" ] && continue
        skills_cli add "$source" -g -y >/dev/null 2>&1 || true
    done

    missing=$(manifest_missing_names)
    if [ -n "$missing" ]; then
        warn "skills could not be fetched:$missing"
        warn "the environment is usable; those skills are simply absent."
        warn "retry with:  dsh-state refresh    (or: npx skills add <source> -g -y)"
        return 1
    fi

    : >"$SKILLS_MARKER"
    say "installed the skill catalog into $SKILLS_DIR"
    return 0
}

# --------------------------------------------------------------------------------------------------
# Subcommands.
# --------------------------------------------------------------------------------------------------
ensure() {
    if ! ensure_repo; then
        warn "could not clone $REPO_SLUG@$REPO_REF (network, or no $GIT_TOKEN_VAR to read it)."
        warn "the environment still starts: the shell works and the harness simply has no rules or skills."
        warn "retry with:  dsh-state refresh"
        return 0
    fi
    link_harness_home || true
    install_skills || true
    return 0
}

refresh() {
    say "forcing a re-clone and a re-install"
    rm -rf "$REPO_DIR"
    rm -f "$SKILLS_MARKER"
    ensure_repo || { warn "could not clone $REPO_SLUG@$REPO_REF; nothing was changed"; return 1; }
    link_harness_home || return 1
    install_skills || return 1
    return 0
}

status() {
    echo "state mount       $STATE_MOUNT"
    echo "clone             $REPO_DIR$([ -d "$REPO_DIR/.git" ] && echo ' (present)' || echo ' (absent)')"
    echo "harness home      $HARNESS_HOME"
    echo "agents home       $AGENTS_HOME"
    echo "skills manifest   $SKILLS_MANIFEST"
    echo
    echo "harness home, symlinked entries:"
    for entry in "$HARNESS_HOME"/* "$HARNESS_HOME"/.[!.]*; do
        [ -L "$entry" ] || continue
        echo "  $(basename "$entry") -> $(readlink "$entry")"
    done
    echo
    echo "rules the router links to, as it sees them:"
    for rule in "$HARNESS_HOME"/rules/*; do
        [ -f "$rule" ] || continue
        echo "  $(basename "$rule")"
    done
    echo
    echo "skills installed:"
    for skill in "$SKILLS_DIR"/*; do
        [ -f "$skill/$SKILL_FILE" ] || continue
        echo "  $(basename "$skill")"
    done
    echo
    missing=$(manifest_missing_names)
    if [ -n "$missing" ]; then
        echo "named by the manifest but missing:$missing"
    else
        echo "every skill named by the manifest is installed"
    fi
}

action=${1:-ensure}
case "$action" in
    ensure) ensure ;;
    refresh) refresh ;;
    status) status ;;
    *)
        echo "usage: dsh-state [ensure|refresh|status]" >&2
        exit 2
        ;;
esac
