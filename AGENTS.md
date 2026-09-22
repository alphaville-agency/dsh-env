# Instructions for an agent working in this workspace

This repository is the **developer workspace** — a Cloudflare Container reached with `./dsh.sh`. It
is not the agency, and the agency must never depend on it.

## Resource discipline

This box is deliberately small (`lite`: 1/16 vCPU, 256 MiB) and deliberately disposable. **Disk is
ephemeral**: a sleeping container wakes with a fresh image, so anything that must survive belongs in
git, not here. Do not treat the filesystem as durable storage, because it is not.

## Sessions shut themselves down

The container sleeps five minutes after its last incoming request. `keepalive.sh` renews while the
terminal is active, and **stops renewing after `DSH_IDLE_TIMEOUT` (default 30 minutes) of no terminal
activity** — so an attached but abandoned session does not hold the box open. Expect to be shut down
if you are idle, and expect `./dsh.sh` to wake you again.

## If you are an agent working autonomously here

- **Do not hold the session open to appear busy.** An idle session that keeps renewing defeats the
  shutdown policy and spends money for nothing.
- **Commit before you stop.** Ephemeral disk means uncommitted work is lost on the next sleep, and
  the sleep is not announced.
- **Long work belongs elsewhere.** This is an interactive workspace, not a batch host. Anything that
  runs for hours belongs in a job with its own lifecycle, not in a container sized for a shell.
- **Push to a branch as you go.** Treat every moment as though the machine could vanish, because on
  this one it can.
