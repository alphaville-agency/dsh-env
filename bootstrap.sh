#!/bin/sh
# Bootstrap the remote developer environment from anywhere.
#
#   sh -c "$(curl -fsSL -H "Authorization: Bearer $(gh auth token)" \
#     https://raw.githubusercontent.com/alphaville-agency/tooling/main/bootstrap.sh)"
#
# That is the whole setup. It needs an authenticated `gh` session and nothing else: `node` comes
# with the image and is not needed here, because the only thing this downloads is the client, which
# the container runs.
#
# Why a bootstrap rather than piping dsh.sh straight into a shell: `dsh.sh` launches an interactive
# TUI, and `curl ... | sh` hands the terminal's stdin to `sh` to read the script from. The TUI then
# has no terminal to talk to. This script is fetched to disk and run, so stdin stays the terminal,
# and it ends by exec'ing the client so the TUI owns the session directly.
#
# The repository is private, so the download carries an `Authorization` header from the local
# `gh` session. No credential is stored, printed, or written to disk.
set -eu

REPO="${DSH_REPO:-alphaville-agency/tooling}"
REF="${DSH_REF:-main}"
DIR="${DSH_ENV_DIR:-$HOME/.alphaville/dsh-env}"
RAW="https://raw.githubusercontent.com/$REPO/$REF"

say() { echo "[dsh] $*" >&2; }
die() { say "$*"; exit 1; }

need() {
    command -v "$1" >/dev/null 2>&1 || die "missing: $1${2:+ — $2}"
}

need gh "install it from https://cli.github.com, or use brew install gh"
need curl
need node "node 22+ is required; check your version manager"

gh auth status >/dev/null 2>&1 || die "not authenticated: run 'gh auth login' first"

# The token is read into a variable and used for the header only. It is never echoed, and it is
# never persisted — `gh` remains the only place it lives.
TOKEN=$(gh auth token) || die "could not read a token from the gh session"

fetch() {
    curl -fsSL -H "Authorization: Bearer $TOKEN" "$RAW/$1" -o "$2" \
        || die "could not fetch $1 from $REPO@$REF"
}

say "fetching the client from $REPO@$REF"
mkdir -p "$DIR/bin"
fetch dsh.sh              "$DIR/dsh.sh"
fetch bin/dsh-client.mjs  "$DIR/bin/dsh-client.mjs"
chmod +x "$DIR/dsh.sh"

# Exec, so the TUI replaces this shell and owns the terminal. Ctrl-C and window-resize reach it
# directly rather than through an intermediate process.
say "connecting to the remote environment"
exec sh "$DIR/dsh.sh" "$@"
