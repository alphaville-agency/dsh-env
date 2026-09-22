#!/bin/sh
# The check that the vendored agent configuration is honest. Three claims, all verified, all failing
# loudly rather than warning:
#
#   1. THE ONTOLOGY IS THE PINNED COPY. agent/ontology/ is a derived, read-only copy of the canonical
#      registry in the capability repository. Each file's sha256 is recomputed and compared with
#      PIN.json. When the canonical source is reachable it also says WHICH problem a mismatch is -
#      "the pin is stale" and "the vendored copy was edited" need different fixes.
#   2. THE SKILL CATALOG IS THE PINNED COPY. agent/skills-lock.json records one hash per skill
#      directory; every directory is rehashed and compared.
#   3. NOTHING POINTS OUTSIDE THE ENVIRONMENT. A vendored instruction file must contain no host
#      path and no home-relative path, because those do not resolve in the container and they fail
#      SILENTLY - the file looks correct in the repo and the instruction never loads.
#
# The two scripts in agent/ are the tooling that performs the vendoring, not vendored configuration,
# and they are excluded from claim 3 by name: they must name the source paths they copy from.
#
# POSIX sh. No arguments. Exits non-zero on anything above.
set -eu

# --- paths, defined once --------------------------------------------------------------------------
AGENT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ONTOLOGY_DIR=$AGENT_DIR/ontology
REGISTRY_FILE=$ONTOLOGY_DIR/registry.json
VALIDATOR_FILE=$ONTOLOGY_DIR/validate.py
PIN_FILE=$ONTOLOGY_DIR/PIN.json

SKILLS_DIR=$AGENT_DIR/skills
SKILLS_LOCK=$AGENT_DIR/skills-lock.json

AGENTS_FILE=$AGENT_DIR/AGENTS.md
MODEL_ROLES_FILE=$AGENT_DIR/MODEL-ROLES.md
RULES_DIR=$AGENT_DIR/rules
SETTINGS_FILE=$AGENT_DIR/settings.yaml
ONTOLOGY_README=$ONTOLOGY_DIR/README.md

SYNC_SCRIPT=$AGENT_DIR/sync.sh
DRIFT_SCRIPT=$ONTOLOGY_DIR/check-drift.sh
SYNC_NAME=sync.sh
DRIFT_NAME=check-drift.sh

PROFILES_DIR=$AGENT_DIR/profiles

# Installed dependencies must never be vendored: they are regenerated in the image from the
# lockfile, so one in the repository is a mistake in both directions at once.
INSTALLED_DIR_NAMES="node_modules .dsh-module-fallback"
INSTALLED_DIR_PATTERN='node_modules|\.dsh-module-fallback'

# The operator's own instructions. These are authored for this environment, so an absolute or
# home-relative path here is always a defect: it means the router is broken in the container.
OPERATOR_PATHS="$AGENTS_FILE $MODEL_ROLES_FILE $RULES_DIR $SETTINGS_FILE $ONTOLOGY_README $PIN_FILE"

# The canonical source, only ever read. Overridable so the check is usable off the operator's laptop.
CANONICAL_DIR=${CANONICAL_NAMES_DIR:-$HOME/Projects/agency/names}

REGISTRY_NAME=registry.json
VALIDATOR_NAME=validate.py

# --- patterns, defined once -----------------------------------------------------------------------
# Assembled from parts so this script does not match itself under the scans it performs; the two
# tooling scripts are excluded by name as well, belt and braces.
HOST_ROOT=/Users
HOST_ROOTS_PATTERN=$HOST_ROOT'/|/home/'
LEGACY_DIR_NAME=.codex
LEGACY_PATTERN='\.codex'
HOME_PATTERN='~/'

# Upstream skill content is copied verbatim and is not ours to edit, so a home-relative reference in
# it is reported rather than failed: `~/.zshrc` resolves in the container exactly as it does on the
# laptop. The one exception is a relative `.codex/skills/...` path inside an upstream test fixture -
# a legacy directory name in third-party prose, not a host path - which is named here so that the
# rule "no .codex anywhere" stays absolute without the check failing forever on a file we may not
# edit. This list is the only permitted exception, and it is printed on every run.
SKILL_PATH_EXCEPTION=skills/turnstile-spin/tests/validation.md

STRAY_NAME=.DS_Store

# --- hashing --------------------------------------------------------------------------------------
if command -v sha256sum >/dev/null 2>&1; then
    SHA_TOOL=sha256sum
elif command -v shasum >/dev/null 2>&1; then
    SHA_TOOL=shasum
else
    echo "check-drift: no sha256 tool (need sha256sum or shasum)" >&2
    exit 1
fi

hash_stream() {
    if [ "$SHA_TOOL" = shasum ]; then
        shasum -a 256
    else
        "$SHA_TOOL"
    fi | cut -d ' ' -f 1
}

hash_file() {
    if [ "$SHA_TOOL" = shasum ]; then
        shasum -a 256 -- "$1" | cut -d ' ' -f 1
    else
        "$SHA_TOOL" -- "$1" | cut -d ' ' -f 1
    fi
}

# The same function exists in sync.sh, which writes the lock this one reads. They must agree: a
# directory's hash is the sha256 of its sorted file list interleaved with each file's sha256.
hash_skill_dir() {
    dir=$1
    (
        cd "$dir" || exit 1
        find . -type f ! -name "$STRAY_NAME" | LC_ALL=C sort | while IFS= read -r rel; do
            printf '%s\n' "$rel"
            hash_file "$rel"
        done
    ) | hash_stream
}

# Read one expected hash out of a pin file with sed, so this needs no jq and no python.
pin_hash() {
    sed -n "s/.*\"$1\": *\"\([0-9a-f][0-9a-f]*\)\".*/\1/p" "$2"
}

# --- claim 1: the ontology matches PIN.json -------------------------------------------------------
diagnose() {
    file_name=$1
    expected=$2
    canonical_file=$CANONICAL_DIR/$file_name

    if [ ! -d "$CANONICAL_DIR" ]; then
        echo "  the canonical source is not reachable at $CANONICAL_DIR, so this is not classified." >&2
        return 0
    fi
    if [ ! -f "$canonical_file" ]; then
        echo "  $canonical_file is missing from a reachable canonical source." >&2
        return 0
    fi

    canonical_hash=$(hash_file "$canonical_file")
    if [ "$canonical_hash" = "$expected" ]; then
        echo "  the canonical copy still matches the pin, so the VENDORED COPY WAS EDITED." >&2
        echo "  fix: revert it, or edit the canonical copy and re-run agent/sync.sh." >&2
    else
        echo "  the canonical copy has moved on ($canonical_hash), so the PIN IS STALE." >&2
        echo "  fix: re-run agent/sync.sh to re-copy and re-pin." >&2
    fi
}

check_ontology_file() {
    file_name=$1
    file=$2
    if [ ! -f "$file" ]; then
        echo "check-drift: FAIL - $file is missing" >&2
        return 1
    fi
    expected=$(pin_hash "$file_name" "$PIN_FILE")
    if [ -z "$expected" ]; then
        echo "check-drift: FAIL - $PIN_FILE records no hash for $file_name" >&2
        return 1
    fi
    actual=$(hash_file "$file")
    if [ "$expected" = "$actual" ]; then
        echo "ok    ontology/$file_name  $actual"
        return 0
    fi
    echo "check-drift: FAIL - $file_name does not match its pin" >&2
    echo "  vendored: $actual" >&2
    echo "  pinned:   $expected" >&2
    diagnose "$file_name" "$expected" "$actual"
    return 1
}

# --- claim 2: the skill catalog matches skills-lock.json ------------------------------------------
check_skills_lock() {
    if [ ! -f "$SKILLS_LOCK" ]; then
        echo "check-drift: FAIL - $SKILLS_LOCK is missing; the catalog is unpinned" >&2
        return 1
    fi
    status=0
    ok_count=0
    for dir in "$SKILLS_DIR"/*; do
        [ -d "$dir" ] || continue
        name=$(basename "$dir")
        expected=$(pin_hash "$name" "$SKILLS_LOCK")
        if [ -z "$expected" ]; then
            echo "FAIL  $SKILLS_LOCK records no hash for skill $name (stale lock entry or unvendored skill)" >&2
            status=1
            continue
        fi
        actual=$(hash_skill_dir "$dir")
        if [ "$expected" = "$actual" ]; then
            ok_count=$((ok_count + 1))
        else
            echo "FAIL  skill $name does not match its pin" >&2
            echo "  vendored: $actual" >&2
            echo "  pinned:   $expected" >&2
            echo "  fix: re-run agent/sync.sh to re-copy and re-pin." >&2
            status=1
        fi
    done
    if [ "$status" -eq 0 ]; then
        echo "ok    skills-lock.json  $ok_count skill(s) match"
    fi
    return "$status"
}

# --- claim 3: nothing points outside the environment ----------------------------------------------
scan_paths() {
    status=0

    # FAIL: a host-absolute path anywhere in the vendored tree is always a bug. The two tooling
    # scripts are the only files that may name a source path, and only because that is their job.
    hits=$(grep -rInE "$HOST_ROOTS_PATTERN" "$AGENT_DIR" \
        --exclude="$SYNC_NAME" --exclude="$DRIFT_NAME" 2>/dev/null || true)
    if [ -n "$hits" ]; then
        echo "FAIL  a host-absolute path is in the vendored tree:" >&2
        printf '%s\n' "$hits" >&2
        status=1
    else
        echo "ok    no host-absolute path ($HOST_ROOT/ or /home/) outside the tooling"
    fi

    # FAIL: the legacy per-agent directory, anywhere in the vendored tree, with the single named
    # exception below.
    hits=$(grep -rInE "$LEGACY_PATTERN" "$AGENT_DIR" \
        --exclude="$SYNC_NAME" --exclude="$DRIFT_NAME" 2>/dev/null || true)
    exceptions=$(printf '%s\n' "$hits" | grep -F "$SKILL_PATH_EXCEPTION" || true)
    hits=$(printf '%s\n' "$hits" | grep -vF "$SKILL_PATH_EXCEPTION" || true)
    if [ -n "$hits" ]; then
        echo "FAIL  the legacy per-agent directory $LEGACY_DIR_NAME appears in the vendored tree:" >&2
        printf '%s\n' "$hits" >&2
        status=1
    else
        echo "ok    no $LEGACY_DIR_NAME anywhere in the vendored tree"
    fi
    if [ -n "$exceptions" ]; then
        echo "info  permitted exception (verbatim upstream test fixture, not ours to edit):"
        printf '%s\n' "$exceptions"
    fi

    # FAIL: an absolute or home-relative path in the files WE author. This is the check that
    # actually protects the container - these files are the router.
    hits=$(grep -rInE "$HOST_ROOTS_PATTERN|$HOME_PATTERN" $OPERATOR_PATHS 2>/dev/null || true)
    if [ -n "$hits" ]; then
        echo "FAIL  our own instruction files name a path outside the environment:" >&2
        printf '%s\n' "$hits" >&2
        status=1
    else
        echo "ok    no absolute or ~ path in the files we author"
    fi

    # WARN: home-relative references inside vendored third-party skill content. Reported, never
    # failed: rewriting another project's documentation would be us editing their docs.
    hits=$(grep -rInE "$HOME_PATTERN" "$SKILLS_DIR" 2>/dev/null || true)
    if [ -n "$hits" ]; then
        count=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
        echo "WARN  $count home-relative reference(s) inside verbatim upstream skills (not a failure):"
        printf '%s\n' "$hits"
    else
        echo "ok    no home-relative reference inside the upstream skills"
    fi

    return "$status"
}

# --- claim 4: no installed dependencies are vendored ----------------------------------------------
scan_installed_dependencies() {
    hits=$(find "$AGENT_DIR" -type d \( -name node_modules -o -name .dsh-module-fallback \) -print \
        2>/dev/null || true)
    if [ -n "$hits" ]; then
        echo "FAIL  installed dependencies are in the vendored tree; they belong to the lockfile," >&2
        echo "      regenerated in the image at build time:" >&2
        printf '%s\n' "$hits" >&2
        return 1
    fi
    echo "ok    no $INSTALLED_DIR_PATTERN in the vendored tree (lockfiles only)"
    return 0
}

# --- run ------------------------------------------------------------------------------------------
if [ ! -f "$PIN_FILE" ]; then
    echo "check-drift: FAIL - $PIN_FILE is missing; the ontology is unpinned" >&2
    exit 1
fi

status=0
check_ontology_file "$REGISTRY_NAME" "$REGISTRY_FILE" || status=1
check_ontology_file "$VALIDATOR_NAME" "$VALIDATOR_FILE" || status=1
check_skills_lock || status=1
scan_paths || status=1
scan_installed_dependencies || status=1

if [ "$status" -eq 0 ]; then
    echo "check-drift: the vendored configuration matches its pins and points only inside the environment."
else
    echo "check-drift: the vendored configuration FAILED a check (see above)." >&2
fi
exit "$status"