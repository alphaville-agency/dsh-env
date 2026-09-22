#!/bin/sh
# The check that the repository's derived configuration is honest.
#
# WHAT APM ALREADY COVERS, AND WHY IT IS NOT REPEATED HERE
#
# APM replaced the bespoke half of this script. `apm audit` replays the install into a scratch tree
# and diffs it against the working tree, verifies a SHA-256 per deployed file against
# `apm.lock.yaml`, and scans every deployed primitive for hidden Unicode. That is strictly more than
# the two things this script used to do for skills -- compare every skill directory against
# `skills-lock.json`, and grep the vendored tree for credential-shaped strings -- so both were
# deleted rather than kept as a second mechanism. The commands are:
#
#     apm install          deploy from apm.yml, writing apm.lock.yaml
#     apm audit            content scan + drift replay (advisory: drift alone exits 0)
#     apm audit --ci       the same as a gate: exit 1 on drift or any failed check
#
# WHAT APM DOES NOT COVER, AND WHY THIS SCRIPT STILL EXISTS
#
#   1. THE NAMING ONTOLOGY. `.dsh/ontology/` is a derived, read-only copy of the canonical registry
#      in another repository, pinned by `PIN.json` -- a file naming in this repository, not a skill
#      or an instruction, so APM has no primitive for it. It cannot be expressed as an APM
#      dependency either: the declared source repository `alphaville-agency/capability` does not
#      exist (`gh api repos/alphaville-agency/capability` -> 404, and it is absent from
#      `gh repo list alphaville-agency`), so a dependency on it would make `apm install` fail for
#      every consumer. This check is therefore the only thing that can verify the pin, and it stays.
#
#   2. NOTHING POINTS OUTSIDE THE ENVIRONMENT. A vendored instruction file naming a host path fails
#      SILENTLY: it looks correct in the repository and the instruction never loads in the container.
#      APM resolves package content and knows nothing about host paths in our own prose, so this
#      check stays. It is a grep over files we author, and it costs nothing.
#
#   3. NO INSTALLED DEPENDENCIES ARE VENDORED. `node_modules` and the harness's module-fallback
#      cache are regenerated in the image from the committed lockfiles and must never be committed.
#      `apm audit --ci` knows about APM-governed paths only, so this stays too.
#
# NOT CHECKED HERE, ON PURPOSE: agent primitives, which are `apm audit --ci`'s job, and the upstream
# skill prose that used to be grepped for `~` and `.codex` -- that content is now deployed by APM
# rather than vendored, it is not ours to edit, and the scan produced only permitted exceptions.
#
# The two scripts in `tools/` are the tooling that performs the vendoring, not vendored
# configuration, and they are excluded from claim 2 by name: they must name the paths they copy from.
#
# POSIX sh. No arguments. Exits non-zero on anything above.
set -eu

# --- paths, defined once --------------------------------------------------------------------------
REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DSH_DIR=$REPO_DIR/.dsh
TOOLS_DIR=$REPO_DIR/tools
APM_DIR=$REPO_DIR/.apm

ONTOLOGY_DIR=$DSH_DIR/ontology
REGISTRY_FILE=$ONTOLOGY_DIR/registry.json
VALIDATOR_FILE=$ONTOLOGY_DIR/validate.py
PIN_FILE=$ONTOLOGY_DIR/PIN.json

AGENTS_FILE=$DSH_DIR/AGENTS.md
MODEL_ROLES_FILE=$DSH_DIR/MODEL-ROLES.md
RULES_DIR=$DSH_DIR/rules
SETTINGS_FILE=$DSH_DIR/settings.yaml
PERSISTENCE_FILE=$DSH_DIR/persistence.json
ONTOLOGY_README=$ONTOLOGY_DIR/README.md

PACKAGE_README=$APM_DIR/README.md

SYNC_SCRIPT=$TOOLS_DIR/sync.sh
DRIFT_SCRIPT=$TOOLS_DIR/check-drift.sh
SYNC_NAME=sync.sh
DRIFT_NAME=check-drift.sh

# Installed dependencies must never be vendored: they are regenerated in the image from the
# lockfile, so one in the repository is a mistake in both directions at once.
INSTALLED_DIR_NAMES="node_modules .dsh-module-fallback"
INSTALLED_DIR_PATTERN='node_modules|\.dsh-module-fallback'

# The operator's own instructions. These are authored for this environment, so an absolute or
# home-relative path here is always a defect: it means the router is broken in the container.
OPERATOR_PATHS="$AGENTS_FILE $MODEL_ROLES_FILE $RULES_DIR $SETTINGS_FILE $PERSISTENCE_FILE $ONTOLOGY_README $PIN_FILE $APM_DIR/README.md"

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

hash_file() {
    if [ "$SHA_TOOL" = shasum ]; then
        shasum -a 256 -- "$1" | cut -d ' ' -f 1
    else
        "$SHA_TOOL" -- "$1" | cut -d ' ' -f 1
    fi
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
        echo "  fix: revert it, or edit the canonical copy and re-run tools/sync.sh." >&2
    else
        echo "  the canonical copy has moved on ($canonical_hash), so the PIN IS STALE." >&2
        echo "  fix: re-run tools/sync.sh to re-copy and re-pin." >&2
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
    diagnose "$file_name" "$expected"
    return 1
}

# --- claim 2: nothing points outside the environment ----------------------------------------------
# `scan_status`, NOT `status`: POSIX sh has no local variables, so a function that writes to a name
# the caller also uses silently overwrites the caller's accumulator. The original version of this
# script had exactly that bug -- `scan_paths` opened with `status=0`, which erased the ontology
# failure recorded before it, so the script exited 0 with a failed check printed above it. The
# accumulators are therefore named per function, and the main block uses `failures`.
scan_paths() {
    scan_status=0

    # FAIL: a host-absolute path anywhere in the configuration we author is always a bug. The two
    # tooling scripts are the only files that may name a source path, and only because that is their
    # job. `.apm/` is scanned too: it is our own prose, not upstream package content.
    hits=$(grep -rInE "$HOST_ROOTS_PATTERN" "$DSH_DIR" "$APM_DIR" \
        --exclude="$SYNC_NAME" --exclude="$DRIFT_NAME" 2>/dev/null || true)
    if [ -n "$hits" ]; then
        echo "FAIL  a host-absolute path is in the configuration we author:" >&2
        printf '%s\n' "$hits" >&2
        scan_status=1
    else
        echo "ok    no host-absolute path ($HOST_ROOT/ or /home/) outside the tooling"
    fi

    # FAIL: the legacy per-agent directory, anywhere in the configuration we author. This is
    # checked over our own prose only: deployed skill content is APM's to own, and its upstream
    # prose is not ours to edit.
    hits=$(grep -rInE "$LEGACY_PATTERN" "$DSH_DIR" "$APM_DIR" \
        --exclude="$SYNC_NAME" --exclude="$DRIFT_NAME" 2>/dev/null || true)
    if [ -n "$hits" ]; then
        echo "FAIL  the legacy per-agent directory $LEGACY_DIR_NAME appears in the configuration:" >&2
        printf '%s\n' "$hits" >&2
        scan_status=1
    else
        echo "ok    no $LEGACY_DIR_NAME anywhere in the configuration we author"
    fi

    # FAIL: an absolute host path in the files WE author. This is the check that actually protects
    # the container - these files are the router - and it is the one that fails loudly.
    hits=$(grep -rInE "$HOST_ROOTS_PATTERN" $OPERATOR_PATHS 2>/dev/null || true)
    if [ -n "$hits" ]; then
        echo "FAIL  our own instruction files name a path outside the environment:" >&2
        printf '%s\n' "$hits" >&2
        scan_status=1
    else
        echo "ok    no absolute host path in the files we author"
    fi

    # REPORTED, NOT FAILED: a home-relative reference in the files we author. `~` resolves INSIDE
    # the container - the image sets HOME=/root and the clone's .agents/ is symlinked to
    # /root/.agents - so `~/.agents/skills/plane` names exactly the discovery path the environment
    # creates, and a credential path such as `~/.agent-reach/config.yaml` is prose about a file that
    # is never carried. Failing on those two would be a false positive, which is why the old version
    # of this check never got to run. They are printed on every run so a NEW `~` is still visible.
    hits=$(grep -rInE "$HOME_PATTERN" $OPERATOR_PATHS 2>/dev/null || true)
    if [ -n "$hits" ]; then
        count=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
        echo "info  $count home-relative reference(s) in the files we author (resolves in the container):"
        printf '%s\n' "$hits"
    else
        echo "ok    no home-relative reference in the files we author"
    fi

    return "$scan_status"
}

# --- claim 3: no installed dependencies are vendored ----------------------------------------------
scan_installed_dependencies() {
    hits=$(find "$DSH_DIR" "$APM_DIR" -type d \( -name node_modules -o -name .dsh-module-fallback \) -print \
        2>/dev/null || true)
    if [ -n "$hits" ]; then
        echo "FAIL  installed dependencies are in the repository; they belong to the lockfile," >&2
        echo "      regenerated in the image at build time:" >&2
        printf '%s\n' "$hits" >&2
        return 1
    fi
    echo "ok    no $INSTALLED_DIR_PATTERN under .dsh/ or .apm/ (lockfiles only)"
    return 0
}

# --- run ------------------------------------------------------------------------------------------
if [ ! -f "$PIN_FILE" ]; then
    echo "check-drift: FAIL - $PIN_FILE is missing; the ontology is unpinned" >&2
    exit 1
fi
if [ ! -f "$PACKAGE_README" ]; then
    echo "check-drift: FAIL - $PACKAGE_README is missing; the .apm/ source tree has no README" >&2
    exit 1
fi

failures=0
check_ontology_file "$REGISTRY_NAME" "$REGISTRY_FILE" || failures=1
check_ontology_file "$VALIDATOR_NAME" "$VALIDATOR_FILE" || failures=1
scan_paths || failures=1
scan_installed_dependencies || failures=1

if [ "$failures" -eq 0 ]; then
    echo "check-drift: the pinned ontology matches, and our configuration points only inside the environment."
    echo "check-drift: agent primitives are NOT checked here - run 'apm audit --ci' for those."
else
    echo "check-drift: FAILED a check (see above)." >&2
fi
exit "$failures"