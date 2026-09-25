# The agent surface: what was broken, and what each break looked like

This file exists because every failure below presented as the *same* symptom — a request that returned
nothing — and each one had to be attributed separately. Reading this first is worth several hours.

The control surface is `POST /agent` (one reply) and `GET /agent` with a WebSocket upgrade (the same
turn as `session`/`chunk`/`done` frames). Both run one fixed program, `/usr/local/bin/agent-ask`, with
the prompt as data and no command field.

## 1. The image did not fit the instance, so no container ever started

**Symptom.** `There is no container instance that can be provided to this Durable Object, try again
later` after ~200s, on every route including `GET /ws/terminal`. The terminal returned **zero frames**.

**Why it was invisible.** `GET /healthz` answered 200 in ~300ms the whole time, because it is designed
not to touch the sandbox. The Worker, Access, and CI were all fine; only the container was gone.

**Attribution — do this before optimising anything.** Query the application the Worker actually uses:

```sh
wrangler containers list
wrangler containers info <application-id>      # configuration.disk.size_mb, health.instances
```

It returned `degraded`, `disk.size_mb: 2000`, `health { starting: 1, healthy: 0 }`: one instance
permanently starting. The image needs ~2.2 GB. `instance_type: lite` gives 2000 MB. It could never
finish booting.

**Fix.** `instance_type: basic` (1/4 vCPU, 1 GiB, 4000 MB). The app went `ready`, `healthy: 1`.

> This project has lost hours to this exact pair of numbers once before, because they belonged to an
> *orphaned* application sharing a name prefix. The check above is what distinguishes a ghost from the
> real thing — `containers info` on the live app, not a remembered name.

## 2. The alarm looped once a second

**Symptom.** `wrangler tail` showed an ALARM firing every ~1s, each with `no container instance…`.

**Why.** `Container.alarm()` re-arms itself (`setAlarm(Date.now())`) *before* running the stopping
path, so any exception thrown in that path leaves the alarm immediately due. Our `onStop` and
`stop()` threw when the container was already gone — which is the ordinary case for those hooks.

**Fix.** `stoppingHook()` and `saveWorkThenStop()` swallow that specific failure. Zero ALARM events
after.

## 3. The mount probe had no timeout, and it killed the terminal

**Symptom.** `exec` and `getSession` both `outcome=canceled` at ~29.7s; the last log line was
`terminal session ready; backing the session store` and no `session store backing:` ever followed.

**Why.** `mountpoint -q /mnt/state` was the one `exec` with no `timeout` of its own. The request died
inside it before `session.terminal()` was reached.

**Fix.** `STATE_PROBE_TIMEOUT_MS` (10s), with the documented fallback: log the store as unbacked and
open the terminal anyway.

## 4. An `exec` does not inherit the image's `ENV` — this is the big one

Three separate failures, one cause. The image sets `ENV DSH_HOME=/root/.dsh`, and the model credential
arrives through `setEnvVars`; **neither is part of an `exec`'s environment.**

| What broke | What it said |
|---|---|
| Provider never composed | `no adapter registered for provider "cf-ai-gateway"` |
| bash unusable | `sandbox backend unusable; escalation needs approval, no approval channel → fails closed` |

**Fix.** `agentEnv()` passes `HOME`, `DSH_HOME`, `CF_AI_GATEWAY_TOKEN` and `DSH_PERMISSION_MODE` on the
command itself.

**The permission one is the trap.** A patch layer setting `defaultPreset: danger-full-access` composes
correctly and changes *nothing*, because the gate reads the environment:

```yaml
- id: sandbox-policy
  config: { mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write' }
- id: approval
  config: { policy: !!js (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask' }
```

Unset → `workspace-write` + `ask` → no approval channel → every command fails closed. Set
`DSH_PERMISSION_MODE=danger-full-access`.

## 5. The implicit default session hangs; a named one does not

**Symptom.** The route returned nothing for 150s, on both streams, and the `exec` outlived its own
120s timeout.

**Attribution.** From `wrangler tail`, the split was not "container calls fail" but which session they
land in: `getSession("dsh")` **resolved**; `exec` and `writeFile` both **canceled**. Both of those land
in the SDK's implicit default session.

**Fix.** Run the command in an explicitly named session (`AGENT_SESSION`). The terminal has always
named its session, and the terminal has always worked.

## 6. Shell injection on the one route built to prevent it

The prompt reached the container as `JSON.stringify(prompt)` inside a command line. Inside double
quotes the shell still expands `$(...)` and backticks — so a prompt could execute. It is now a base64
payload (`[A-Za-z0-9+/=]`, inherits nothing), piped into a file by the same `exec`.

`writeFile` was tried first and **hangs** in this container (`RPC writeFile canceled 69010ms`).

## 7. Nothing primed the workspace

`dsh-session` runs `dsh-prime` before the TUI; the agent route did not, and the first real turn
reported it plainly: *"/workspace contains only my probe file. No agency repo."* The route now primes,
skipping when `/workspace/agency` exists, with **every byte on stderr** — on stdout it would be
concatenated into `text`.

## What works now, and what is left

Verified: `echo SHELL-OK`; `/workspace` → `agency reference-implementation tooling`; `git log` →
`7529b67`; a 4-command turn in 42s; prime output on stderr with a clean reply on stdout.

Persistence, verified on the terminal path and **not** by config:

```
[restored conversations from R2 into /root/.dsh/sessions]
  1 stored, newest first: session-2ef154ed-… 18829 bytes
[workspace ready: 3 entries in /workspace]
[brief from /workspace/agency/docs: GOALS.md + HANDOVER.md is ready for this session]
```

**The remaining blocker is spend, not engineering.** Outside the reserved block the router picks
`custom-cheapinference` (the pay-per-token wallet) and a goal-sized turn answers
`402 Insufficient wallet balance`. The provider is visible in the response headers as
`cf-aig-provider`. Inside the block it is already paid for. The reserved hours are read from
CheapestInference's billing API; the block in force is 08:00–16:00 UTC (18:00–02:00 Brisbane).

Funding the wallet is the operator's decision (`AGENTS.md`: a wallet spend needs confirmation first).
Until it is funded, drive the surface inside the block.