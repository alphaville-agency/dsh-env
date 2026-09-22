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
./dsh.sh --takeover      # take the input lease from whoever holds it, and start typing
./dsh.sh uname -a        # one command, its output back here, exit code preserved
./dsh.sh 'git log -1'    # quoting works the same way
```

`./dsh.sh` starts the container, attaches your terminal to the workspace over the Sandbox terminal
WebSocket, and drops you into the `dsh` TUI. It **starts when you connect** and the container
**sleeps 5 minutes after the last work stops**; [`docs/COST.md`](docs/COST.md) is the arithmetic, and
explains why nothing in this repo is allowed to heartbeat.

### One session, one pair of hands

Open `./dsh.sh` in a second window and it attaches **live but read-only**: it shows the same output
as it happens and says, on screen, that nothing you type is being sent and who holds the input
lease. `./dsh.sh --takeover` takes the lease from whoever has it — they are told at once, on the
spot, and drop to read-only. There is no silent state: a window either may type or tells you it may
not, and a window that loses the lease mid-session says so immediately.

The lease lives in a Durable Object, so it is genuinely one lease across every Worker isolate and
region, and it survives hibernation. It is released the moment the holder disconnects cleanly, and
lapses after ten minutes of silence if a client is killed rather than closed — so an abandoned
session cannot lock everyone else out.

Requires Node 22 or newer (for the built-in `WebSocket`) and, for the one-shot path, `jq` or
`python3`. No `wrangler`, no `ssh`, no browser.

Set `DSH_COMMAND=""` to land in a bare shell instead of the TUI, or `DSH_COMMAND='exec bash -l'`.
`dsh` boots from a profile under `$DSH_HOME/profiles`. The profile **manifests** are committed in
`.dsh/profiles/` and its **dependency tree** is installed into the durable state mount on the first
run, not baked into the image (see [First run](#first-run) and [Image size](#image-size-and-what-was-cut)).
A warm container has it and lands straight in the TUI; the bare-shell override is still there for when
you want one.

## The architecture, in one paragraph

One Worker (`src/worker.ts`) fronts two Durable Objects: `Sandbox` from `@cloudflare/sandbox`, and
`DshLease`, which owns the input lease, the awake lease, and the one upstream terminal socket.
**Every request is the wake-up**: `getSandbox()` starts a stopped container on the first `exec` or
terminal call, and `sleepAfter: "5m"` stops it again after the last one — so there is no separate
start step, and no keepalive anywhere.

The `DshLease` object is what makes read-only observers possible. It terminates the WebSocket
upgrade rather than passing it through, holds a single socket to the container's PTY, and hands each
client its own — so it can drop input from everyone except the lease holder while still forwarding
every byte of output to all of them. The image (`container.Dockerfile`) is
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
| `GET /ws/terminal` | interactive terminal; requires a WebSocket upgrade. `?client=<id>` names the client, `?takeover=1` takes the input lease |
| `POST /work` | `{"action":"begin"}` → `{token, until}`, `{"action":"end","token":"..."}`. Declares work in progress so the container is not slept out from under it |

Plus the SDK's own preview-URL proxy, which `proxyToSandbox()` answers first.

## Layout

| path | role |
|---|---|
| `dsh.sh` | the entry point: terminal attach with no argument, one command with arguments |
| `bin/dsh-client.mjs` | the local terminal client: raw-mode stdin ↔ the Sandbox terminal WebSocket |
| `bin/dsh-provision.sh` | the image's first-run provisioner: installs the dependency trees into the state mount |
| `bin/dsh-state.sh` | populate the harness home from the state-mount clone, and install the skill catalog |
| `src/worker.ts` | the Worker: routes, the wake-up, the R2 binding mount, container preparation |
| `src/lease-do.ts` | the `DshLease` Durable Object: the two leases, the fan-out, and preparation before the PTY |
| `src/leases.ts` | both lease state machines, pure and testable with no Durable Object |
| `src/names.ts` | every identifier this Worker uses, defined once |
| `tests/leases.test.mjs` | the lease rules, run by Node's own test runner |
| `tests/dockerfile.test.mjs` | every `COPY` source exists, and what was cut stays cut |
| `container.Dockerfile` | the image: the official sandbox base plus the workspace toolchain |
| `.dsh/` | the harness home the image installs (instructions, rules, settings, ontology, profile manifests) |
| `.agents/` | the skill catalog manifest (`skills.json`) and the local-only skills |
| `dsh-install/` | the committed manifest and lockfile for the harness CLI |
| `tools/` | repo-side tooling for the operator's laptop (`sync.sh`, `check-drift.sh`) |
| `docs/COST.md` | what awake time costs, and the rule that follows from it |
| `docs/LLM-ROUTING.md` | the AI Gateway routing for this environment and the agency |
| `.github/workflows/deploy.yml` | builds the image and deploys, on GitHub's runners |

## Working on it

```sh
npm ci                          # install from the lockfile
npm run typecheck               # wrangler types, then tsc --noEmit
mise run test                   # node --test 'tests/**/*.test.mjs'
npm run deploy                  # wrangler deploy (builds the image; Docker required)
```

The lease tests cover the pure state machines in `src/leases.ts` — grant, refusal, takeover,
supersession, TTL expiry, clean release, and the independence of "who may type" from "is work
happening". `tests/dockerfile.test.mjs` covers the image's contract with the repository: every
`COPY` source exists (a previous commit shipped one that did not, and no local check could see it),
what was deliberately cut stays cut, and the apt archives are purged in the layer that fetches them.
Neither file needs a container, a Durable Object or a network.

## Two things worth knowing

**Idle means no work in progress, not no keystrokes.** An agent working toward a goal with nobody
attached is active and keeps the container awake, by declaring it with `POST /work`; an attached but
abandoned window is idle and does not. Two messages per unit of work, never a ping — see
`AGENTS.md`. A declaration whose `end` is never sent lapses after two hours rather than pinning the
workspace awake.

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

# Image size, and what was cut

Cloudflare refuses an image over the **2000 MB** that comes with the `lite` instance. Docker's own
measurement of this image was **1572 MB** (`docker image inspect .Size`), and the platform reported
**2250 MB** for the same build — a ratio of **~1.43**. The platform appears to count the compressed
transfer payload alongside the uncompressed image. That is a hypothesis from two consistent
cross-checks, not a proof, and it is not needed to act on: the rule it gives is **every 1 MB of
content cut moves the platform's number by ~1.43 MB**, so the budget has to be generous.

| cut | content | *projected* platform |
|---|---|---|
| `mise` (installed, provided nothing — `[tools]` was empty) | −135 MB | −193 MB |
| `rclone` (kept for a state sync the R2 mount replaced) | −40 MB | −57 MB |
| `@deepseek-ai/dsh` `npm ci` tree → installed into state on first run | −290 MB | −415 MB |
| dsh TUI profile `node_modules` → installed into state on first run | −108 MB | −154 MB |
| apt `.deb` archives kept by the base image's `Keep-Downloaded-Packages "true"`, purged in the layer that fetched them | −299 MB | −428 MB |
| npm cache left by the old `/opt/dsh-install` layer (gone with that layer) | −75 MB | −107 MB |

**Every figure above is a projection, not a measurement.** There is no Docker on the machine this was
written on, so nothing here was built and nothing here was re-measured. What *was* measured, by a CI
diagnostic on the runner, is the starting point (1572 MB by `docker image inspect .Size`, 2250 MB as
Cloudflare reported it, and each component size in the table, including the 299.2 MB of apt archives).
The rest is arithmetic: the cuts total **≈947 MB of content**, which lands at **≈625 MB by Docker's
own measurement**, and — applying the same 1.43 straight-line — **≈890 MB on the platform's scale**.

That last number is a *projection from a ratio*, and it is the least reliable figure in this
document. Compression does not move in lockstep with content, and the 593 MB base image is unchanged
and undivided, so the real result will not be exactly 890. It does not need to be: the projected
figure clears the 2000 MB limit by a factor of two, and the whole point of cutting this much is that
the one part of the accounting nobody has proven cannot undo it. **The only way to know is to run
`.github/workflows/image-report.yml` on the next commit.**

Two cuts that were on the list and were **not** taken:

- **Non-Linux prebuilds and wasm fallbacks inside the dsh tree (~32 MB).** They were an image-size fix
  for a tree that was baked in. The tree is now in the state mount, so pruning them would reduce R2
  storage and nothing else, at the cost of a real chance of breaking the harness on a platform the
  pruning did not anticipate. Not worth it for zero image bytes.
- **`make`, `gnupg`, `python3-pip`, `python3-venv`, `tmux`, `less`.** Each was checked and each is
  load-bearing for an interactive shell. `python3` and `gh` stay for the same reason. This is an
  interactive environment: removing a tool somebody needs later costs more than the single-digit MB it
  saves, and the 299 MB of apt archives was the real saving in that layer all along.

# First run

The image is the **toolchain**; the workspace is the **state**. `dsh` and the TUI profile are node
dependency trees — derived data, regenerable from committed lockfiles — so they are not in the image.
They are installed into `/mnt/state` (the R2 binding mount) on the first run, once, and never again.

## The order, which is the whole design

Nothing may run before the state mount is ready, because the install *targets* the mount. On a
container that has just been recreated, and only then, the Worker and the Durable Object run one
sequence, in this order:

1. **`mountBucket(STATE, /mnt/state)`** — the mount is the state. Everything below writes into it.
   This is also the one-shot trigger: the SDK tracks active mounts in the Durable Object, so a warm
   container answers *"already in use"* and the sequence stops there. No flag, no poll, no clock.
2. **`dsh-provision`** — ships in the image, and runs before the clone exists because it installs the
   trees the clone's lockfiles describe. `npm ci` for the harness CLI into
   `/mnt/state/repo/dsh-install`, and `pnpm install --prod --frozen-lockfile` for each profile under
   `/mnt/state/repo/.dsh/profiles/`.
3. **`dsh-state ensure`** — lives in the clone, so it cannot run before the clone exists. It clones
   the repository into the mount, symlinks every entry of the clone's `.dsh/` into `/root/.dsh`
   (`profiles/` included), and installs the skill catalog named by `.agents/skills.json`.

The `dsh` paths are `dsh-state` in the clone and `dsh-provision` in the image. That is not
arbitrary: the provisioner has to exist *before* the clone, and the clone-linking script can only
exist *inside* it.

Both terminal paths run the sequence: `POST /run` prepares the container, and the terminal attaches
through `DshLease`, which prepares it **before** opening the PTY — the terminal bootstraps `exec dsh`
the instant it is up, so on a fresh container that binary has to exist by then. Both check the mount
first, so the second one through in the same wake pays one "already in use" round trip and does
nothing else.

**No daemon, no poll, no timer, no background work.** It is one foreground command with a beginning
and an end, repeated only because a request asked for it. See `docs/COST.md`: a loop here would turn
"cost while I work" into "cost while I live", which is the defect this environment was rebuilt to
remove.

## How it is cached, and what a warm start does

The marker is `/mnt/state/.provisioned` — inside the mount, so it survives a wake. A warm start finds
it and does **no network and no install**: a handful of `test -x` calls and the sequence returns.

The marker is an accelerator, not the truth. The install counts as complete when the **artifacts**
exist — the `dsh` binary and a `node_modules` in every profile. A store that lost them (a mount that
came back empty, an interrupted install) is repaired on the next wake instead of trusted, and says so
when it does. `dsh-state status` prints exactly which of these are present.

## When the registry is unreachable

**The container comes up anyway.** That is the requirement the whole design is arranged around: a
container that refuses to start because npm was down is far worse than one without the TUI.

- Every exit code of the sequence is deliberately ignored (`|| true`), and every failure is printed.
- `dsh-provision` names what failed and the exact retry command in the message, and exits non-zero
  without stopping anything.
- The terminal still opens. `dsh` will not be there, so the shell reports it; `dsh-state status` says
  which tree is missing; `dsh-provision` (or `dsh-state refresh`) retries.
- The client prints a one-line notice if the terminal has not come up after ~2.5 s, so a first-run
  install reads as *"this is installing"* rather than *"this is hung"*.

## The one thing that could not be verified

The dependency trees live on the s3fs mount, and file **contents** are not cached locally by the mount
options the SDK sets (`stat_cache_expire=60`, `enable_noobj_cache`, `multipart_size=5`, no
`use_cache`). Whether the TUI loads its bundles over s3fs fast enough was not measurable without a
container. If it proves too slow, the upgrade path is to copy the (derived, regenerable) tree onto
ephemeral disk at provision time — and the mount option that would fix it is `use_cache`, which is
unverified and trades container disk for speed.

# Cutover

The operator's agent instructions, rules, skills, dsh profile manifests and naming registry exist on
one laptop. Disk in the container is **ephemeral**, so anything not in the image and not in the mount
is gone at the next wake — every session would have to set itself up again, and it would not. So the
instructions and configuration are **committed under `.dsh/` and `.agents/` and baked into the
image**, and the dependency trees are **installed into the mount on first run**. This section states
exactly what travels, what is installed, and what does not.

## What travels in the image

| committed in the repository | installed in the image | what it is |
|---|---|---|
| `.dsh/AGENTS.md` | `/root/.dsh/AGENTS.md` | the instruction router |
| `.dsh/MODEL-ROLES.md` | `/root/.dsh/MODEL-ROLES.md` | which model plays which role |
| `.dsh/rules/` | `/root/.dsh/rules/` | the design-ladder and research-taste rules |
| `.dsh/settings.yaml` | `/root/.dsh/settings.yaml` | model routing and TUI settings |
| `.agents/local/` | `/root/.agents/skills/` | the three skills that exist only here (`plane`, `alphaville`, `cmo`) |
| `.dsh/ontology/` | `/root/.dsh/ontology/` | the read-only naming registry and its validator |
| `bin/dsh-provision.sh` | `/usr/local/bin/dsh-provision` | the first-run provisioner, symlinked onto `PATH` |
| `bin/dsh-state.sh` | `/usr/local/bin/dsh-state` | clone-linking and the skill catalog, symlinked onto `PATH` |

This part is plain declarative `COPY` plus one `chmod`: nothing in the image moves, renames or
rewrites these files after the copy, and there is no `RUN` that installs anything.

## What is installed on first run, not carried

| committed in the repository | installed into the mount | what it is |
|---|---|---|
| `dsh-install/package.json` + `package-lock.json` | `/mnt/state/repo/dsh-install/node_modules` | the harness CLI, by `npm ci` |
| `.dsh/profiles/*/` | `/mnt/state/repo/.dsh/profiles/*/node_modules` | the TUI and web profiles, by pnpm from the frozen lockfile |
| `.agents/skills.json` | `/root/.agents/skills/` | the manifest; the catalog itself is fetched by the Skills CLI |

The lockfiles are what make this reproducible, and they stay in the repository. They are not optional:
`@deepseek-ai/dsh` is currently **uninstallable without the `overrides` pin** in
`dsh-install/package.json`, because a transitive
`@deepseek-ai/dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3` was never published. That is a
workaround for an upstream packaging defect, not a preference, and the ceiling is that the manifest
must be revisited when upstream republishes.

**The profile install honours `pnpm-lock.yaml` only if pnpm runs.** The previous image tested for
`corepack` with `command -v`, and this base image does not put `corepack` on `PATH` — so every build
silently took the npm fallback and ignored the lockfile, while the comment claimed otherwise. The
provisioner now resolves corepack through `npm root -g` as well as `PATH`, and the image makes it
reachable; when pnpm genuinely cannot run, the fallback still installs from the manifest with npm and
**says so in as many words**, because a silent fallback that claims reproducibility is the defect.

`DSH_HOME=/root/.dsh` is set in the image. `profiles/` is a **symlink** into the mount, created by
`dsh-state`, not a directory in the image: a profile at the right path with `DSH_HOME` unset is still
a TUI that will not start, which is why both are set together.

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
| `node_modules/` and `.dsh-module-fallback/` under `profiles/` | thousands of files of install output; the lockfile is committed and the tree is installed into the state mount on first run |
| `~/.dsh/storages/`, `sessions/`, `attachments/` | local session state, hundreds of MB; never configuration and never an image |
| `/Users/blake/.codex/…` and every other host path | nothing outside the container exists inside it. `tools/sync.sh` rewrites the pointers, and `tools/check-drift.sh` fails if one survives |

## What an agent finds on landing

- `dsh` is installed — into the state mount on the first run, from a committed lockfile — with
  `DSH_HOME=/root/.dsh`, and the terminal lands in the same TUI.
- The same `AGENTS.md` router, the same `MODEL-ROLES.md`, the same rules, and the same skill
  catalog: the three local-only skills ride in the image, the rest are deployed from `apm.yml` into
  the clone's `.agents/skills/`.
- Model routing points at the configured gateway (`https://api.cheaperinference.com/v1` in
  `settings.yaml`), and `settings.yaml` names its key by **environment variable**
  (`apiKeyEnv: CHEAPINFERENCE_COM_API_KEY`) and holds no value.
- The naming registry at `/root/.dsh/ontology/`, runnable offline with the `python3` already in the
  image: `python3 /root/.dsh/ontology/validate.py list`. The registry is **derived and read-only** —
  it is refreshed by `tools/sync.sh`, and editing it in place fails the drift check.

## Credentials: the opposite of configuration

An API key is **never** in this repository and **never** in the image. `CHEAPINFERENCE_COM_API_KEY`
is held as a Worker secret and handed to the sandbox at run time through the SDK's `setEnvVars`
(`ISandbox.setEnvVars` / `ExecutionSession.setEnvVars`) — not through a `COPY`, and not through an
`ENV` in the Dockerfile. `tools/sync.sh` refuses to finish if it finds a credential-shaped string in
the vendored tree, and the only literal-looking matches it reports are documentation placeholders.

## Refreshing the vendored configuration

The agent configuration — skills, rules and instructions — is declared in `apm.yml` and deployed
under `.agents/skills/`. **That migration is in flight and is not mine to finish:** `apm.yml` names
its sources under `.apm/`, `.agents/local/` is empty, and `tools/sync.sh` / `tools/check-drift.sh`
still describe the layout that came before it. The image installs the three local-only skills from
`.apm/local/` (see the `COPY` in `container.Dockerfile`), which is where they live now and what
makes the image resolvable today. Whoever lands the migration should reconcile the two rather than
leave both paths load-bearing.

**The container never reads from the laptop.** A change to the vendored config takes effect only after
a rebuild and a deploy: the image carries the files, and the next wake starts from the image.