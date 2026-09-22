# dsh-workspace

**The developer's remote workspace. Not the agency.** It may disappear without affecting
production, and the agency must never depend on it.

A Cloudflare Container you reach with `./dsh.sh`. **No public port exists** — access is
`wrangler containers ssh`, authenticated against the Cloudflare account with the ed25519 key in
`wrangler.jsonc`. There is no Tailscale, no tunnel and no open port, because there is nothing to
protect: the shell is not listening anywhere the internet can reach.

## Use it

```sh
./dsh.sh              # the harness TUI, as if it were local
./dsh.sh uname -a     # run one command and exit
```

That is the whole interface. `dsh.sh` wakes the container if it is stopped, waits for it to report
healthy, then opens the session.

## Why the wake is in `dsh.sh`

`wrangler containers ssh` does **not** start a stopped container — documented behaviour, not an
oversight — and an idle SSH connection does not keep one alive either. So something has to ask for
it. Any request to the Worker starts it, and `dsh.sh` makes that request before connecting. A
separate "start" step would be a step that gets forgotten.

## Cost, and why it is small

| | |
|---|---|
| instance | `lite` — 1/16 vCPU, 256 MiB, 2 GB disk |
| `sleepAfter` | **5 minutes** after the last request |
| billed | only while running; CPU on active usage only |
| idle | **$0** — a stopped container costs nothing but the image |

The container shuts itself down when you stop working. While you are attached, the image polls the
Worker's `/healthz` once a minute, which counts as activity and holds it open; when the last session
disconnects the polling stops and it goes to sleep.

## Layout

| path | role |
|---|---|
| `dsh.sh` | wake and connect — the entry point |
| `container.Dockerfile` | Alpine, the toolchain, sshd and a health responder |
| `keepalive.sh` | sshd, the HTTP responder the platform health-checks, and the session keepalive |
| `src/worker.ts` | the Worker: a health endpoint, and waking the container on any other request |
| `wrangler.jsonc` | the container, the SSH key, and the `dsh.alphaville.space` route |
| `.github/workflows/deploy.yml` | builds the image and deploys, on GitHub's runners |

**Everything builds and deploys in CI.** Nothing about this repository requires anything installed on
a particular laptop: GitHub's runners have Docker and install the dependencies from the lockfile.

## Two things worth knowing

**Disk is ephemeral.** A sleeping container wakes with a fresh disk, so the image carries the
toolchain and **git carries the state**. That is an honest fit for an agent workspace and a poor one
for anything that must persist.

**The image runs two listeners, and both are needed.** The `Container` class health-checks an HTTP
`pingEndpoint` during startup, and `sshd` cannot answer it — it does not speak HTTP. A small
responder on 8080 satisfies the check; sshd on 22 serves the session. Without the responder the
start fails and the Worker throws, which is exactly how this was found.
