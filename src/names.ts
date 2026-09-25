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
 * `apiKeyEnv: CHEAPINFERENCE_COM_API_KEY`, so the container must carry exactly this variable.
 * It is injected from a Worker secret with setEnvVars and never appears in this repository or
 * in the image.
 */
export const MODEL_KEY_ENV = "CHEAPINFERENCE_COM_API_KEY";

/**
 * The environment variable gh reads its credential from.
 *
 * `GH_TOKEN` is what the GitHub CLI looks for, so the name is GitHub's rather than ours. It is
 * injected from a Worker secret exactly like the model credential, and it is what lets a session
 * clone and push - which is the whole of the durability story, because the container's disk
 * resets on sleep and anything not pushed is gone.
 */
export const GH_TOKEN_ENV = "GH_TOKEN";

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