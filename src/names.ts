/**
 * Every name this Worker uses, defined once.
 *
 * A bare string in a route table or a binding lookup is an unnamed contract: it cannot be found,
 * renamed or validated, and the same concept drifts into several spellings. Anything that is
 * protocol rather than ours — the `Upgrade` header, `websocket`, `GET`, `POST`, `content-type` —
 * stays inline, because those tokens are fixed by the HTTP and WebSocket specs.
 */

/** The Worker's own name, and the `service` field every health probe reports. */
export const SERVICE_NAME = "dev-tooling-dsh-shell";

/** The public URL the terminal page and `dsh.sh` both point at. */
export const PUBLIC_URL = "https://dev-dsh.alphaville.space";

/** One sandbox, one developer workspace. The id is part of the Durable Object key. */
export const SANDBOX_ID = "dsh";

/**
 * The cost control. Five minutes after the last request the container stops, and a stopped
 * container costs nothing. Nothing in this repo may extend it from the inside.
 */
export const SLEEP_AFTER = "5m";

/** The R2 binding the durable state is mounted from, and where it lands in the container. */
export const STATE_BINDING = "STATE";
export const STATE_MOUNT_PATH = "/mnt/state";

/**
 * `mountBucket` throws when the path is already mounted, which is a normal, successful outcome:
 * mounts do not survive the container being recreated, and they are already there when it is not.
 * Matching on this fragment is a string contract we do not own; the SDK's own error text is the
 * only signal it offers.
 */
export const MOUNT_ALREADY_IN_USE = "already in use";

/** Routes. */
export const ROUTE_ROOT = "/";
export const ROUTE_HEALTHZ = "/healthz";
export const ROUTE_RUN = "/run";
export const ROUTE_TERMINAL = "/ws/terminal";

/**
 * Request and response field names. Protocol tokens (the `Upgrade` header, `websocket`, `GET`,
 * `POST`) stay inline; anything the JSON contract of *this* Worker defines is named here.
 */
export const COMMAND_FIELD = "command";
export const SESSION_PARAM = "session";
export const SERVICE_FIELD = "service";
export const OK_FIELD = "ok";
export const ERROR_FIELD = "error";
export const ROUTES_FIELD = "routes";
export const ROUTE_FIELD = "route";
export const DESCRIPTION_FIELD = "description";

/** HTTP methods we dispatch on, using the same names in the route description as in the matcher. */
export const METHOD_GET = "GET";
export const METHOD_POST = "POST";

/** The PTY size used before the local client reports the real one. */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/**
 * Deliberately unimplemented. `https://dev-dsh.alphaville.space/` runs a shell, so it is a real
 * exposure while it is unauthenticated — an explicit finding, not an oversight. This constant is
 * the single place a gate is wired in when the mechanism is chosen; nothing else reads it yet.
 */
export const TERMINAL_AUTH_GATE = "none";