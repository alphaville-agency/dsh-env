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
 * What the terminal starts as, and the query parameter that may change it.
 *
 * The PTY is started with this program rather than opening a shell and then typing a command into
 * it. Typing is the wrong shape for a session that survives a disconnect: the SDK keeps the PTY
 * alive and replays its output on reconnect, so an injected `dsh` would be typed into an already
 * running TUI - which is worse than useless, and would depend on the client guessing whether the
 * terminal it is attaching to is new. `PtyOptions.shell` is passed to the container when the PTY is
 * created, so reconnecting attaches to the same process with nothing sent.
 *
 * The value is checked against an allowlist instead of being passed through. It reaches the
 * container as the program to run, so an unvalidated value is a command, and "the caller is already
 * authenticated" is not a reason to hand it one - the authenticated caller is a terminal client, not
 * a shell.
 */
export const SHELL_PARAM = "shell";
export const TERMINAL_SHELL_DEFAULT = "dsh-session";
export const TERMINAL_SHELL_ALLOWED = ["dsh-session", "bash", "sh"];

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
 * The R2 binding for durable state.
 *
 * NOTE: nothing mounts this. s3fs was measured failing three separate ways - refusing a non-empty
 * mountpoint, returning `Input/output error` on `ls` after a mount that reported success, and being
 * unusably slow for a git/npm workload - so the mount is not on the path to anything and its
 * plumbing is gone rather than parked. The binding stays declared because the bucket exists and is
 * the intended home for bytes that must outlive a container; git remains the source of truth for
 * work, and the trade-off is explicit: uncommitted work is lost when the container is replaced.
 */
export const STATE_BINDING = "STATE";

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