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
 * The harness's conversation store inside the container, and the snapshot of it that outlives a
 * sleep.
 *
 * WHY IT IS HERE. The container's disk is discarded when it stops, so `/root/.dsh/sessions` - where
 * the harness keeps every conversation, one directory per session - does not survive, and the
 * resume picker shows `0 sessions` on the next boot. The store is NOT under `/workspace`, which is
 * why the SDK's own `createBackup` cannot address it: `DirectoryBackup.dir` must be under
 * `/workspace`, `/home`, `/tmp`, `/var/tmp` or `/app` (sandbox-BtaWcmmG.d.ts, `interface
 * DirectoryBackup`), and its production restore path mounts the archive through s3fs + a FUSE
 * overlay, which this environment measured unusable. So the snapshot is a tar of the store,
 * carried over `exec` as base64 - the same route src/sandbox.ts already uses for uncommitted work.
 *
 * `$DSH_HOME` is `/root/.dsh` in the image (container.Dockerfile), so the store is this path.
 */
export const SESSION_STORE_DIR = "/root/.dsh/sessions";

/** Where the session snapshot lives in R2 (`STATE`). One key: the newest snapshot replaces it. */
export const SESSION_SNAPSHOT_KEY = "dsh-sessions/sessions.tar.b64";

/** What the snapshot holds, readable without decoding it. Rewritten with every capture. */
export const SESSION_SNAPSHOT_MANIFEST_KEY = "dsh-sessions/MANIFEST.txt";

/** Where the base64 snapshot is staged inside the container before it is decoded. */
export const SESSION_SNAPSHOT_FILE = "/tmp/dsh-sessions.tar.b64";

/**
 * Where a restore is unpacked before it is moved into place.
 *
 * Extracting straight into the store would leave a half-written store if the transfer failed
 * midway, and the next boot would read that half-store as "the container already has sessions" and
 * refuse to restore again. Nothing lands in the store until the whole archive has decoded.
 */
export const SESSION_RESTORE_STAGE_DIR = "/root/.dsh/.sessions-restore";

/**
 * The bound on what a snapshot keeps, because the store grows without limit - one directory per
 * conversation, forever, and the local one is already 157 MB.
 *
 * The newest N session directories by mtime, and the newest at least: the budget is only consulted
 * from the second session on, so a single oversized session is still captured rather than lost.
 * `du -sk` measures the directories, so this is a ceiling on the tar, before base64 inflates it by
 * a third.
 */
export const SESSION_SNAPSHOT_MAX_SESSIONS = 20;
export const SESSION_SNAPSHOT_MAX_KIB = 8 * 1024;

/**
 * How long a session transfer may take before it is abandoned.
 *
 * Both directions run inside a lifecycle hook - `onStart` before the container is usable,
 * `onActivityExpired` while the platform is waiting to stop it - so a hung transfer must not hold
 * the lifecycle open. A stopped container with no sessions is recoverable; one that never finishes
 * starting is not.
 */
export const SESSION_TRANSFER_TIMEOUT_MS = 30_000;

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