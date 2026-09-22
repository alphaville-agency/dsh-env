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
  OK_FIELD,
  ROUTE_HEALTHZ,
  ROUTE_RUN,
  SANDBOX_ID,
  SERVICE_FIELD,
  SERVICE_NAME,
  SLEEP_AFTER,
} from "./names";

// wrangler finds a Durable Object class by its export, and this is the SDK's own class.
export { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

// `keepAlive` is deliberately absent: its default, false, is what lets the container stop. When the
// awake lease comes back it will turn it on and off again, and only while work is declared.
const SANDBOX_OPTIONS: SandboxOptions = {
  sleepAfter: SLEEP_AFTER,
};

function sandboxFor(env: Env): Sandbox {
  return getSandbox(env.Sandbox, SANDBOX_ID, SANDBOX_OPTIONS);
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

  const { stdout, stderr, exitCode, success } = await sandboxFor(env).exec(command);
  return Response.json({ stdout, stderr, exitCode, success });
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
