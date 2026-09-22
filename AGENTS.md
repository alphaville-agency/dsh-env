# Instructions for an agent working in this workspace

This repository is the **dsh developer environment** — a Cloudflare Container reached with
`./dsh.sh`. It is not the agency, and the agency must never depend on it.

## Resource discipline

This box is deliberately small (`lite`: 1/16 vCPU, 256 MiB) and deliberately disposable. **Disk is
ephemeral**: a sleeping container wakes with a fresh image, so `/workspace` and everything else
outside `/mnt/state` is gone. Anything that must survive belongs in git, not here. Do not treat the
filesystem as durable storage, because it is not.

## The container sleeps, by design — but working is not idle

The container stops **5 minutes after its last activity** (`sleepAfter`, set in `src/worker.ts`).
Idle is defined as **no work in progress**, not as "no keystrokes":

- **An agent working toward a goal is active, and the container is kept awake for it — whether or
  not a human is present and whether or not any client is attached.** Running tools, making model
  calls and editing files is work. It declares that with `POST /work` (see below) and the workspace
  holds `keepAlive` until the declaration ends.
- **A session with no work in progress is idle**, and the container sleeps on the normal
  `sleepAfter`. An attached-but-abandoned terminal is idle: an open window is not work.
- **Nothing polls.** There is no heartbeat process, and that is deliberate: no `while true` loop, no
  `curl` on a timer, no polling `GET /healthz` to stay alive, no "keepalive" service. A loop like
  that converts "cost while I work" into "cost while I live", and it is the defect this environment
  was rebuilt to remove. `docs/COST.md` has the arithmetic — read it before arguing with this.

### Declaring work

If you are an agent working inside the container without a human driving the terminal, bracket the
work — the workspace cannot otherwise tell "thinking hard" from "nobody here":

```sh
TOKEN=$(curl -sS -X POST https://dev-dsh.alphaville.space/work \
  -H 'content-type: application/json' -d '{"action":"begin"}' | jq -r .token)

# ... do the work ...

curl -sS -X POST https://dev-dsh.alphaville.space/work \
  -H 'content-type: application/json' -d "{\"action\":\"end\",\"token\":\"$TOKEN\"}"
```

Two messages per unit of work, not a ping every 30 seconds. If the `end` is never sent — a crash —
the declaration lapses on its own deadline (two hours) and the container sleeps as usual, so a
forgotten signal costs at most that window rather than pinning the workspace awake forever.

Expect to be shut down whenever **no work is in progress**, and expect `./dsh.sh` to wake you again.
Waking is free and automatic: the request that opens the terminal is the wake-up.

## If you are an agent working autonomously here

- **Work with no human attached is active, not idle.** Declare it with `POST /work` as above, and the
  container stays up for it. Do not substitute a keepalive loop for the declaration.
- **An open terminal window is not work.** Attaching and then walking away is idle, and the workspace
  will sleep.
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