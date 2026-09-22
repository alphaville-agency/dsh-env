# dsh developer environment

This repository is the **dsh developer environment**: a Cloudflare Container, driven through a
Cloudflare Worker, that an agent or the operator works in. It is **not** the agency. Nothing in
production may depend on it, and it may disappear at any moment.

Its logical ID is `shared.tooling.dsh.shell`. `system=tooling` is what makes it a *development*
environment; `env=shared` is what records that it is **not tiered** — there is one of these, and it
serves the agency's dev, stg and prod work alike. There is no `stg-dsh` and no `dsh` to go with it.

---

## Status: the floor, and only the floor

For its whole history this Worker had **never executed a single command end to end**. An hour of work
went into image size, leases, provisioning, persistence, terminals and skills on top of a `/run` that
returned `error code: 1101`. All of it was unverified, because the thing underneath it had never run.

That layer is now parked on the **`archive/pre-floor-design`** branch, and this tree is the floor:

| Route | What it does |
|---|---|
| `GET /healthz` | Liveness. **Does not start the container** — a probe that wakes it is a heartbeat by another name. |
| `POST /run` | Runs one command via `sandbox.exec(...)` and returns `{stdout, stderr, exitCode, success}`. |

That is the entire Worker. Nothing else is deployed: no lease Durable Object, no R2 mount, no
provisioner, no symlinks, no terminal, no skills installer, no APM, no bootstrap.

The next layers come back one at a time, each verified against a working `/run` before the next is
added, and the tree stops at the first layer that breaks. See "What comes back, and in what order".

## The floor is proven, with output

Every line below is a real response from `https://dsh.alphaville.space`, made after the floor deploy
(CI run 35704957777). Nothing here is a description of what the code should do.

```
$ curl -sS https://dsh.alphaville.space/healthz
{"ok":true,"service":"shared-tooling-dsh-shell"}                                  [HTTP 200]

$ curl -sS -X POST https://dsh.alphaville.space/run \
    -H 'content-type: application/json' -d '{"command":"echo hello from the container"}'
{"stdout":"hello from the container","stderr":"","exitCode":0,"success":true}     [HTTP 200, 5.3s cold]

$ curl -sS -X POST .../run -d '{"command":"whoami; uname -srm; node --version; pwd"}'
{"stdout":"root\nLinux 6.18.36-cloudflare-firecracker-2026.6.17 x86_64\nv22.23.2\n/workspace",
 "stderr":"","exitCode":0,"success":true}

$ curl -sS -X POST .../run -d '{"command":"ls /definitely-not-here"}'
{"stdout":"","stderr":"ls: cannot access '/definitely-not-here': No such file or directory",
 "exitCode":2,"success":false}                       # a real exit code, not a synthesised failure

$ curl -sS -X POST .../run -d '{"command":""}'
{"error":"command must be a non-empty string"}                                    [HTTP 400]
```

**It sleeps and it wakes.** Four requests, with the container's own boot id and `/proc/uptime` as the
witness, and 400 seconds of silence in the middle (`sleepAfter` is 5 minutes):

| when | boot id | uptime | latency |
|---|---|---|---|
| 08:36:59Z | `5f2b2131…` | 106s | 0.57s |
| 08:37:03Z | `5f2b2131…` | 110s | 0.43s |
| *…400s with no requests…* | | | |
| 08:43:44Z | **`95d7780d…`** | 167s | **4.95s** |
| 08:43:59Z | `95d7780d…` | 179s | 1.91s |

A different boot id serves the request after the quiet period, its uptime has reset, and the request
cost 4.95s against 0.43s warm: the container **stopped and came back**, and it came back on a
request rather than on a timer. Two requests 15s apart share the new boot id and their uptimes
advance together, so that is one instance, not two.

*Not proven by this, stated plainly:* the fresh instance's uptime was already 88s and 167s in two
runs, so it existed for tens of seconds before the first post-quiet request arrived. I did not
determine what starts it at that moment — only that it is a different container each time and that
no timer or daemon of ours is involved. The exact stop instant is the platform's business.

## The contract

```sh
curl -sS https://dsh.alphaville.space/healthz
# {"ok":true,"service":"shared-tooling-dsh-shell"}

curl -sS -X POST https://dsh.alphaville.space/run \
  -H 'content-type: application/json' \
  -d '{"command":"echo hello from the container"}'
# {"stdout":"hello from the container\n","stderr":"","exitCode":0,"success":true}
```

A request **is** the wake-up: `getSandbox()` starts a stopped container on first use, so there is no
separate start step to forget and nothing needs to run inside the container to keep it alive. The
container stops `sleepAfter` (5 minutes, `src/names.ts`) after the last request, and a stopped
container costs nothing.

## The 1101, and what it actually was

`wrangler tail` while making the request, and the real stack was:

```
POST https://dev-dsh.alphaville.space/run - Exception Thrown
Error: InvalidMountConfigError: R2 binding mounts require exporting ContainerProxy from the Worker entrypoint
    at async ensureStateMounted (worker.js:18623:5)
    at async prepareContainer (worker.js:18633:8)
    at async runCommand (worker.js:18648:3)
    at async Object.fetch (worker.js:18701:46)
```

The misleading part: the Worker **did** export `ContainerProxy`, and the deployed bundle contained
`export { ContainerProxy$1 as ContainerProxy, ... }`. The export was never the problem.

`ctx.exports` — the loopback bindings for a Worker's top-level exports — is a runtime feature gated
by **compatibility date**. This Worker pinned `2025-05-06`, which predates it. Measured in the
installed workerd with a throwaway Durable Object that reports `Object.keys(this.ctx)`:

| `compatibility_date` | `Object.keys(this.ctx)` |
|---|---|
| `2025-05-06` … `2025-11-01` | `facets, container, storage, id, props` |
| `2025-12-01` and later | `facets, container, storage, id, props, exports` |

No `exports`, so `ctx.exports?.ContainerProxy` is `undefined`, so the SDK's own guard throws
`InvalidMountConfigError` — and because `prepareContainer()` runs before the command, the mount
failure took the whole `/run` request down with it. `compatibility_date` is now `2026-05-06`.

The container itself was never the fault. Its instance was `running` the whole time; the platform's
`healthy: 0` counter was a symptom of a Durable Object that threw on its first request, not of a
container that failed to boot.

## The container application name

The platform derives a container **application** name as `<worker-name>-<lowercased class name>` —
hence the old `dev-tooling-dsh-shell-sandbox`, which is an SDK class name leaking into our namespace.
`wrangler.jsonc` therefore sets `containers[].name` explicitly. What that field does, observed rather
than assumed, is recorded in the naming registry (`cloudflare_container_app`), together with the
exception: **an application name the platform generates from someone else's class name is not a name
we control**, so it must be read back after a deploy and never inferred from the class.

## Names

Rendered by `names/validate.py render shared.tooling.dsh.shell` — never typed by hand. The canonical
registry lives in `alphaville-agency/agency` under `names/`; this repository vendors a read-only copy
in `.dsh/ontology/` with the hashes pinned in `PIN.json`.

| Platform | Name |
|---|---|
| `cloudflare_worker` | `shared-tooling-dsh-shell` |
| `cloudflare_container_app` | see `names/validate.py render shared.tooling.dsh.shell` |
| `hostname` | `dsh.alphaville.space` |
| `r2_bucket` | `af-shared-tooling-dsh` |
| `cloudflare_ai_gateway` | `shared-tooling-dsh-gateway` |
| `env_prefix` | `AF_SHARED_TOOLING_DSH_SHELL` |

`shared` takes the bare hostname label because it has no sibling env of the tooling system to collide
with — prefixing it would re-assert tiers that do not exist. The rule is generalised in the registry:
the bare label belongs to whichever `env` is not subordinate to another env of the same system.

## What is parked, and where

Everything below is on `archive/pre-floor-design`, unverified, and returns only one layer at a time:

| Parked | Why it is not here |
|---|---|
| `src/lease-do.ts`, `src/leases.ts` | The input/awake lease DO. Most complex, least necessary: nothing to lease until a shell exists. |
| `bin/dsh-provision.sh`, `bin/dsh-state.sh` | First-run provisioning and the config symlinks. Needs a working mount first. |
| `src`-side mount code, `.dsh/persistence.json` | The R2 mount at `/mnt/state`. It was what the 1101 threw on the way to. |
| `bin/dsh-client.mjs`, `dsh.sh`, `bootstrap.sh` | The terminal and its entry points. |
| `apm.yml`, `apm.lock.yaml`, `.apm/`, `dsh-install/`, `.dsh/profiles/` | APM, and the node trees the provisioner installs — agent state, not image contents. |
| `.github/workflows/image-report.yml` | The APM-era image report. |
| `tools/sync.sh`, `tools/check-drift.sh` | Pre-APM tooling describing an `agent/` layout that no longer exists. |

## What comes back, and in what order

1. the R2 binding mount at `/mnt/state`, with a command that writes and reads a file there
2. the node-tree persistence and the provisioner, with a warm start proven to skip it
3. the terminal and `bin/dsh-client.mjs`
4. the input/awake lease Durable Object — last, because it is the most complex and the least necessary

## What it costs

A `lite` container is billed on its **provisioned** memory and disk while it runs, so the cost control
is being asleep, not being small. `sleepAfter` is 5 minutes and nothing inside the container may
extend it — no daemon, no poll, no timer, no keepalive. `docs/COST.md` has the arithmetic.

## Secrets

No credential is committed and none is baked into the image. Live secrets reach the Worker at runtime
from Worker secrets, or from the account's Secrets Store through its binding.

## The unauthenticated Worker

`https://dsh.alphaville.space` has **no authentication**: at the floor, `POST /run` executes whatever
command it is given for anyone who can reach the hostname. That is a recorded finding, not an
oversight. An authentication gate is a layer that must be added before this box is trusted with
anything, and it is deliberately not in the floor because the floor exists to prove the platform
contract — not to be safe.
