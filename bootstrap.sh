#!/bin/sh
# Bootstrap the dsh developer workspace from anywhere, in one line.
#
#   sh -c "$(curl -fsSL -H "Authorization: Bearer $(gh auth token)" \
#     https://raw.githubusercontent.com/alphaville-agency/tooling/main/bootstrap.sh)"
#
# Arguments pass straight through to `dsh.sh`, so:
#
#   ... | sh -s -- uname -a    run one command instead of opening a session
#
# WHAT THIS NEEDS, AND WHY. An authenticated `gh` session to download the client, and an
# authenticated `wrangler` because `dsh.sh` mints a fresh token and writes it to the Worker on every
# session. That second requirement is not incidental: Cloudflare secrets are write-only, so there is
# no token to read back and no shared secret to distribute - the credential is the ability to write
# it. `node` is needed for the WebSocket client.
#
# WHY A BOOTSTRAP RATHER THAN PIPING dsh.sh INTO A SHELL. `dsh.sh` ends by launching an interactive
# TUI, and `curl ... | sh` hands the terminal's stdin to `sh` to read the script from. The TUI would
# then have no terminal to talk to. This script is fetched to disk and run, so stdin stays the
# terminal, and it ends by exec'ing the client so the TUI owns the session directly.
#
# The repository is private, so the download carries an `Authorization` header built from the local
# `gh` session. That token is used for the header only: never echoed, never written to disk.
set -eu

REPO="${DSH_REPO:-alphaville-agency/tooling}"
REF="${DSH_REF:-main}"
DIR="${DSH_ENV_DIR:-$HOME/.alphaville/dsh-env}"
RAW="https://raw.githubusercontent.com/$REPO/$REF"

say() { echo "[dsh] $*" >&2; }
die() { say "$*"; exit 1; }

need() {
    command -v "$1" >/dev/null 2>&1 || die "missing: $1${2:+ - $2}"
}

need gh "install it from https://cli.github.com, or use brew install gh"
need curl
need node "node 22 or newer is required for the built-in WebSocket client"
need wrangler "the session token is written to the Worker with 'wrangler secret put', so wrangler must be installed and authenticated"

gh auth status >/dev/null 2>&1 || die "not authenticated: run 'gh auth login' first"
wrangler whoami >/dev/null 2>&1 || die "wrangler is not authenticated: run 'wrangler login' first"

DOWNLOAD_TOKEN=$(gh auth token) || die "could not read a token from the gh session"

fetch() {
    curl -fsSL -H "Authorization: Bearer $DOWNLOAD_TOKEN" "$RAW/$1" -o "$2" \
        || die "could not fetch $1 from $REPO@$REF"
}

say "fetching the client from $REPO@$REF"
mkdir -p "$DIR/bin"
fetch dsh.sh             "$DIR/dsh.sh"
fetch bin/dsh-client.mjs "$DIR/bin/dsh-client.mjs"
chmod +x "$DIR/dsh.sh"

# Exec, so the TUI replaces this shell and owns the terminal. Ctrl-C and window-resize reach it
# directly rather than through an intermediate process.
say "opening a session"
exec sh "$DIR/dsh.sh" "$@"