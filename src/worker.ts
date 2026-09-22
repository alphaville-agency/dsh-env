// The Worker in front of the dsh developer workspace.
//
// Two things happen here and nothing else. A request to /run or the terminal WebSocket is the
// wake-up: `getSandbox()` starts a stopped container on first use, so there is no separate start
// step to forget. And nothing in this file keeps it awake - it stops `sleepAfter` after the last
// request, which is the whole cost control (see docs/COST.md).
import {
  ContainerProxy,
  getSandbox,
  proxyToSandbox,
  type PtyOptions,
  type Sandbox,
  type SandboxOptions,
} from "@cloudflare/sandbox";
import {
  COMMAND_FIELD,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DESCRIPTION_FIELD,
  ERROR_FIELD,
  METHOD_GET,
  METHOD_POST,
  MOUNT_ALREADY_IN_USE,
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
  SESSION_PARAM,
  SLEEP_AFTER,
  STATE_BINDING,
  STATE_MOUNT_PATH,
} from "./names";

// The credential-less R2 mount intercepts outbound S3 requests inside the Durable Object, so
// ContainerProxy has to be exported beside the sandbox itself or the mount fails.
export { ContainerProxy, Sandbox } from "@cloudflare/sandbox";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  STATE: R2Bucket;
}

// `keepAlive` is deliberately absent: its default, false, is what lets the container stop.
const SANDBOX_OPTIONS: SandboxOptions = {
  sleepAfter: SLEEP_AFTER,
  enableDefaultSession: false,
};

function sandboxFor(env: Env): Sandbox {
  return getSandbox(env.Sandbox, SANDBOX_ID, SANDBOX_OPTIONS);
}

/**
 * The durable state is the R2 bucket bound as STATE, mounted with no credentials anywhere: the SDK
 * signs the requests in the Durable Object instead of writing a key into the container.
 *
 * Mounts live on the container filesystem and do not survive the container being recreated, so this
 * runs before every operation that touches STATE_MOUNT_PATH. An already-mounted path is a success,
 * not a failure - that is what a warm container looks like.
 */
async function ensureStateMounted(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.mountBucket(STATE_BINDING, STATE_MOUNT_PATH, {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(MOUNT_ALREADY_IN_USE)) throw error;
  }
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

  const sandbox = sandboxFor(env);
  await ensureStateMounted(sandbox);
  const { stdout, stderr, exitCode, success } = await sandbox.exec(command);
  return Response.json({ stdout, stderr, exitCode, success });
}

/**
 * Liveness. Deliberately does not touch the sandbox: a probe must never wake a stopped container,
 * because a monitor that wakes it is a heartbeat by another name.
 */
function health(): Response {
  return Response.json({ [OK_FIELD]: true, [SERVICE_FIELD]: SERVICE_NAME });
}

/** The plain description of the service, at the root because the root is a human's first guess. */
function describe(): Response {
  const routes = [
    [METHOD_GET, ROUTE_ROOT, "this description"],
    [METHOD_GET, ROUTE_HEALTHZ, "liveness; does not start the container"],
    [METHOD_POST, ROUTE_RUN, `run one command: {"${COMMAND_FIELD}":"..."}`],
    [METHOD_GET, ROUTE_TERMINAL, "interactive terminal; needs a WebSocket upgrade"],
  ].map(([method, path, description]) => ({
    [ROUTE_FIELD]: `${method} ${path}`,
    [DESCRIPTION_FIELD]: description,
  }));

  return Response.json({ [SERVICE_FIELD]: SERVICE_NAME, [ROUTES_FIELD]: routes });
}

async function terminal(request: Request, env: Env, sessionId: string | null): Promise<Response> {
  const sandbox = sandboxFor(env);
  if (sessionId) {
    const session = await sandbox.getSession(sessionId);
    return await session.terminal(request);
  }
  // The default session's terminal is what the documented `sandbox.terminal(request)` reaches.
  return await asTerminalHost(sandbox).terminal(request, {
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
}

/**
 * `terminal()` exists on the sandbox the runtime hands back but is missing from the installed
 * stable typings: @cloudflare/sandbox 0.12.9 declares it on `ExecutionSession` only, not on the
 * `Sandbox` class `getSandbox()` returns. This is a deliberate cast for that type gap, not a
 * preview API.
 *
 * ponytail: ceiling is the SDK's own declaration. Delete this and the cast when `Sandbox` declares
 * `terminal`, and the call becomes ordinary.
 */
type TerminalHost = {
  terminal(request: Request, options?: PtyOptions): Promise<Response>;
};

function asTerminalHost(sandbox: Sandbox): TerminalHost {
  return sandbox as unknown as TerminalHost;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Preview hostnames are the SDK's business, not ours; it answers null for anything else.
    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    const url = new URL(request.url);

    if (request.method === METHOD_GET) {
      if (url.pathname === ROUTE_ROOT) return describe();
      if (url.pathname === ROUTE_HEALTHZ) return health();
      // Connecting is the wake-up. A local client upgrades to a WebSocket here and the sandbox
      // starts on the way in; there is nothing else to start it.
      if (url.pathname === ROUTE_TERMINAL && request.headers.get("Upgrade") === "websocket") {
        return terminal(request, env, url.searchParams.get(SESSION_PARAM));
      }
    }

    if (request.method === METHOD_POST && url.pathname === ROUTE_RUN) {
      return runCommand(request, env);
    }

    return new Response("not found", { status: 404 });
  },
};