# Instructions for an agent working in this workspace

This repository is the **dsh developer environment** — a Cloudflare Container reached with
`./dsh.sh`. It is not the agency, and the agency must never depend on it.

## Resource discipline

This box is deliberately small (`lite`: 1/16 vCPU, 256 MiB) and deliberately disposable. **Disk is
ephemeral**: a sleeping container wakes with a fresh image, so `/workspace` and everything else
outside `/mnt/state` is gone. Anything that must survive belongs in git, not here. Do not treat the
filesystem as durable storage, because it is not.

## The container sleeps, by design — do not keep it awake

The container stops **5 minutes after its last request** (`sleepAfter`, set in `src/worker.ts`).
**There is no heartbeat process, and that is deliberate.** An agent must not create one: no
`while true` loop, no `curl` on a timer, no polling `GET /healthz` to stay alive, no "keepalive"
service. A loop like that converts "cost while I work" into "cost while I live", and it is the defect
this environment was rebuilt to remove. `docs/COST.md` has the arithmetic — read it before arguing
with this.

Expect to be shut down whenever you are idle, and expect `./dsh.sh` to wake you again. Waking is
free and automatic: the request that opens the terminal is the wake-up.

## If you are an agent working autonomously here

- **Do not hold the session open to appear busy.** Idle time is billed as awake time.
- **Long work belongs in a job with its own lifecycle.** This is an interactive workspace, not a
  batch host. Anything that runs for hours belongs somewhere with its own schedule and its own
  sleep policy, not in a container sized for a shell.
- **Commit before you stop.** Ephemeral disk means uncommitted work is lost on the next sleep, and
  the sleep is not announced.
- **Push to a branch as you go.** Treat every moment as though the machine could vanish, because on
  this one it can.

## Handling secrets

Never commit a credential and never bake one into the image (`container.Dockerfile`). Non-secret
configuration — instructions, toolchain declarations — belongs in the image as a committed file so
it is reproducible and reviewable. Live credentials are injected at runtime from Worker secrets.

**The workspace is currently unauthenticated.** Anyone who can reach the terminal URL gets a shell
here. Do not treat this box as a secret store, and see the finding in `README.md` before putting
anything sensitive in it.