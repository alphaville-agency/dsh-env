// The Worker in front of the dsh developer workspace.
//
// Three things happen here and nothing else. A request to /run is a one-shot command. A WebSocket to
// /ws/terminal is handed to the lease Durable Object, which owns the single upstream terminal socket
// and decides who may type into it - see src/lease-do.ts. And /work is how the container declares
// that an agent is working, so the workspace is not slept out from under it.
//
// Everything here is a request, and a request is the wake-up: `getSandbox()` starts a stopped
// container on first use, so there is no separate start step to forget. Nothing in this file keeps
// it awake - it stops `sleepAfter` after the last request, which is the whole cost control (see
// docs/COST.md). The one thing that may deliberately extend that is the awake lease, and it does so
// only when something inside the container says work is in progress.
import {
  ContainerProxy,
  getSandbox,
  proxyToSandbox,
  type Sandbox,
  type SandboxOptions,
} from "@cloudflare/sandbox";
import { DshLease, type WorkResult } from "./lease-do";
import {
  COMMAND_FIELD,
  DESCRIPTION_FIELD,
  ERROR_FIELD,
  LEASE_ID,
  METHOD_GET,
  METHOD_POST,
  MOUNT_ALREADY_IN_USE,
  OK_FIELD,
  PROVISION_BIN,
  ROUTE_FIELD,
  ROUTE_HEALTHZ,
  ROUTE_ROOT,
  ROUTE_RUN,
  ROUTE_TERMINAL,
  ROUTE_WORK,
  ROUTES_FIELD,
  SANDBOX_ID,
  SERVICE_FIELD,
  SERVICE_NAME,
  SLEEP_AFTER,
  STATE_BINDING,
  STATE_BIN,
  STATE_ENSURE,
  STATE_MOUNT_PATH,
  WEBSOCKET_UPGRADE,
  WORK_TOKEN_FIELD,
  WORK_UNTIL_FIELD,
} from "./names";

// The credential-less R2 mount intercepts outbound S3 requests inside the Durable Object, so
// ContainerProxy has to be exported beside the sandbox itself or the mount fails. DshLease is
// exported for the same kind of reason: wrangler finds a Durable Object class by its export.
export { ContainerProxy, Sandbox } from "@cloudflare/sandbox";
export { DshLease } from "./lease-do";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  /** The lease Durable Object. The name must match LEASE_BINDING in wrangler.jsonc. */
  LEASE: DurableObjectNamespace<DshLease>;
  STATE: R2Bucket;
}

// `keepAlive` is deliberately absent: its default, false, is what lets the container stop. The
// awake lease turns it on and off again, and only while work is declared.
const SANDBOX_OPTIONS: SandboxOptions = {
  sleepAfter: SLEEP_AFTER,
  enableDefaultSession: false,
};

function sandboxFor(env: Env): Sandbox {
  return getSandbox(env.Sandbox, SANDBOX_ID, SANDBOX_OPTIONS);
}

/** One Durable Object, addressed by name, so every isolate and region reaches the same lease. */
function leaseFor(env: Env): DurableObjectStub<DshLease> {
  return env.LEASE.getByName(LEASE_ID);
}

/**
 * The durable state is the R2 bucket bound as STATE, mounted with no credentials anywhere: the SDK
 * signs the requests in the Durable Object instead of writing a key into the container.
 *
 * Mounts live on the container filesystem and do not survive the container being recreated, so this
 * runs before every operation that touches STATE_MOUNT_PATH. An already-mounted path is a success,
 * not a failure - that is what a warm container looks like.
 *
 * It answers whether THIS call created the mount, and the answer is what makes preparation one-shot
 * per wake without a poll and without asking the container anything: the SDK keeps `activeMounts` in
 * the Durable Object, so a warm container answers "already in use" and a freshly woken one mounts.
 */
async function ensureStateMounted(sandbox: Sandbox): Promise<boolean> {
  try {
    await sandbox.mountBucket(STATE_BINDING, STATE_MOUNT_PATH, {});
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(MOUNT_ALREADY_IN_USE)) throw error;
    return false;
  }
}

/**
 * Prepare the container, in one order, on a container that has just been recreated.
 *
 * The mount comes first because it IS the state: the dependency trees are installed into it and the
 * harness home is symlinked from a clone inside it, so anything that runs before this step is
 * writing somewhere that will not survive the wake.
 *
 * `dsh-provision` then installs the node dependency trees (the harness CLI and the TUI profile,
 * ~400 MB) into the mount from the clone's committed lockfiles, and `dsh-state ensure` clones, links
 * and installs the skill catalog. Both are idempotent and marker-guarded in the mount, so this is
 * the first-run cost and nothing else.
 *
 * It must not gate the container coming up. A registry outage has to leave a usable shell with the
 * failure printed on it - a container that refuses to start because npm was unreachable is far worse
 * than one without the TUI - so the exit codes are deliberately ignored and the output is left on
 * the terminal. Nothing here polls, retries, or outlives the request.
 *
 * ponytail: the two commands are awaited, so a cold start pays the install before the shell appears.
 * The ceiling is the registry's latency on that one wake; the upgrade path, if the stall is ever the
 * complaint, is `startProcess` for the second command and a marker the shell checks.
 */
async function prepareContainer(sandbox: Sandbox): Promise<void> {
  if (!(await ensureStateMounted(sandbox))) return;
  await sandbox.exec(`${PROVISION_BIN} || true`);
  await sandbox.exec(`${STATE_BIN} ${STATE_ENSURE} || true`);
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
  // One request per wake in practice, so preparing here and again on the terminal path costs a
  // single "already in use" round trip and removes every ordering question about which came first.
  await prepareContainer(sandbox);
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
    [METHOD_POST, ROUTE_WORK, "declare work in progress, so the container stays awake for it"],
  ].map(([method, path, description]) => ({
    [ROUTE_FIELD]: `${method} ${path}`,
    [DESCRIPTION_FIELD]: description,
  }));

  return Response.json({ [SERVICE_FIELD]: SERVICE_NAME, [ROUTES_FIELD]: routes });
}

/**
 * Hand the upgrade to the lease Durable Object. It terminates the upgrade, holds the one socket to
 * the container, and hands each client its own - which is the only way to let a second client watch
 * live without being able to type.
 */
async function terminal(request: Request, env: Env): Promise<Response> {
  return await leaseFor(env).fetch(request);
}

/**
 * The container's work declaration, over Durable Object RPC. RPC carries no HTTP status, so the
 * object answers with one and this turns it into a response.
 */
async function declareWork(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null);
  const result: WorkResult = await leaseFor(env).declareWork(body);
  if (!result.ok) return Response.json({ [ERROR_FIELD]: result.error }, { status: result.status });
  return Response.json({
    [WORK_TOKEN_FIELD]: result.token,
    [WORK_UNTIL_FIELD]: result.until,
  });
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
      if (url.pathname === ROUTE_TERMINAL) {
        if (request.headers.get("Upgrade")?.toLowerCase() !== WEBSOCKET_UPGRADE) {
          return new Response("the terminal route needs a WebSocket upgrade", { status: 426 });
        }
        return await terminal(request, env);
      }
    }

    if (request.method === METHOD_POST) {
      if (url.pathname === ROUTE_RUN) return await runCommand(request, env);
      if (url.pathname === ROUTE_WORK) return await declareWork(request, env);
    }

    return new Response("not found", { status: 404 });
  },
};
