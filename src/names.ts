/**
 * Every name this Worker uses, defined once.
 *
 * A bare string in a route table or a binding lookup is an unnamed contract: it cannot be found,
 * renamed or validated, and the same concept drifts into several spellings. Anything that is
 * protocol rather than ours — the `Upgrade` header, `websocket`, `GET`, `POST`, `content-type` —
 * stays inline, because those tokens are fixed by the HTTP and WebSocket specs.
 *
 * This file is deliberately short. It names the floor and nothing else: a name is added back with
 * the layer that needs it, so nothing here is a claim about code that does not exist yet.
 */

/**
 * The Worker's own name, and the `service` field every health probe reports.
 *
 * `shared.tooling.dsh.shell`, rendered by names/validate.py: `system=tooling` is what makes this a
 * development environment and `env=shared` is what records that it is not tiered - one instance
 * serves every environment, so there is no `dev`/`stg`/`prod` sibling of it to be confused with.
 */
export const SERVICE_NAME = "shared-tooling-dsh-shell";

/** One sandbox, one developer workspace. The id is part of the Durable Object key. */
export const SANDBOX_ID = "dsh";

/**
 * The cost control. Five minutes after the last request the container stops, and a stopped
 * container costs nothing. Nothing in this repo may extend it from the inside.
 *
 * Why five minutes is safe with an interactive terminal, when it is NOT safe with SSH: sleeping is
 * driven by REQUESTS, and an open WebSocket is a live request stream. A connected terminal
 * therefore keeps the container up for as long as it is connected, and the five minutes only start
 * counting once the last client has gone. That is not true of an SSH session, which Cloudflare's own
 * SSH guide says does not keep a container alive - which is why the terminal lives on the Worker and
 * not on port 22.
 */
export const SLEEP_AFTER = "5m";

/**
 * Routes.
 *
 * `/ws/terminal` is the product: a WebSocket upgrade here is proxied straight to the container PTY
 * by the SDK, so PTY sizing, output buffering and reconnection are the platform's work and not ours.
 * CONNECTING IS THE WAKE-UP - the upgrade is a request, so there is no separate start step to
 * forget, and no `/wake` route is needed. That is the whole reason the terminal is on the Worker
 * rather than on SSH: `wrangler containers ssh` will not start a stopped container, and wrangler
 * exposes no `containers start`, so an SSH-only design has no way back in after the container
 * sleeps.
 *
 * Both are behind the bearer check. What used to be here and is NOT coming back: these same
 * two routes with NO authentication. `POST /run` was measured answering 200 to an anonymous `curl`
 * from the public internet, executing an arbitrary command as root. The shell is not a public API.
 */
export const ROUTE_HEALTHZ = "/healthz";
export const ROUTE_TERMINAL = "/ws/terminal";

/**
 * The bounded agent surface: prompt a session over ACP, get its reply back.
 *
 * BOUNDED, AND DELIBERATELY NOT `POST /run`. That endpoint executed arbitrary commands as root and
 * was measured answering 200 to an anonymous curl from the public internet; it came back behind auth
 * once, and the record says why that was still the wrong shape — an endpoint for the author's
 * convenience is an arbitrary-command API on a public hostname.
 *
 * This one runs exactly one thing: `dsh --profile acp`, the Agent Client Protocol server, with a
 * prompt the caller supplies and nothing else. There is no command field, no shell, no profile
 * selection: the profile is a constant, the input is a message, and the output is that message's
 * reply. It cannot become a shell because there is no path from a request field to argv.
 *
 * Cloudflare Access sits in front of the hostname for HTTP and WebSocket alike, so this inherits
 * that gate rather than adding a second one.
 */
export const ROUTE_AGENT = "/agent";
export const ROUTE_AGENT_PROFILE = "headless";
// How long one agent turn may run: fifteen minutes.
//
// RAISED FROM 120s, WHICH MEASURED NOTHING BUT THE WRONG THING. A one-line reply costs ~16s, but the
// work this surface exists for - read the goal, edit the repository, commit, push - does not fit in
// two minutes, and a cap that cuts a turn off mid-edit is worse than no cap: it leaves an agent
// half-way through a change with no record of where it was. The bound still exists so a wedged turn
// cannot pin a request for ever, and the streaming route reports progress while it runs, so a long
// turn is visible rather than silent.
export const ROUTE_AGENT_TIMEOUT_MS = 900_000;
export const ROUTE_ROOT = "/";

/**
 * What the terminal runs, and there is deliberately no way to ask for anything else.
 *
 * The terminal attaches to a STABLE session - that is what makes a reconnect replay the scrollback
 * instead of starting over - and a session's shell is fixed when it is created. So a query
 * parameter that chooses the shell means the FIRST caller decides for everyone: a probe that opened
 * `shell=bash` left a bash session behind, and the next person to run `./dsh.sh` would have attached
 * to that instead of the TUI.
 *
 * The earlier version had an allowlist to make the parameter safe. The allowlist was the wrong
 * answer to the right instinct: the session's shell is not the client's business at all.
 */
export const TERMINAL_SHELL = "dsh-session";

/**
 * The harness home inside the container, and the variable that names it.
 *
 * The image declares both with `ENV DSH_HOME=/root/.dsh`, and the ACP route passes them explicitly
 * because an `exec` environment does not inherit the image's `ENV`: without them the harness composes
 * no providers and every session fails with `no adapter registered for provider "cf-ai-gateway"`.
 */
export const DSH_HOME_PATH = "/root/.dsh";
export const DSH_HOME_ENV = "DSH_HOME";

/**
 * Where the agent route writes the prompt it is about to answer.
 *
 * A FILE, BECAUSE A COMMAND LINE IS CODE. The route used to interpolate `JSON.stringify(prompt)` into
 * a shell command, and inside double quotes the shell still expands `$(...)` and backticks - so a
 * prompt could execute in the container, on the one route that exists so that no request field can
 * reach argv. A fixed path keeps every request-derived byte out of the shell.
 *
 * Constant rather than per-request on purpose: this surface answers one turn at a time, and a
 * predictable path is one fewer thing to leak or accumulate.
 */
export const AGENT_PROMPT_PATH = "/tmp/dsh-agent-prompt.txt";

/**
 * The session the agent route runs its one command in.
 *
 * NAMED EXPLICITLY BECAUSE THE IMPLICIT ONE IS WHAT HANGS. Read back from `wrangler tail` against the
 * live Worker, the split is not "container calls fail" - it is which session they land in:
 *
 *   getSession("dsh")      resolved   (this is the line "terminal session ready" is printed after)
 *   exec, writeFile        canceled   (both land in the SDK's implicit default session)
 *
 * `enableDefaultSession` is on, so `sandbox.exec(...)` is supposed to reuse a persistent default
 * shell - and in this container that call never returns, which is what turned the agent route into a
 * 150s silence with nothing on either stream. The terminal has always named its session, and the
 * terminal has always worked. This is the same trick for the same reason.
 *
 * A session of its own, not the terminal's: the terminal's session is a live TUI owning a PTY, and
 * running a command inside it would type into somebody's screen.
 */
export const AGENT_SESSION = "agent";

/**
 * The variable the harness actually gates bash on, and the value this surface needs.
 *
 * WHY THE PERMISSION PRESET WAS NOT ENOUGH. The headless profile's own dump shows what decides it:
 *
 *   - id: sandbox-policy
 *     config: { mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write' }
 *   - id: approval
 *     config: { policy: !!js (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') ===
 *                       'danger-full-access' ? 'never' : 'ask' }
 *
 * Both read the ENVIRONMENT, not the `permission` preset row - so a patch layer setting
 * `defaultPreset: danger-full-access` composes correctly and changes nothing. Unset, the mode is
 * `workspace-write` and the approval policy is `ask`, and an automation surface has no approval
 * channel: every command that needs more than the sandbox default fails closed, which is the harness
 * reporting honestly that `bash is unavailable entirely`.
 *
 * This is the same shape of defect as the missing DSH_HOME: an `exec` does not inherit the image's
 * ENV, and the harness reads its policy from the environment. Setting it here is what makes the
 * surface able to run a command at all.
 */
/**
 * The router this environment reaches its models through, and the two facts it reports.
 *
 * The Worker does not normally talk to the gateway - the container does. This exists for ONE caller:
 * the schedule below, which has to know whether the model it is about to ask for is the one that is
 * already paid for at this moment. The gateway answers that in a response header, so a one-token
 * request is the cheapest possible way to ask, and it costs a fraction of a cent rather than the cost
 * of waking a container to find out.
 */
export const GATEWAY_BASE_URL = "https://aig.drksci.com/dsh/v1";
export const GATEWAY_PROVIDER_HEADER = "cf-aig-provider";

/**
 * The provider that means "this is already paid for".
 *
 * The router serves the reserved-hours subscription as `custom-cheapestinference` and the
 * pay-per-token wallet as `custom-cheapinference` - names one letter apart, which is exactly the kind
 * of pair this project has been burned by before. Measured, not read: a probe at 19:46 UTC answered
 * `cf-aig-provider: custom-cheapinference` (wallet), and a goal-sized turn on the wallet answers
 * `402 Insufficient wallet balance`. Outside the block the environment must stay asleep.
 */
export const SUBSCRIPTION_PROVIDER = "custom-cheapestinference";
export const GATEWAY_PROBE_MODEL = "deepseek-v4.1-flash";

export const DSH_PERMISSION_MODE_ENV = "DSH_PERMISSION_MODE";
export const DSH_PERMISSION_MODE_VALUE = "danger-full-access";
/**
 * There is no auth constant here, and that is the point.
 *
 * Authentication is Cloudflare Access, in front of the hostname. This Worker used to compare a
 * bearer token of its own, which meant a hand-rolled credential, a secret to distribute that
 * Cloudflare will not let anyone read back, and a second gate beside the one the platform already
 * provides. Access enforces both HTTP and the WebSocket upgrade at the edge, and the client holds a
 * service token it can actually possess - so the only thing left to name here is nothing.
 */

/**
 * The environment variable the harness reads its model credential from.
 *
 * The name is not ours to choose: the profile's settings.yaml declares
 * `apiKeyEnv: CF_AI_GATEWAY_TOKEN`, so the container must carry exactly this variable. The value is
 * the inference-router token, NOT a provider key: the provider keys live in the AI Gateways, which is
 * what stops a container from holding one at all.
 * It is injected from a Worker secret with setEnvVars and never appears in this repository or
 * in the image.
 */
export const MODEL_KEY_ENV = "CF_AI_GATEWAY_TOKEN";

/**
 * The environment variable gh reads its credential from.
 *
 * `GH_TOKEN` is what the GitHub CLI looks for, so the name is GitHub's rather than ours. It is
 * injected from a Worker secret exactly like the model credential, and it is what lets a session
 * clone and push - which is the whole of the durability story, because the container's disk
 * resets on sleep and anything not pushed is gone.
 */
export const GH_TOKEN_ENV = "GH_TOKEN";

/**
 * The Cloudflare credential the CONTAINER uses, as opposed to the one the Worker deploys with.
 *
 * They are not the same token and must not be confused: the Worker's own deploy credential arrives
 * through GitHub Actions, while these two reach the container so that a session can run `wrangler`
 * itself. Without them the environment can write a Worker and cannot deploy it, which is a notebook
 * rather than a development environment.
 *
 * `CLOUDFLARE_ACCOUNT_ID` is injected alongside because wrangler will otherwise pick whichever account
 * the token happens to be able to see first - and this project already has more than one, where the
 * wrong choice lands the deploy in a tenancy with no Containers support at all.
 */
export const CLOUDFLARE_API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
export const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";

/** HTTP methods we dispatch on, and the one WebSocket protocol token we compare. */
export const METHOD_GET = "GET";
export const METHOD_POST = "POST";
export const WEBSOCKET_UPGRADE = "websocket";

/**
 * The R2 binding for durable state, and the path the bucket is mounted at inside the container.
 *
 * THE MOUNT IS THE PERSISTENCE. Everything outside it is on the container's ephemeral disk and is
 * gone at the next wake - `/workspace` included, deliberately: s3fs was measured unusably slow for a
 * git/npm workload, so the working tree stays local and git stays the source of truth for work. What
 * is mounted is the one thing the operator asked to keep: the harness's conversation store, which is
 * small JSONL files rather than a build tree.
 *
 * WHY THE MOUNT PATH IS EMPTY AND THE STORE IS A SYMLINK. s3fs refuses a non-empty mount point, and
 * `/root/.dsh/sessions` is non-empty the moment a conversation exists - that is what defeated an
 * earlier attempt to mount over the store itself. So the bucket is mounted at a path nothing else
 * uses, and `bin/dsh-session` links the real store into it before the harness reads it.
 *
 * The mount is made from the terminal route in src/worker.ts, immediately before the PTY opens,
 * because that is tied to a real request. It is deliberately NOT made from a lifecycle hook: two
 * earlier attempts put the restore and the capture in `onStart`/`onActivityExpired`, and after an
 * eight-minute sleep the container still came back with an empty store.
 */
export const STATE_BINDING = "STATE";
export const STATE_MOUNT_PATH = "/mnt/state";

/**
 * How long the mount may take before the terminal stops waiting for it.
 *
 * THE MOUNT GATES A TERMINAL, SO IT MAY NOT GATE IT INDEFINITELY. Measured on this environment: the
 * first version of this call hung, and a `curl` WebSocket upgrade with a 600-second limit received
 * **zero bytes** - not an error, not a 502, nothing - because the Worker was still awaiting a
 * container API call. A workspace whose store is local is still a workspace; a `./dsh.sh` that never
 * returns is not. Once this fires, the upgrade proceeds and `bin/dsh-session` finds no mount and says
 * so, which is the fallback path and not a silent one.
 *
 * It is generous rather than tight on purpose: the container is started by the session lookup before
 * this is called, so the mount itself is a short operation when it works at all, and the failure it
 * guards against is one that never finishes rather than one that is merely slow.
 */
export const STATE_MOUNT_TIMEOUT_MS = 30_000;

/**
 * How long `mountpoint -q` may take before the mount is treated as unavailable.
 *
 * WHY THIS IS SEPARATE FROM, AND SHORTER THAN, THE MOUNT BUDGET ABOVE. The probe is one command that
 * either answers in milliseconds or does not answer at all, and it was the ONE `exec` in the Worker
 * with no `timeout` of its own. Measured with `wrangler tail` against the live Worker: `exec` and
 * `getSession` both came back `outcome=canceled` at ~29.7s, the last log line was
 * `dsh: terminal session ready; backing the session store`, and no `session store backing:` line ever
 * followed - so the request died inside the probe, before `session.terminal()` was ever reached, and
 * the terminal returned zero frames to a client that waited on it.
 *
 * A probe that hangs is a broken container, not a slow one, and the caller already has the right
 * response: log that the store is unbacked for this session and open the terminal anyway.
 */
export const STATE_PROBE_TIMEOUT_MS = 10_000;

/**
 * The harness's conversation store inside the container.
 *
 * WHY IT IS A SYMLINK TARGET RATHER THAN A DIRECTORY. The container's disk is discarded when it
 * stops, so this path does not survive a sleep, and the resume picker shows `0 sessions` on the next
 * boot. It is NOT under `/workspace`, which is why the SDK's own `createBackup` cannot address it:
 * `DirectoryBackup.dir` must be under `/workspace`, `/home`, `/tmp`, `/var/tmp` or `/app`, and its
 * production restore path mounts the archive through s3fs + a FUSE overlay.
 *
 * The bytes live in R2 under `STATE_MOUNT_PATH`; this path is the harness's fixed idea of where the
 * store is, and `bin/dsh-session` points it at the mount with a symlink. If the mount is not there,
 * the path stays an ordinary directory on the ephemeral disk: the store is then not persistent, but
 * the session still opens, which is the property that matters more.
 *
 * `$DSH_HOME` is `/root/.dsh` in the image (container.Dockerfile), so the store is this path.
 */
export const SESSION_STORE_DIR = "/root/.dsh/sessions";

/**
 * Request and response field names. Protocol tokens stay inline; anything the JSON contract of
 * *this* Worker defines is named here.
 */
export const SERVICE_FIELD = "service";
export const OK_FIELD = "ok";
export const ROUTES_FIELD = "routes";
export const ROUTE_FIELD = "route";
export const METHOD_FIELD = "method";
export const DESCRIPTION_FIELD = "description";
export const ERROR_FIELD = "error";