#!/bin/sh
# Re-vendor the operator's agent instruction and configuration into agent/.
#
# The laptop copy is the authoring location; this directory is the committed, reviewable copy that
# the image bakes in. They drift, so refreshing is a script rather than a hand-copy, and the script
# is safe to run repeatedly: every destination is overwritten or rebuilt, never merged.
#
# What it does, in order:
#   1. copies the whitelist of sources below, verbatim, into agent/
#   2. normalises the operator's pointers so nothing names a laptop path (the rewrite is declared
#      here, applied mechanically, and reported - it is not a hand-edit a re-sync would undo)
#   3. refuses to continue quietly if the copied tree contains a credential-shaped string
#   4. re-writes agent/ontology/PIN.json and agent/skills-lock.json from the bytes just copied
#   5. runs agent/ontology/check-drift.sh, which proves the pins and the paths
#
# It never runs in the container and the container never reads from the laptop. The output is
# reviewed and committed like any other source change, and reaches the container only through a
# rebuild and a deploy.
#
# POSIX sh. No arguments.
set -eu

# --- destinations, defined once -------------------------------------------------------------------
REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
AGENT_DIR=$REPO_DIR/agent

AGENTS_DST=$AGENT_DIR/AGENTS.md
MODEL_ROLES_DST=$AGENT_DIR/MODEL-ROLES.md
RULES_DST=$AGENT_DIR/rules
SETTINGS_DST=$AGENT_DIR/settings.yaml
SKILLS_DST=$AGENT_DIR/skills
PROFILES_DST=$AGENT_DIR/profiles
ONTOLOGY_DST=$AGENT_DIR/ontology
REGISTRY_DST=$ONTOLOGY_DST/registry.json
VALIDATOR_DST=$ONTOLOGY_DST/validate.py
PIN_DST=$ONTOLOGY_DST/PIN.json
SKILLS_LOCK_DST=$AGENT_DIR/skills-lock.json
DRIFT_SCRIPT=$ONTOLOGY_DST/check-drift.sh

# Scratch files live outside the tree under review, so the scans below never read them and nothing
# transient can be committed by accident.
TMP_DIR=${TMPDIR:-/tmp}
REPORT_LOG=$TMP_DIR/dsh-agent-sync-report.$$
FILE_LIST=$TMP_DIR/dsh-agent-sync-filelist.$$
REWRITE_TMP=$TMP_DIR/dsh-agent-sync-rewrite.$$
trap 'rm -f -- "$REPORT_LOG" "$FILE_LIST" "$REWRITE_TMP"' EXIT INT TERM

# --- sources, defined once. All on the operator's laptop, all overridable for a test run. ---------
DSH_DIR=${DSH_DIR:-$HOME/.dsh}
SKILLS_SRC=${AGENT_SKILLS_DIR:-$HOME/.agents/skills}
NAMES_SRC=${CANONICAL_NAMES_DIR:-$HOME/Projects/agency/names}

AGENTS_SRC=$DSH_DIR/AGENTS.md
MODEL_ROLES_SRC=$DSH_DIR/MODEL-ROLES.md
RULES_SRC=$DSH_DIR/rules
SETTINGS_SRC=$DSH_DIR/settings.yaml
REGISTRY_SRC=$NAMES_SRC/registry.json
VALIDATOR_SRC=$NAMES_SRC/validate.py

# The skill catalog is the one source of skills. One older skill still lives outside it, in a
# legacy per-agent directory that must not exist in this environment; it is bridged here so the
# catalog is complete, and the bridge retires itself the moment the skill moves into the catalog.
# A file that cannot name where it copies FROM cannot vendor anything, which is why the tooling
# names this path and the vendored configuration never does.
LEGACY_AGENT_DIR=.codex
PLANE_SKILL=plane
LEGACY_SKILLS_DIR=$HOME/$LEGACY_AGENT_DIR/skills

# --- pointer normalisation -------------------------------------------------------------------------
# The operator's config was authored on a laptop and names absolute paths under it. Those do not
# exist in the container, and a broken pointer fails SILENTLY: the file looks correct in the repo
# and the instruction it carries never loads. So the rewrite is declared here as literal
# from/to pairs, applied to the operator's own instruction files on every sync, and reported.
#
# The Plane skill is named, not located: the harness discovers and activates skills from the
# catalog, so a path is both fragile and redundant.
NORMALISE_TARGETS="$AGENTS_DST $MODEL_ROLES_DST $SETTINGS_DST $RULES_DST/design-ladder.md $RULES_DST/research-taste.md"

REWRITE_FROM_1='For any Plane-related task, lazily load the canonical shared guidance at:'
REWRITE_TO_1='For any Plane-related task, lazily load the canonical shared Plane skill by name:'
REWRITE_FROM_2=$HOME/.dsh/MODEL-ROLES.md
REWRITE_TO_2='MODEL-ROLES.md'
REWRITE_FROM_3=$HOME/$LEGACY_AGENT_DIR/skills/$PLANE_SKILL/SKILL.md
REWRITE_TO_3=$PLANE_SKILL

# --- credential scan patterns ----------------------------------------------------------------------
# A credential-shaped string must never reach the image. The prefixes are the ones named in the
# brief, tightened so ordinary prose ("task-specific", "risk-score") is not a false positive, plus a
# backstop for a literal assigned to a KEY/TOKEN/SECRET variable. Documentation placeholders are
# recognised and counted rather than hidden.
SECRET_PATTERN='sk-[A-Za-z0-9_-]{20,}|ci_live[A-Za-z0-9_-]{6,}|cfat_[A-Za-z0-9_-]{6,}|hf_[A-Za-z0-9]{20,}|tskey-[A-Za-z0-9_-]{6,}|am_us_[A-Za-z0-9_-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
QUOTE_CLASS="[\"']"
ASSIGNMENT_PATTERN='(API_?KEY|_TOKEN|_SECRET|PASSWORD)[A-Za-z0-9_]*[[:space:]]*[:=][[:space:]]*'"$QUOTE_CLASS"'?[A-Za-z0-9_+/=-]{16,}'
PLACEHOLDER_PATTERN='your[_-]|_here|abc123|placeholder|example|redacted|xxx|XXX|\$\{|\$[A-Z]|process\.env|os\.environ'

STRAY_NAME=.DS_Store

# --- profiles ---------------------------------------------------------------------------------------
# The dsh profiles are what makes `dsh` a TUI in the container rather than a bare CLI. They are
# declarative config: a package.json naming the bundles, a pnpm lockfile, and the cordis layers.
#
# Installed dependencies are NEVER vendored. node_modules is the thing the lockfile exists to
# reproduce, and it is 58 MB of machine-local tree that git should not carry and the image should
# rebuild - the same discipline the npm toolchain already uses in this repo. So the whole profile
# tree is copied and then pruned of exactly two directory names, both of them install output.
#
# The module-fallback directory holds nothing but node_modules: a cache the harness populates when
# module resolution has already failed. Excluding it is the same decision, taken on the same grounds.
PROFILES_SRC=$DSH_DIR/profiles
PROFILE_PRUNE_NAMES="node_modules .dsh-module-fallback"
pruned_files=0

# --- counters -------------------------------------------------------------------------------------
copied=0
excluded=0
substitutions=0

copy_file() {
    src=$1
    dst=$2
    if [ ! -f "$src" ]; then
        echo "sync: MISSING SOURCE $src" >&2
        return 1
    fi
    cp -- "$src" "$dst"
    copied=$((copied + 1))
}

copy_dir() {
    src=$1
    dst=$2
    if [ ! -d "$src" ]; then
        echo "sync: MISSING SOURCE $src" >&2
        return 1
    fi
    # Rebuilt, never merged: a skill deleted upstream must disappear here too.
    case $dst in
        "$AGENT_DIR"/*) rm -rf -- "$dst" ;;
        *) echo "sync: refusing to remove $dst (outside $AGENT_DIR)" >&2; exit 1 ;;
    esac
    mkdir -p -- "$dst"
    # Stray editor and filesystem files are never vendored or hashed.
    cp -R -- "$src/." "$dst/"
    find "$dst" -name "$STRAY_NAME" -type f -delete
    copied=$((copied + $(find "$dst" -type f | wc -l | tr -d ' ')))
}

copy_profiles() {
    src=$1
    dst=$2
    if [ ! -d "$src" ]; then
        echo "sync: MISSING SOURCE $src" >&2
        return 1
    fi
    case $dst in
        "$AGENT_DIR"/*) rm -rf -- "$dst" ;;
        *) echo "sync: refusing to remove $dst (outside $AGENT_DIR)" >&2; exit 1 ;;
    esac
    mkdir -p -- "$dst"
    cp -R -- "$src/." "$dst/"
    # Stray editor and filesystem files are never vendored or hashed.
    find "$dst" -name "$STRAY_NAME" -type f -delete
    # -prune so a nested node_modules inside a pruned one is not visited twice.
    for name in $PROFILE_PRUNE_NAMES; do
        find "$dst" -type d -name "$name" -prune -print > "$FILE_LIST"
        while IFS= read -r dir; do
            pruned_files=$((pruned_files + $(find "$dir" -type f | wc -l | tr -d ' ')))
            rm -rf -- "$dir"
        done < "$FILE_LIST"
    done
    copied=$((copied + $(find "$dst" -type f | wc -l | tr -d ' ')))
}

# Report an item that exists on the laptop and is deliberately NOT copied. Printing it is the point:
# an exclusion that is only in someone's head is how a 215 MB cache ends up in an image.
note_excluded() {
    path=$1
    reason=$2
    if [ -e "$path" ]; then
        echo "excluded  $path  ($reason)"
        excluded=$((excluded + 1))
    fi
}

# Literal, whole-string replacement - no regex, so backticks and brackets in the operator's prose
# cannot be mistaken for a pattern.
replace_literal() {
    file=$1
    from=$2
    to=$3
    hits=$(grep -oF -- "$from" "$file" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$hits" -eq 0 ]; then
        return 0
    fi
    awk -v from="$from" -v to="$to" '
        {
            while ((i = index($0, from)) > 0) {
                $0 = substr($0, 1, i - 1) to substr($0, i + length(from))
            }
            print
        }
    ' "$file" > "$REWRITE_TMP"
    # Copied back rather than moved, so the file keeps its original mode.
    cat "$REWRITE_TMP" > "$file"
    printf '%s\t%s\n' "$hits" "${file#"$REPO_DIR"/}" >> "$REPORT_LOG"
    substitutions=$((substitutions + hits))
}

normalise_pointers() {
    : > "$REPORT_LOG"
    for file in $NORMALISE_TARGETS; do
        [ -f "$file" ] || continue
        replace_literal "$file" "$REWRITE_FROM_1" "$REWRITE_TO_1"
        replace_literal "$file" "$REWRITE_FROM_2" "$REWRITE_TO_2"
        replace_literal "$file" "$REWRITE_FROM_3" "$REWRITE_TO_3"
    done
}

# --- copy -----------------------------------------------------------------------------------------
mkdir -p -- "$AGENT_DIR" "$RULES_DST" "$SKILLS_DST" "$ONTOLOGY_DST"

copy_file "$AGENTS_SRC" "$AGENTS_DST"
copy_file "$MODEL_ROLES_SRC" "$MODEL_ROLES_DST"
copy_file "$RULES_SRC/design-ladder.md" "$RULES_DST/design-ladder.md"
copy_file "$RULES_SRC/research-taste.md" "$RULES_DST/research-taste.md"
copy_file "$SETTINGS_SRC" "$SETTINGS_DST"
copy_dir "$SKILLS_SRC" "$SKILLS_DST"

# The bridge for the one skill still outside the catalog. If the catalog has it, the catalog wins
# and this is skipped - so moving the skill into the catalog retires this block with no edit here.
if [ -d "$SKILLS_SRC/$PLANE_SKILL" ]; then
    echo "info  $PLANE_SKILL came from the catalog; the legacy bridge was not used"
elif [ -d "$LEGACY_SKILLS_DIR/$PLANE_SKILL" ]; then
    copy_dir "$LEGACY_SKILLS_DIR/$PLANE_SKILL" "$SKILLS_DST/$PLANE_SKILL"
    echo "info  $PLANE_SKILL is not in $SKILLS_SRC yet; bridged from the legacy per-agent directory"
    echo "info    move it into the catalog and this bridge retires itself"
else
    echo "sync: MISSING SOURCE neither $SKILLS_SRC/$PLANE_SKILL nor $LEGACY_SKILLS_DIR/$PLANE_SKILL" >&2
    exit 1
fi

copy_file "$REGISTRY_SRC" "$REGISTRY_DST"
copy_file "$VALIDATOR_SRC" "$VALIDATOR_DST"

# The dsh profiles, with install output pruned rather than the whole directory excluded.
copy_profiles "$PROFILES_SRC" "$PROFILES_DST"
echo "info  profiles: $pruned_files installed-dependency file(s) excluded; the lockfiles are"
echo "info    committed and the image installs them with a frozen lockfile at build time"

# --- exclusions, stated out loud ------------------------------------------------------------------
echo "--- exclusions ---"
note_excluded "$DSH_DIR/storages" "local session cache, hundreds of MB; never enters an image"
note_excluded "$DSH_DIR/sessions" "local session history, not configuration"
note_excluded "$DSH_DIR/attachments" "local session attachments"
note_excluded "$DSH_DIR/.agent-presets" "local preset state"
note_excluded "$DSH_DIR/.credentials.yaml" "credentials; injected at runtime instead"
note_excluded "$DSH_DIR/.anonymous-user-id" "local identity, not configuration"
note_excluded "$DSH_DIR/profiles/node_modules" "empty top-level dir; dependencies come from the lockfile at build time"
note_excluded "$NAMES_SRC/__pycache__" "build artifact; the validator is run from source"
# Backups drift silently against the files they shadow, so none of them travel.
for backup in "$DSH_DIR"/*.bak*; do
    if [ -e "$backup" ]; then
        note_excluded "$backup" "backup file; drifts against the file it shadows"
    fi
done

# --- make the pointers portable -------------------------------------------------------------------
echo "--- pointer normalisation ---"
normalise_pointers
if [ "$substitutions" -gt 0 ]; then
    awk -F '\t' '{ printf "info  %s occurrence(s) in %s\n", $1, $2 }' "$REPORT_LOG"
    echo "info  the Plane skill is referenced by name; the model roles file by its sibling name"
else
    echo "info  nothing to rewrite: no laptop path in the operator's instruction files"
fi

# --- credential scan ------------------------------------------------------------------------------
echo "--- credential scan of $AGENT_DIR ---"
scan_status=0

secret_hits=$(grep -rInE "$SECRET_PATTERN" "$AGENT_DIR" 2>/dev/null || true)
if [ -n "$secret_hits" ]; then
    echo "FAIL: secret-shaped strings found:" >&2
    printf '%s\n' "$secret_hits" >&2
    scan_status=1
else
    echo "ok    no secret-shaped string (sk-, ci_live, cfat_, hf_, tskey-, am_us_, PRIVATE KEY)"
fi

assignment_hits=$(grep -rInE "$ASSIGNMENT_PATTERN" "$AGENT_DIR" 2>/dev/null || true)
placeholder_hits=$(printf '%s\n' "$assignment_hits" | grep -E "$PLACEHOLDER_PATTERN" || true)
unexplained_hits=$(printf '%s\n' "$assignment_hits" | grep -vE "$PLACEHOLDER_PATTERN" || true)

if [ -n "$unexplained_hits" ]; then
    echo "FAIL: a literal is assigned to a KEY/TOKEN/SECRET variable and it is not a known placeholder:" >&2
    printf '%s\n' "$unexplained_hits" >&2
    scan_status=1
else
    echo "ok    no unexplainable *_KEY/*_TOKEN/*_SECRET assignment"
fi

placeholder_count=0
if [ -n "$placeholder_hits" ]; then
    placeholder_count=$(printf '%s\n' "$placeholder_hits" | wc -l | tr -d ' ')
fi
printf 'info  %s documentation placeholder assignment(s) recognised and not treated as secrets\n' "$placeholder_count"

if [ "$scan_status" -ne 0 ]; then
    echo "sync: FAILED the credential scan. Nothing was pinned. Do NOT commit $AGENT_DIR as it stands." >&2
    exit 1
fi

# --- hashing --------------------------------------------------------------------------------------
if command -v sha256sum >/dev/null 2>&1; then
    SHA_TOOL=sha256sum
elif command -v shasum >/dev/null 2>&1; then
    SHA_TOOL=shasum
else
    echo "sync: no sha256 tool (need sha256sum or shasum)" >&2
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

# check-drift.sh computes this identically; the two must agree. A directory's hash is the sha256 of
# its sorted file list interleaved with each file's sha256.
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

pinned_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# --- pin the ontology -----------------------------------------------------------------------------
registry_hash=$(hash_file "$REGISTRY_DST")
validator_hash=$(hash_file "$VALIDATOR_DST")
pin_tmp=$PIN_DST.tmp

cat > "$pin_tmp" <<PIN_EOF
{
  "source_repo": "alphaville-agency/capability",
  "derived_from": "names/",
  "pinned_at": "$pinned_at",
  "files": {
    "registry.json": "$registry_hash",
    "validate.py": "$validator_hash"
  },
  "rule": "This is a derived, read-only copy of the canonical registry. Edit the canonical copy in the capability repo and re-run agent/sync.sh. A local edit here is drift and the check will fail."
}
PIN_EOF
mv -- "$pin_tmp" "$PIN_DST"

# --- pin the skill catalog ------------------------------------------------------------------------
skill_count=0
lock_tmp=$SKILLS_LOCK_DST.tmp
{
    printf '{\n'
    printf '  "catalog": "skills/",\n'
    printf '  "installed_at": "/root/.agents/skills/",\n'
    printf '  "source": "the operator laptop skill catalog, vendored verbatim",\n'
    printf '  "pinned_at": "%s",\n' "$pinned_at"
    printf '  "files": {\n'
    first=1
    for dir in "$SKILLS_DST"/*; do
        [ -d "$dir" ] || continue
        name=$(basename "$dir")
        if [ "$first" -eq 0 ]; then
            printf ',\n'
        fi
        first=0
        printf '    "%s": "%s"' "$name" "$(hash_skill_dir "$dir")"
        skill_count=$((skill_count + 1))
    done
    printf '\n  },\n'
    printf '  "count": %s,\n' "$skill_count"
    printf '  "rule": "Derived, read-only copy of the skill catalog. Refresh with agent/sync.sh; a local edit here is drift and the check will fail."\n'
    printf '}\n'
} > "$lock_tmp"
mv -- "$lock_tmp" "$SKILLS_LOCK_DST"

# --- prove the pins and the paths -----------------------------------------------------------------
echo "--- vendored-tree check ---"
if ! sh "$DRIFT_SCRIPT"; then
    echo "sync: the vendored-tree check failed. Nothing here should be committed as it stands." >&2
    exit 1
fi

# --- summary --------------------------------------------------------------------------------------
echo "--- summary ---"
echo "copied    $copied file(s) into $AGENT_DIR"
echo "excluded  $excluded item(s) on the laptop, each named above with its reason"
echo "rewrote   $substitutions pointer occurrence(s) so no instruction names a laptop path"
echo "pinned    registry.json $registry_hash"
echo "pinned    validate.py   $validator_hash"
echo "pinned    skills-lock.json $skill_count skill(s)"
echo "scan      PASS (0 secret-shaped, $placeholder_count documentation placeholder(s))"
echo "next      review the diff, then commit. The container never reads from the laptop."