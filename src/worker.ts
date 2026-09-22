// The Worker in front of the dsh developer workspace.
//
// Three routes. `GET /healthz` is liveness and deliberately does NOT touch the sandbox: a probe must
// never wake a stopped container, because a monitor that wakes it is a heartbeat by another name.
// `POST /run` runs one command and returns its buffered output. `GET /ws/terminal` proxies a
// WebSocket upgrade to the container's PTY, and is how a person actually works in here.
//
// The request IS the wake-up: touching the sandbox starts a stopped container on first use, so there
// is no separate start step to forget. Nothing keeps it awake from the inside; it stops `sleepAfter`
// after the last request, which is the whole cost control. An open terminal counts as activity, so
// it stays up while someone is typing and stops five minutes after they leave.
//
// WHY THE TERMINAL IS HERE AND NOT ON SSH. `wrangler containers ssh` is the obvious answer for
// "attach a shell" and it does not work under this lifecycle: Cloudflare's SSH guide states it
// connects only to a RUNNING instance, that it will not start a stopped one, and that a live SSH
// session does not keep a container alive - and wrangler exposes no `containers start`. So with
// `sleepAfter` set, an SSH-only design has no way back in after the first sleep. The upgrade being a
// request is exactly the property SSH lacks.
//
// WHAT WAS REMOVED, AND WHY. This Worker previously served `/run` and `/ws/terminal` with NO
// authentication. `POST /run` was measured answering 200 to an anonymous `curl` from the public
// internet - an unauthenticated root shell behind a memorable hostname. Both routes now sit behind
// a bearer check that FAILS CLOSED, and the check is the first thing that happens on every path.
//
// The lease Durable Object, the R2 mount and the provisioner are not coming back in their old form:
// the lease had nothing to arbitrate for one operator, and s3fs was measured unusable three ways.
import {
  AUTH_TOKEN_ENV,
  BEARER_PREFIX,
  COMMAND_FIELD,
  DESCRIPTION_FIELD,
  ERROR_FIELD,
  METHOD_FIELD,
  METHOD_GET,
  METHOD_POST,
  OK_FIELD,
  ROUTE_FIELD,
  ROUTE_HEALTHZ,
  ROUTE_ROOT,
  ROUTE_RUN,
  ROUTE_TERMINAL,
  ROUTES_FIELD,
  SANDBOX_ID,
  SERVICE_FIELD,
  SERVICE_NAME,
  SLEEP_AFTER,
  WEBSOCKET_UPGRADE,
} from "./names";
import { getSandbox, type Sandbox, type SandboxOptions } from "@cloudflare/sandbox";

/**
 * BOTH exports are required. The second is not optional, and its absence is what stopped this
 * container from ever starting.
 *
 * `Sandbox` is the Durable Object class the `containers` binding names. `ContainerProxy` is a
 * WorkerEntrypoint the SDK builds its outbound-interception fetchers through, and the SDK states the
 * requirement in its own source (sandbox-D0rNqxlr.js:7201-7206): "Users must export this class from
 * their Worker entrypoint so the Sandbox DO can create outbound-interception fetchers that
 * reference it."
 *
 * When it is missing, the base Container class throws (containers/dist/lib/container.js:1176):
 *
 *   ctx.exports.ContainerProxy is undefined, export ContainerProxy from the containers package
 *   in your worker entrypoint
 *
 * Why it fires here even though nothing mounts anything: interception is switched on by
 * `persistedOutboundConfiguration !== undefined` (container.js:362), and that configuration is
 * PERSISTED IN DURABLE OBJECT STORAGE (container.js:1065, key OUTBOUND_CONFIGURATION). The earlier
 * "Layer 1: the R2 binding mount" deploy called mountBucket, which set outbound handlers and wrote
 * that record. The mount code is gone; the record is not, and this is still the same object
 * (`SANDBOX_ID = "dsh"`), so every construction since restores it and turns interception back on.
 *
 * The symptom looked nothing like the cause: `container.startup` warned
 * "ctx.exports.ContainerProxy is undefined", the SDK retried eight times over 135 seconds, and all a
 * caller ever saw was 502 "Container is starting. Please retry in a moment." - permanently.
 *
 * The official minimal example exports only `Sandbox` and gets away with it precisely because it
 * never mounts, so it never persists an outbound configuration. Any app that has ever mounted one
 * needs this export permanently.
 */
export { ContainerProxy, Sandbox } from "@cloudflare/sandbox";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  STATE: R2Bucket;
  [AUTH_TOKEN_ENV]?: string;
}

/**
 * `keepAlive` is deliberately absent: its default, false, is what lets the container stop.
 *
 * `enableDefaultSession` is on because sessionless sandbox calls land in the default session; the
 * terminal below names its session explicitly anyway, so that the type-safe `ExecutionSession` path
 * is used rather than the sandbox-level convenience method - the SDK installs that method on the
 * proxy at runtime (sandbox.ts:955-956) but the 0.12.9 `Sandbox` type returns `as T` (line 987) and
 * does not declare it, so calling it from TypeScript needs a cast. Naming the session avoids the
 * cast without pretending the method is not there.
 */
const SANDBOX_OPTIONS: SandboxOptions = {
  sleepAfter: SLEEP_AFTER,
  enableDefaultSession: true,
};

/**
 * The session the terminal attaches to.
 *
 * Stable on purpose: disconnecting leaves the PTY and its scrollback alive, so reattaching replays
 * what happened while you were away. A session per connection would throw that away, which is the
 * opposite of what a terminal is for.
 */
const TERMINAL_SESSION = "dsh";

function sandboxFor(env: Env): Sandbox {
  return getSandbox(env.Sandbox, SANDBOX_ID, SANDBOX_OPTIONS);
}

/**
 * The bearer check, and the FIRST thing every route does.
 *
 * It fails closed. If `DSH_TOKEN` is not set the Worker refuses every request rather than allowing
 * every request: an unconfigured deployment is a broken deployment, not an open shell. The other
 * half matters just as much - the token is compared with a constant-time compare, because an
 * ordinary `===` on a secret leaks its prefix through timing.
 */
function isAuthorised(request: Request, env: Env): boolean {
  const expected = env[AUTH_TOKEN_ENV];
  if (typeof expected !== "string" || expected.length === 0) return false;

  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith(BEARER_PREFIX)) return false;

  return constantTimeEquals(header.slice(BEARER_PREFIX.length), expected);
}

/**
 * Compare two strings without leaking WHERE they differ, in time or in early exit.
 *
 * Length is compared first and that is unavoidable - the length of the token is not the secret, and
 * everything after it is compared over the full span with no early return.
 */
function constantTimeEquals(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

/** Run one command and hand back the buffered result. This request is what wakes the sandbox. */
async function runCommand(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const command = body?.[COMMAND_FIELD];
  if (typeof command !== "string" || command.length === 0) {
    return Response.json(
      { [ERROR_FIELD]: `${COMMAND_FIELD} must be a non-empty string` },
      { status: 400 },
    );
  }

  try {
    const { stdout, stderr, exitCode, success } = await sandboxFor(env).exec(command);
    return Response.json({ stdout, stderr, exitCode, success });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ [ERROR_FIELD]: message }, { status: 502 });
  }
}

/**
 * Liveness. Deliberately does not touch the sandbox: a probe must never wake a stopped container.
 *
 * Unauthenticated, and that is a decision rather than an oversight: it reports only that this Worker
 * exists, reveals nothing about the sandbox, and a liveness probe that needs a credential is a probe
 * that fails for the wrong reason. It must stay incapable of waking anything.
 */
function health(): Response {
  return Response.json({ [OK_FIELD]: true, [SERVICE_FIELD]: SERVICE_NAME });
}

/**
 * What this Worker answers, so the surface is discoverable without reading the source. Behind the
 * bearer check, unlike liveness, because the route table is not public information.
 */
function describe(): Response {
  return Response.json({
    [SERVICE_FIELD]: SERVICE_NAME,
    [ROUTES_FIELD]: [
      { [ROUTE_FIELD]: ROUTE_ROOT, [METHOD_FIELD]: METHOD_GET, [DESCRIPTION_FIELD]: "this description" },
      { [ROUTE_FIELD]: ROUTE_HEALTHZ, [METHOD_FIELD]: METHOD_GET, [DESCRIPTION_FIELD]: "liveness; does not wake the sandbox" },
      { [ROUTE_FIELD]: ROUTE_RUN, [METHOD_FIELD]: METHOD_POST, [DESCRIPTION_FIELD]: `one command, as {"${COMMAND_FIELD}": "..."}` },
      { [ROUTE_FIELD]: ROUTE_TERMINAL, [METHOD_FIELD]: METHOD_GET, [DESCRIPTION_FIELD]: "interactive terminal; needs a WebSocket upgrade" },
    ],
  });
}

/** The interactive terminal: hand the upgrade to the SDK's stable session API. */
async function terminal(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== WEBSOCKET_UPGRADE) {
    return new Response("the terminal route needs a WebSocket upgrade", { status: 426 });
  }

  // The explicit session is what makes this type-safe; see TERMINAL_SESSION and SANDBOX_OPTIONS.
  const session = await sandboxFor(env).getSession(TERMINAL_SESSION);
  return await session.terminal(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Liveness first, and only liveness is reachable without the token: a probe that needs a
    // credential cannot be used by the platform, and this path cannot wake or run anything.
    if (request.method === METHOD_GET && url.pathname === ROUTE_HEALTHZ) return health();

    if (!isAuthorised(request, env)) {
      return new Response("unauthorised", { status: 401 });
    }

    if (request.method === METHOD_GET && url.pathname === ROUTE_ROOT) return describe();
    if (request.method === METHOD_POST && url.pathname === ROUTE_RUN) {
      return await runCommand(request, env);
    }
    if (url.pathname === ROUTE_TERMINAL) return await terminal(request, env);

    return new Response("not found", { status: 404 });
  },
};