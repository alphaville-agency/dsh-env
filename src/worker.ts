// The Worker in front of the container exists for one reason: Containers reach the world through
// a Worker, and a sleeping container needs a request to start. It exposes nothing but a health
// response and a start endpoint, both under Cloudflare Access - the shell itself is reached over
// `wrangler containers ssh`, which has no public port.
import { Container, getContainer } from "@cloudflare/containers";

export class DshShell extends Container<Env> {
  defaultPort = 22;
  // Keep alive only while a session is attached. The default stops after 10 minutes of no
  // requests, which would kill an interactive shell mid-thought.
  sleepAfter = "2h";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "dsh-workspace" });
    }
    if (url.pathname === "/start") {
      await getContainer(env.DSH, "workspace").start();
      return Response.json({ started: true });
    }
    return new Response("not found", { status: 404 });
  },
};
