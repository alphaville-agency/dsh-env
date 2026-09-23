// The Worker in front of the dsh developer workspace.
//
// Two routes. `GET /healthz` is liveness and deliberately does NOT touch the sandbox: a probe must
// never wake a stopped container, because a monitor that wakes it is a heartbeat by another name.
// `GET /ws/terminal` proxies a WebSocket upgrade to the container's PTY, and is the only way in.
//
// There is no command endpoint. One existed, unauthenticated, and executed arbitrary commands as
// root; see src/names.ts for why it is not coming back.
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
// AUTHENTICATION IS NOT HERE. It is Cloudflare Access, in front of the hostname, and that is
// deliberate: an earlier version of this Worker carried its own bearer check, which meant a
// hand-rolled credential compared in constant time, a token to distribute, and a second place for
// it to be wrong. Access does it at the edge, for HTTP and for the WebSocket upgrade, and the
// client holds a service token it can actually possess. One gate, not two.
//
// What this Cost: `/healthz` is now behind Access as well, because a pathless bypass policy
// bypasses the whole application rather than one route. A liveness probe therefore needs the
// service token; that is a smaller price than an administratively-open host to keep one route free.
//
// The lease Durable Object, the R2 mount and the provisioner are not coming back in their old form:
// the lease had nothing to arbitrate for one operator, and s3fs was measured unusable three ways.
import {
  DESCRIPTION_FIELD,
  ERROR_FIELD,
  GH_TOKEN_ENV,
  METHOD_FIELD,
  METHOD_GET,
  MODEL_KEY_ENV,
  OK_FIELD,
  ROUTES_FIELD,
  ROUTE_FIELD,
  ROUTE_HEALTHZ,
  ROUTE_ROOT,
  ROUTE_TERMINAL,
  SANDBOX_ID,
  SERVICE_FIELD,
  SERVICE_NAME,
  SHELL_PARAM,
  SLEEP_AFTER,
  TERMINAL_SHELL_ALLOWED,
  TERMINAL_SHELL_DEFAULT,
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
  [MODEL_KEY_ENV]?: string;
  [GH_TOKEN_ENV]?: string;
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
 * Put the model credential into the container's environment, where the harness looks for it.
 *
 * This is the join between the two halves of the design. The credential lives in a Worker SECRET -
 * never in the image, never in this repository, never in the profile's settings, which name the
 * environment variable rather than carrying its value. `settings.yaml` says
 * `apiKeyEnv: CHEAPINFERENCE_COM_API_KEY`, so the container has to have that variable set or the
 * harness starts and then cannot reach a model at all.
 *
 * The SDK has no `envVars` option on `getSandbox`; `setEnvVars` is the API, so this runs before each
 * operation rather than once at construction. That is idempotent and cheap - the SDK stores the
 * values against the sandbox - and it means a rotated secret takes effect on the next request rather
 * than on the next container.
 *
 * If the secret is absent this does nothing and the environment still works as a shell. Failing the
 * request instead would trade a usable workspace for a clear error message, which is the wrong way
 * round: the harness reports its own missing key far better than a 500 from here would.
 */
async function injectSecrets(sandbox: Sandbox, env: Env): Promise<void> {
  const values: Record<string, string> = {};

  const modelKey = env[MODEL_KEY_ENV];
  if (typeof modelKey === "string" && modelKey.length > 0) values[MODEL_KEY_ENV] = modelKey;

  // gh's credential. Its absence is not fatal: the environment still works as a shell, and the
  // harness reports a missing model key far better than a failed request here would. What it costs
  // is the ability to clone and push, which dsh-prime reports plainly when it runs.
  const ghToken = env[GH_TOKEN_ENV];
  if (typeof ghToken === "string" && ghToken.length > 0) values[GH_TOKEN_ENV] = ghToken;

  if (Object.keys(values).length === 0) return;
  await sandbox.setEnvVars(values);
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
      { [ROUTE_FIELD]: ROUTE_TERMINAL, [METHOD_FIELD]: METHOD_GET, [DESCRIPTION_FIELD]: "interactive terminal; needs a WebSocket upgrade" },
    ],
  });
}

/** The interactive terminal: hand the upgrade to the SDK's stable session API. */
async function terminal(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== WEBSOCKET_UPGRADE) {
    return new Response("the terminal route needs a WebSocket upgrade", { status: 426 });
  }

  // Which program the PTY runs. Defaults to the harness, because that is what this environment is
  // for, and is restricted to the allowlist because the value is the program's name.
  const requested = new URL(request.url).searchParams.get(SHELL_PARAM);
  const shell = requested !== null && TERMINAL_SHELL_ALLOWED.includes(requested)
    ? requested
    : TERMINAL_SHELL_DEFAULT;

  // The explicit session is what makes this type-safe; see TERMINAL_SESSION and SANDBOX_OPTIONS.
  const sandbox = sandboxFor(env);
  await injectSecrets(sandbox, env);

  const session = await sandbox.getSession(TERMINAL_SESSION);
  return await session.terminal(request, { shell });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === METHOD_GET && url.pathname === ROUTE_HEALTHZ) return health();

    if (request.method === METHOD_GET && url.pathname === ROUTE_ROOT) return describe();
    if (url.pathname === ROUTE_TERMINAL) return await terminal(request, env);

    return new Response("not found", { status: 404 });
  },
};