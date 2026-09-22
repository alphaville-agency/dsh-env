// The Worker in front of the container exists for two reasons: Containers reach the world through a
// Worker, and a sleeping container needs an incoming request to start. It exposes nothing but a
// health response; the shell is reached with `wrangler containers ssh`, which has no public port.
import { Container, getContainer } from "@cloudflare/containers";

export class DshShell extends Container<Env> {
  defaultPort = 22;

  // Shut down five minutes after the last incoming request. An SSH session is NOT an incoming
  // request, so the image runs a keepalive that polls this Worker while a session is attached -
  // which holds it open while someone is working and lets it die the moment they stop. Idle costs
  // nothing, which is the point.
  sleepAfter = "5m";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      // Reachable so the keepalive can reset the sleep timer. It reads nothing and says nothing.
      return Response.json({ ok: true, service: "prod-tooling-dsh-shell" });
    }
    return new Response("not found", { status: 404 });
  },
};
