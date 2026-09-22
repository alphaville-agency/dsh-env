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
 * The image's first-run provisioner, and the two commands that follow it. They are one sequence and
 * the order is the contract: the mount is the state, the provisioner installs the dependency trees
 * into it from the clone's committed lockfiles, and `dsh-state ensure` clones and links the harness
 * home. All three are idempotent and marker-guarded, so running them on a warm container is a few
 * stats and no network, and running them is the ONLY way the container is prepared - there is no
 * start hook, no daemon and nothing in the background.
 *
 * The provisioner ships in the image rather than the clone on purpose: it has to run before the
 * clone exists, because it is what installs the trees the clone's manifests describe.
 */
export const PROVISION_BIN = "dsh-provision";
export const STATE_BIN = "dsh-state";
export const STATE_ENSURE = "ensure";

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
export const ROUTE_WORK = "/work";

/**
 * The two leases are named so they cannot be confused with each other.
 *
 * The **input lease** answers *who may type*: exactly one client holds it, everyone else attached is
 * live but read-only. The **awake lease** answers *is work in progress*: it is what keeps the
 * container from sleeping mid-task, and it is deliberately not tied to who is typing. A read-only
 * observer is not work; an agent running a goal with no client attached is.
 *
 * The state machines themselves live in `src/leases.ts`; this file only names the plumbing.
 */
export const LEASE_BINDING = "LEASE";
export const LEASE_ID = "dsh-terminal-lease";
export const STORAGE_INPUT_LEASE = "inputLease";
export const STORAGE_AWAKE_LEASE = "awakeLease";

/**
 * Query parameters on the terminal route. A client always names itself; `takeover` is present only
 * when it means to take the input lease from whoever holds it.
 */
export const CLIENT_PARAM = "client";
export const TAKEOVER_PARAM = "takeover";
export const TAKEOVER_SET = "1";

/**
 * The upgrade the lease Durable Object makes to the container's PTY. It is a synthetic host: the
 * SDK rewrites the port and forwards it, and nothing resolves this name.
 */
export const UPSTREAM_TERMINAL_URL = "https://sandbox.internal/ws/terminal";

/**
 * Control frames on the client link. `ready` means "you hold the input lease and may type";
 * `readonly` means "you are attached and live, and your keystrokes are not sent"; `lost` means
 * "you held it and just lost it". The first two are the whole point of the feature, so they are
 * named rather than spelled inline at each end.
 */
export const MSG_READY = "ready";
export const MSG_READONLY = "readonly";
export const MSG_LOST = "lost";
export const MSG_RESIZE = "resize";
export const MSG_COMMAND = "command";
export const MSG_EXIT = "exit";
export const MSG_ERROR = "error";

/** Fields of those control frames. */
export const TYPE_FIELD = "type";
export const DATA_FIELD = "data";
export const COLS_FIELD = "cols";
export const ROWS_FIELD = "rows";
export const CODE_FIELD = "code";
export const MESSAGE_FIELD = "message";
export const HOLDER_FIELD = "holder";
export const HINT_FIELD = "hint";
export const FRESH_FIELD = "fresh";

/**
 * How long a silent holder keeps the input lease. Every frame it sends renews this, and the lease
 * is checked lazily when the next client connects - never by a timer, so nothing here can wake a
 * sleeping container. A client that is killed rather than closed therefore frees the lease after
 * this window instead of wedging the session forever.
 */
export const LEASE_TTL_MS = 10 * 60 * 1000;

/** Hostnames and protocols that are fixed by other specs stay inline; these are ours. */
export const WEBSOCKET_UPGRADE = "websocket";

/** The work declaration the container makes when an agent starts and finishes a unit of work. */
export const WORK_ACTION_FIELD = "action";
export const WORK_TOKEN_FIELD = "token";
export const WORK_BEGIN = "begin";
export const WORK_END = "end";
export const WORK_UNTIL_FIELD = "until";

/**
 * How long a work declaration keeps the container awake without being re-declared or closed. It is
 * long because a unit of work is long, and it exists at all because a "work finished" message that
 * is never sent must expire rather than pin the container awake forever.
 */
export const WORK_TTL_MS = 2 * 60 * 60 * 1000;

/** The client-side names, used by bin/dsh-client.mjs and dsh.sh. */
export const ENV_TAKEOVER = "DSH_TAKEOVER";
export const ENV_CLIENT_ID = "DSH_CLIENT_ID";
export const CLIENT_ID_FILE = ".dsh-client-id";
export const TAKEOVER_FLAG = "--takeover";

/**
 * Request and response field names. Protocol tokens (the `Upgrade` header, `websocket`, `GET`,
 * `POST`) stay inline; anything the JSON contract of *this* Worker defines is named here.
 */
export const COMMAND_FIELD = "command";
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