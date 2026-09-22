// The Worker in front of the container exists for two reasons: Containers reach the world through a
// Worker, and a sleeping container needs an incoming request to start. It exposes a health response
// and a start endpoint; the shell itself is reached with `wrangler containers ssh`, which has no
// public port.
import { Container, getContainer } from "@cloudflare/containers";

export class DshShell extends Container<Env> {
  defaultPort = 22;

  // Shut down five minutes after the last incoming request. An SSH session is NOT an incoming
  // request, so the image runs a keepalive that polls this Worker while a session is attached -
  // holding it open while someone works and letting it die the moment they stop. Idle costs nothing.
  sleepAfter = "5m";

  // The container needs to know its own public endpoint to poll. Passed in rather than hardcoded so
  // the same image works in any environment.
  envVars = { WORKER_HEALTH_URL: "https://dsh.alphaville.space/healthz" };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      // Reachable so the keepalive can reset the sleep timer. It reads nothing and says nothing.
      return Response.json({ ok: true, service: "prod-tooling-dsh-shell" });
    }

    if (url.pathname === "/start") {
      // Containers do not run until something asks for them, and `wrangler containers ssh` will not
      // start a stopped one. This is the wake-up call.
      const container = getContainer(env.DSH, "dsh");
      await container.start();
      return Response.json({ started: true, service: "prod-tooling-dsh-shell" });
    }

    return new Response("not found", { status: 404 });
  },
};
