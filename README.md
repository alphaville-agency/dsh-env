# dsh developer environment

This repository is the **dsh developer environment**: a Cloudflare Container, driven through the
official Cloudflare Sandbox SDK, that provides the working environment for agents and the operator.

It is **not the agency**, and the agency must never depend on it — it may disappear without affecting
production. The clean-slate build will be done *from inside this environment* once it is verified.

## Use it

Open a terminal on your Mac and run:

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
`dsh` boots from a profile under `$DSH_HOME/profiles`; until the environment is primed with one, the
bare-shell override is the way in.

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