# dsh developer environment

This repository is the **dsh developer environment**: a Cloudflare Container, driven through a
Cloudflare Worker, that an agent or the operator works in. It is **not** the agency. Nothing in
production may depend on it, and it may disappear at any moment.

Its logical ID is `shared.tooling.dsh.shell`. `system=tooling` is what makes it a *development*
environment; `env=shared` is what records that it is **not tiered** — there is one of these, and it
serves the agency's dev, stg and prod work alike. There is no `stg-dsh` and no `dsh` to go with it.

---

## Status: primed

A session lands with everything the agency's work needs, verified inside the container:

```
rules=10  agents=yes  roles=yes  ontology=yes  plane=yes
gh=2.101.0  ghtoken=set  modelkey=set
cloned: agency  tooling  reference-implementation
```

Credentials reach the container as Worker secrets and never touch this repository or the image: the
model key (`CHEAPINFERENCE_COM_API_KEY`) and gh's (`GH_TOKEN`).

**Priming is the whole configuration the agent inherits.** Before this, the rules, the router, the
model roles and the naming registry sat in this repository wired to nothing - so a session opened
into a TUI with a model and no idea how the project works, and would re-derive a different set of
conventions every time. `container.Dockerfile` now installs them, and the build asserts every path
the router points at exists, so a dangling reference fails the build rather than a session.

## Status: working, and verified end to end

The environment boots the harness, reaches a model, and holds a conversation. This was verified by
connecting the same way `dsh.sh` does - authenticated WebSocket, `shell=dsh-session` - sending
`Reply with exactly: CUTOVER-OK`, and receiving `CUTOVER-OK` back from `deepseek-v4.1-flash` through
the cheapinference gateway, with the TUI's own token meter reporting `ctx 0.8% (8.3k/1.0m)`.

| Route | What it does |
|---|---|
| `GET /healthz` | Liveness. **Does not start the container.** |
| `GET /ws/terminal` | The product: an interactive PTY, started as `dsh-session`. The only way in. |

There is no command endpoint. One existed - `POST /run`, which executed arbitrary commands as root -
and it was measured answering 200 to an anonymous `curl` from the public internet. It briefly came
back behind auth so the platform could be verified from a shell script, and that was the wrong shape:
an endpoint that exists for the author's convenience is an arbitrary-command API on a public
hostname, and the interface it stood in for already exists. Verification happens inside the session.

The container carries the launcher, a `dsh-tui` profile built by the harness's own `dsh plugin add`,
and the `settings.yaml` that points the harness at cheapinference. The model credential is a Worker
secret, injected with `setEnvVars`; nothing about it is in this repository or in the image.

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

## Working in a session

```sh
./dsh.sh          # open the session
dsh-prime         # fetch or refresh the repositories (first thing, every session)
```

`dsh-prime` is a command rather than session startup, deliberately: the container's disk resets when
it sleeps, so a clone cannot be baked at build time and would be stale if it were, and running it
behind the TUI would put a network clone on the path to a prompt.

**The container is ephemeral, and you do not have to manage that.** Cloudflare documents it plainly -
"all disk is ephemeral … the next time it is started, it will have a fresh disk as defined by its
container image" - and this was verified here rather than assumed: a marker file written to
`/workspace` was gone seven minutes later and the container's boot id had changed. Snapshots
("coming soon") and FUSE-to-R2 are the only persistence the platform offers; FUSE was measured
failing three separate ways, and its own docs warn against expecting SSD-like performance.

So the working tree genuinely does not survive. What that does NOT mean is that you are responsible
for remembering. The platform announces the shutdown - `onActivityExpired()` when the sleep timer
fires, `onStop()` when the container exits - and `src/sandbox.ts` uses both to copy uncommitted
changes and untracked files out to R2 before the disk is discarded.

That is a safety net, not a workflow. **Pushing is still how work leaves this environment**: the
capture is a patch in an object store, and pushed work is work.

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

## How the harness is installed, and why it took four attempts

Each failure below was a different cause behind one symptom, and all four are recorded because the
image rebuild is slow and the next person will meet them again.

1. **The launcher could not install.** `@deepseek-ai/dsh`'s published tree requires
   `@deepseek-ai/dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`, which was never published. Fixed
   with an npm `overrides` pin in a committed manifest and lockfile under `dsh-install/`.
2. **The TUI is not a binary.** It is an out-of-tree mode bundle over `@deepseek-ai/dsh-base`, so
   `npm install -g <tui>` installs nothing runnable. It belongs in a profile.
3. **A hand-written profile built a second harness tree.** The bundle declares the harness packages as
   PEER dependencies; npm auto-installs peers, pnpm does not (its `autoInstallPeers: false` is the
   whole reason `dsh plugin add` is correct). Two trees meant two generations of the session codec,
   and `SessionFormatError: encodeCurrent requires Session format v3`.
4. **Supporting packages floated.** Pinning only the `dsh-*` names let `cordis`, `cordis-plugin-hmr`
   and `cordis-plugin-timer` drift to newer versions that do not register the service names the
   launcher looks up, so live patch watching failed. The overrides now come from every package in a
   working tree - 241 of them - rather than from a name prefix.

Two of these were caused by the fix for the one before it, which is the argument for taking the
versions from a setup known to work rather than reasoning about them.

## What it costs

A `lite` container is billed on its **provisioned** memory and disk while it runs, so the cost control
is being asleep, not being small. `sleepAfter` is 5 minutes and nothing inside the container may
extend it — no daemon, no poll, no timer, no keepalive. `docs/COST.md` has the arithmetic.

## Secrets

No credential is committed and none is baked into the image. Live secrets reach the Worker at runtime
from Worker secrets, or from the account's Secrets Store through its binding.

## Authentication: Cloudflare Access

`dsh.alphaville.space` sits behind a Cloudflare Access application whose only policy admits a
**service token**. The edge refuses everything else before a request reaches the Worker, for HTTP and
for the WebSocket upgrade alike, and the policy is `non_identity` - it authorises a machine, not a
person, so no browser login is involved.

`dsh.sh` reads the token from `~/.dsh/access` (two lines: client id, then secret) and sends it as
`CF-Access-Client-Id` / `CF-Access-Client-Secret`. It is not in this repository and not in the image.

**The Worker has no auth of its own, on purpose.** An earlier version compared a bearer token: a
hand-rolled credential, a secret to distribute, and a second gate beside the one the platform already
provides. Two gates is not twice the safety; it is twice the places to be wrong.

Two consequences worth knowing. `/healthz` is behind Access too - a pathless bypass policy bypasses
the whole application rather than one route, so a liveness probe needs the token. And **Cloudflare
secrets are write-only**: neither Worker secrets nor Secrets Store will hand a value back, so nothing
can fetch a shared secret at run time. A service token works precisely because the client holds it
rather than fetching it.
