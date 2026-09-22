// The Worker in front of the dsh developer workspace. This is the FLOOR.
//
// Two routes and nothing else. `GET /healthz` is liveness and deliberately does not touch the
// sandbox: a probe must never wake a stopped container, because a monitor that wakes it is a
// heartbeat by another name (docs/COST.md). `POST /run` runs one command and hands back its
// buffered output - it is the platform contract this whole environment depends on, and until this
// repository proved it, every layer above it was unverified.
//
// The request IS the wake-up: `getSandbox()` starts a stopped container on first use, so there is
// no separate start step to forget. Nothing here keeps it awake; it stops `sleepAfter` after the
// last request, which is the whole cost control.
//
// Everything else the design had - the lease Durable Object, the R2 mount and the provisioner, the
// terminal, the skills installer - is parked on the `archive/pre-floor-design` branch. Each comes
// back one layer at a time, each verified, or it does not come back.
import { getSandbox, type Sandbox, type SandboxOptions } from "@cloudflare/sandbox";
import {
  COMMAND_FIELD,
  ERROR_FIELD,
  METHOD_GET,
  METHOD_POST,
  MOUNT_ALREADY_IN_USE,
  MOUNT_ERROR_FIELD,
  OK_FIELD,
  ROUTE_HEALTHZ,
  ROUTE_RUN,
  SANDBOX_ID,
  SERVICE_FIELD,
  SERVICE_NAME,
  S3FS_MOUNT_OPTIONS,
  SLEEP_AFTER,
  STATE_BINDING,
  STATE_MOUNT_PATH,
} from "./names";

// wrangler finds a Durable Object class by its export, and `Sandbox` is the SDK's own class.
//
// `ContainerProxy` is exported beside it because the credential-less R2 mount intercepts outbound
// S3 requests inside the Durable Object, and the SDK refuses the mount without it. This export was
// present all along during the 1101 and was NOT the fault: what was missing was `ctx.exports`, the
// runtime's loopback bindings, which its compatibility date did not yet provide. See wrangler.jsonc.
export { ContainerProxy, Sandbox } from "@cloudflare/sandbox";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  STATE: R2Bucket;
}

// `keepAlive` is deliberately absent: its default, false, is what lets the container stop. When the
// awake lease comes back it will turn it on and off again, and only while work is declared.
const SANDBOX_OPTIONS: SandboxOptions = {
  sleepAfter: SLEEP_AFTER,
};

function sandboxFor(env: Env): Sandbox {
  return getSandbox(env.Sandbox, SANDBOX_ID, SANDBOX_OPTIONS);
}

/**
 * Establish the durable state mount, and say whether THIS call created it.
 *
 * An already-mounted path is a success, not a failure: that is exactly what a warm container looks
 * like. Mounts live on the container filesystem and do not survive the container being recreated,
 * so this runs before every command rather than once at boot - there is no boot hook and nothing
 * polls, which is the rule this environment is built around (docs/COST.md).
 */
async function ensureStateMounted(sandbox: Sandbox): Promise<boolean> {
  try {
    await sandbox.mountBucket(STATE_BINDING, STATE_MOUNT_PATH, {
      s3fsOptions: S3FS_MOUNT_OPTIONS,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(MOUNT_ALREADY_IN_USE)) throw error;
    return false;
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
  let mountFailure: string | null = null;
  // The mount is the durable state, and it does not survive the container being recreated, so it is
  // established on the way to every command. On a warm container this is one "already mounted" round
  // trip; on a cold one it is what makes /mnt/state exist before anything writes to it.
  //
  // A mount failure must not take the command with it. The mount buys durability; the shell is the
  // product. Losing a command because the object store was unreachable is a strictly worse trade
  // than running the command without durable state, so the error is reported and the command runs.
  try {
    await ensureStateMounted(sandbox);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mountFailure = message;
  }

  try {
    const { stdout, stderr, exitCode, success } = await sandbox.exec(command);
    return Response.json(
      mountFailure === null
        ? { stdout, stderr, exitCode, success }
        : { stdout, stderr, exitCode, success, [MOUNT_ERROR_FIELD]: mountFailure },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ [ERROR_FIELD]: message, [MOUNT_ERROR_FIELD]: mountFailure }, { status: 502 });
  }
}

/**
 * Liveness. Deliberately does not touch the sandbox: a probe must never wake a stopped container.
 */
function health(): Response {
  return Response.json({ [OK_FIELD]: true, [SERVICE_FIELD]: SERVICE_NAME });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === METHOD_GET && url.pathname === ROUTE_HEALTHZ) return health();
    if (request.method === METHOD_POST && url.pathname === ROUTE_RUN) {
      return await runCommand(request, env);
    }

    return new Response("not found", { status: 404 });
  },
};
