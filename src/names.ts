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
 */
export const SLEEP_AFTER = "5m";

/** Routes. The floor has two: liveness, and the ability to run a command. */
export const ROUTE_HEALTHZ = "/healthz";
export const ROUTE_RUN = "/run";

/**
 * The R2 binding the durable state is mounted from, and where it lands in the container.
 *
 * The mount is credential-less: the SDK signs the requests inside the Durable Object rather than
 * writing a key into the container, which is why the Worker has to export `ContainerProxy` beside
 * the sandbox class. The mount does not survive the container being recreated, so it is established
 * before every command rather than once at boot.
 */
export const STATE_BINDING = "STATE";
export const STATE_MOUNT_PATH = "/mnt/state";

/**
 * `mountBucket` throws when the path is already mounted, which is a normal, successful outcome: on a
 * warm container the mount is simply already there. Matching on this fragment is a string contract
 * we do not own - the SDK's own error text is the only signal it offers - so it is named once here
 * rather than spelled into the catch.
 */
export const MOUNT_ALREADY_IN_USE = "already in use";

/**
 * Request and response field names. Protocol tokens stay inline; anything the JSON contract of
 * *this* Worker defines is named here.
 */
export const COMMAND_FIELD = "command";
export const SERVICE_FIELD = "service";
export const OK_FIELD = "ok";
export const ERROR_FIELD = "error";

/** HTTP methods we dispatch on. */
export const METHOD_GET = "GET";
export const METHOD_POST = "POST";
