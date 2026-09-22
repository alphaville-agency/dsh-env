# dsh developer environment

This repository is the **dsh developer environment**: a Cloudflare Container, driven through the
official Cloudflare Sandbox SDK, that provides the working environment for agents and the operator.

It is **not the agency**, and the agency must never depend on it — it may disappear without affecting
production. The clean-slate build will be done *from inside this environment* once it is verified.

## Use it

### From anywhere, in one line

On any machine with an authenticated `gh` session and Node 22+, run:

```sh
sh -c "$(curl -fsSL -H "Authorization: Bearer $(gh auth token)" \
  https://raw.githubusercontent.com/alphaville-agency/tooling/main/bootstrap.sh)"
```

That is the whole setup — no clone, no config, no local state. It fetches the client into
`~/.alphaville/dsh-env`, connects, and drops you into the `dsh` TUI. Pass arguments through the same
way, e.g. append `uname -a` to run one command instead of opening the TUI.

Two things about that line are deliberate, and both are easy to get wrong:

- **It is `sh -c "$(curl …)"`, not `curl … | sh`.** A TUI needs the terminal's stdin. `curl | sh`
  hands stdin to `sh` to read the script from, so the TUI gets no terminal and dies or hangs. This
  form runs the fetched script while leaving stdin alone.
- **The repo is private, so the download is authorised by your existing `gh` session.** The token is
  read into the request header only: never printed, never written to disk, never committed. `gh`
  stays the single place it lives.

### In a clone of this repo

```sh
./dsh.sh                 # a dsh terminal in the cloud, attached to this terminal
./dsh.sh uname -a        # one command, its output back here, exit code preserved
./dsh.sh 'git log -1'    # quoting works the same way
```

`./dsh.sh` starts the container, attaches your terminal to the workspace over the Sandbox terminal
WebSocket, and drops you into the `dsh` TUI. It **starts when you connect** and the container
**shuts down 5 minutes after your last activity**; nothing runs while nobody is connected.
[`docs/COST.md`](docs/COST.md) is the arithmetic, and explains why nothing in this repo is allowed to
heartbeat.

Requires Node 22 or newer (for the built-in `WebSocket`) and, for the one-shot path, `jq` or
`python3`. No `wrangler`, no `ssh`, no browser.

Set `DSH_COMMAND=""` to land in a bare shell instead of the TUI, or `DSH_COMMAND='exec bash -l'`.
`dsh` boots from a profile under `$DSH_HOME/profiles`, and those profiles are **baked into the image**
(see [Cutover](#cutover)) — a fresh container lands in the TUI with no setup. The bare-shell override
is still there for when you want one.

## The architecture, in one paragraph

One Worker (`src/worker.ts`) fronts one Durable Object named `Sandbox` from `@cloudflare/sandbox`.
**Every request is the wake-up**: `getSandbox()` starts a stopped container on the first `exec` or
terminal call, and `sleepAfter: "5m"` stops it again after the last one — so there is no separate
start step, and no keepalive anywhere. The image (`container.Dockerfile`) is
`docker.io/cloudflare/sandbox:0.12.9` plus the shell workspace toolchain; it runs no sshd and no
health responder of its own, because the base image already carries the container runtime the
platform talks to. `/workspace` and the rest of the filesystem are **ephemeral**; the durable part is
`/mnt/state`, an R2 bucket mounted with no credentials through the Worker's `STATE` binding, and
`git` remains the source of truth for work.

| route | what it is |
|---|---|
| `GET /` | a small JSON description of the service and its routes |
| `GET /healthz` | liveness. Deliberately does not start the container |
| `POST /run` | `{"command":"..."}` → `{stdout, stderr, exitCode, success}`; 400 if `command` is missing or not a string |
| `GET /ws/terminal` | interactive terminal; requires a WebSocket upgrade |

Plus the SDK's own preview-URL proxy, which `proxyToSandbox()` answers first.

## Layout

| path | role |
|---|---|
| `dsh.sh` | the entry point: terminal attach with no argument, one command with arguments |
| `bin/dsh-client.mjs` | the local terminal client: raw-mode stdin ↔ the Sandbox terminal WebSocket |
| `src/worker.ts` | the Worker: routes, the wake-up, the R2 binding mount |
| `src/names.ts` | every identifier this Worker uses, defined once |
| `container.Dockerfile` | the image: the official sandbox base plus the workspace toolchain |
| `agent/` | the vendored agent configuration the image installs (instructions, rules, skills, profiles, ontology) |
| `agent/sync.sh` | re-vendors `agent/` from the operator's laptop, scans it, and re-pins it |
| `docs/COST.md` | what awake time costs, and the rule that follows from it |
| `docs/LLM-ROUTING.md` | the AI Gateway routing for this environment and the agency |
| `.github/workflows/deploy.yml` | builds the image and deploys, on GitHub's runners |

## Working on it

```sh
npm ci               # install from the lockfile
npm run typecheck    # wrangler types, then tsc --noEmit
npm run deploy       # wrangler deploy (builds the image; Docker required)
```

## Two things worth knowing

**Disk is ephemeral; git is not.** A sleeping container wakes with a fresh disk, so uncommitted work
is lost. Commit and push to a branch as you go. `/mnt/state` survives, because it is an R2 mount
rather than container disk.

**The terminal is currently unauthenticated — this is a real exposure.** Anyone who can reach
`wss://dev-dsh.alphaville.space/ws/terminal` gets a shell in this container, and `/run` executes any
command. Recommendation: put Cloudflare Access (or a token check in the Worker) in front of both
before this environment holds anything sensitive or is pointed at anything it should not reach.
`TERMINAL_AUTH_GATE` in `src/names.ts` is the single named place the gate will be wired in; no
mechanism has been chosen yet, deliberately.

---

# Cutover

The operator's agent instructions, rules, skills, dsh profiles and naming registry exist on one
laptop. Disk in the container is **ephemeral**, so anything not in the image is gone at the next
wake — every session would have to set itself up again, and it would not. So those files are
**committed in `agent/` and baked into the image**, and a fresh container has them with no manual
step. This section states exactly what travels and what does not.

## What travels in the image

| vendored in the repository | installed in the image | what it is |
|---|---|---|
| `agent/AGENTS.md` | `/root/.dsh/AGENTS.md` | the instruction router |
| `agent/MODEL-ROLES.md` | `/root/.dsh/MODEL-ROLES.md` | which model plays which role |
| `agent/rules/` | `/root/.dsh/rules/` | the design-ladder and research-taste rules |
| `agent/settings.yaml` | `/root/.dsh/settings.yaml` | model routing and TUI settings |
| `agent/skills/` | `/root/.agents/skills/` | the whole skill catalog — 25 skills, including `plane` |
| `agent/profiles/` | `/root/.dsh/profiles/` | the dsh profiles that make the terminal a TUI |
| `agent/ontology/` | `/root/.dsh/ontology/` | the read-only naming registry and its validator |

The install is plain declarative `COPY`. Nothing in the image moves, renames or rewrites these files
after the copy: the only `RUN` step is the profile dependency install from its frozen lockfile.

`DSH_HOME=/root/.dsh` is set in the image, and it is the parent of `profiles/`, so `dsh` finds its
profiles where this table puts them. A profile at the right path with `DSH_HOME` unset is still a TUI
that will not start, which is why both are set together.

**One skill catalog, in the conventional location.** Skills are discovered from `.agents/skills/`, so
all of them — including `plane` — are installed there and nowhere else. There is no per-agent skill
directory in this environment, and the `AGENTS.md` router invokes the Plane skill **by name** rather
than by path, because a path is both fragile and redundant when the harness discovers skills from the
catalog.

## What does not travel, and why

| not carried | why |
|---|---|
| `~/.dsh/storages/` | 215 MB of local session cache. Not configuration; it must never enter an image. |
| `~/.dsh/sessions/`, `~/.dsh/attachments/`, `~/.dsh/.agent-presets/` | local session history and state, not configuration |
| `~/.dsh/.credentials.yaml`, `~/.dsh/.anonymous-user-id` | credentials and local identity — injected at run time, never baked in |
| `*.bak*` files | they drift silently against the files they shadow |
| `node_modules/` and `.dsh-module-fallback/` under `profiles/` | thousands of files of install output; the lockfile is committed and the image rebuilds them |
| `/Users/blake/.codex/…` and every other host path | nothing outside the container exists inside it. `agent/sync.sh` rewrites the pointers, and `check-drift.sh` fails if one survives |

## What an agent finds on landing

- `dsh` is installed, `DSH_HOME=/root/.dsh`, and the terminal lands in the same TUI.
- The same `AGENTS.md` router, the same `MODEL-ROLES.md`, the same two rules, and the same 25 skills.
- Model routing points at the configured gateway (`https://api.cheaperinference.com/v1` in
  `settings.yaml`), and `settings.yaml` names its key by **environment variable**
  (`apiKeyEnv: CHEAPINFERENCE_COM_API_KEY`) and holds no value.
- The naming registry at `/root/.dsh/ontology/`, runnable offline with the `python3` already in the
  image: `python3 /root/.dsh/ontology/validate.py list`. The registry is **derived and read-only** —
  it is refreshed by `agent/sync.sh`, and editing it in place fails the drift check.

## Credentials: the opposite of configuration

An API key is **never** in this repository and **never** in the image. `CHEAPINFERENCE_COM_API_KEY`
is held as a Worker secret and handed to the sandbox at run time through the SDK's `setEnvVars`
(`ISandbox.setEnvVars` / `ExecutionSession.setEnvVars`) — not through a `COPY`, and not through an
`ENV` in the Dockerfile. `agent/sync.sh` refuses to finish if it finds a credential-shaped string in
the vendored tree, and the only literal-looking matches it reports are documentation placeholders.

## Refreshing the vendored configuration

```sh
sh agent/sync.sh      # re-copy from the operator's laptop, scan, re-pin, verify
```

`agent/sync.sh` is the way to refresh `agent/`. It copies verbatim, rewrites the laptop pointers so
nothing names a host path, runs the credential scan, re-writes the pins
(`agent/ontology/PIN.json`, `agent/skills-lock.json`), and then runs
`agent/ontology/check-drift.sh`, which fails on a credential, a host path, a stray `.codex`, an
unpinned or edited copy, or a vendored `node_modules`. Its output is reviewed and committed like any
other source change.

**The container never reads from the laptop.** A change to the vendored config takes effect only after
a rebuild and a deploy: the image carries the files, and the next wake starts from the image.