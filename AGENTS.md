# Instructions for an agent working in this workspace

This repository is the **dsh developer environment** — a Cloudflare Container reached through a
Worker. It is not the agency, and the agency must never depend on it.

## Where this is: the floor

**Two routes are all that exist, and both are proven with real output** (README.md has the curl):

- `GET /healthz` — liveness, and it deliberately does not start the container
- `POST /run` — runs one command in the container and returns `{stdout, stderr, exitCode, success}`

Everything else this workspace was designed to have — the input/awake lease Durable Object, the R2
mount at `/mnt/state`, the first-run provisioner, the terminal and its client, the skills installer,
APM — is parked on the **`archive/pre-floor-design`** branch. It is not deleted, and it is not
coming back in bulk: it comes back one layer at a time, each verified against a working `/run`
before the next one is added, and the first layer that breaks is where it stops.

Do not describe a parked layer as working, and do not build on one. The reason all of it was parked
is in README.md: not one command had ever executed in this container, so none of it had ever been
observed to work.

## Resource discipline

This box is deliberately small (`lite`: 1/16 vCPU, 256 MiB) and deliberately disposable. **Disk is
ephemeral**: a sleeping container wakes with a fresh image, so the filesystem outside a durable
mount is gone. Anything that must survive belongs in git, not here. Do not treat the filesystem as
durable storage, because it is not.

## The container sleeps, by design — and nothing may vote against that

The container stops **5 minutes after its last activity** (`sleepAfter`, set in `src/names.ts`).
That is the entire cost control, and it is not negotiable from inside:

- **Nothing polls.** No `while true` loop, no `curl` on a timer, no polling `GET /healthz` to stay
  alive, no "keepalive" service, no daemon. A loop like that converts "cost while I work" into "cost
  while I live", and it is the defect this environment exists to avoid. `docs/COST.md` has the
  arithmetic — read it before arguing with this.
- **`/healthz` must never touch the sandbox.** A probe that wakes a container is a heartbeat by
  another name.
- **Waking is free and automatic.** A request to `/run` starts a stopped container; there is no
  separate start step to forget and no process needed to keep it alive.
- **Commit before you stop.** Ephemeral disk means uncommitted work is lost on the next sleep, and
  the sleep is not announced.

When the awake lease comes back it will be the *only* thing permitted to extend `sleepAfter`, and
only while something inside the container declares that work is in progress.

## Handling secrets

Never commit a credential and never bake one into the image (`container.Dockerfile`). Non-secret
configuration — instructions, toolchain declarations — belongs in the image as a committed file so
it is reproducible and reviewable. Live credentials are injected at runtime from Worker secrets, or
from the account's Secrets Store via its binding.

**There is no authentication on this Worker.** At the floor it runs whatever command it is given, so
anyone who can reach `https://dsh.alphaville.space` can run a command in this container. That is a
recorded finding, not an oversight — see "The unauthenticated Worker" in README.md. Do not put
anything sensitive in this box.
