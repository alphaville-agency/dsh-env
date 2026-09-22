// The Worker in front of the container exists for two reasons: Containers reach the world through a
// Worker, and a sleeping container needs an incoming request to start. The shell itself is reached
// with `wrangler containers ssh`, which has no public port.
import { Container, getContainer } from "@cloudflare/containers";

export class DshShell extends Container<Env> {
  // The image runs an HTTP responder on 8080 for the platform's startup health check, and sshd on
  // 22 for the session. sshd cannot answer the health check because it does not speak HTTP, so both
  // are required.
  defaultPort = 8080;
  requiredPorts = [8080, 22];

  // Shut down five minutes after the last incoming request. The image's keepalive polls this Worker
  // while a session is attached, so it stays up while someone works and dies when they stop.
  sleepAfter = "5m";

  envVars = { WORKER_HEALTH_URL: "https://dsh.alphaville.space/healthz" };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "prod-tooling-dsh-shell" });
    }

    if (url.pathname === "/start") {
      // A stopped container is not started by `wrangler containers ssh`, so this is the wake-up.
      const container = getContainer(env.DSH, "dsh");
      await container.startAndWaitForPorts({ ports: [8080, 22] });
      return Response.json({ started: true });
    }

    return new Response("not found", { status: 404 });
  },
};
