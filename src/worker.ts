// The Worker in front of the container exists for two reasons: Containers reach the world through a
// Worker, and a stopped container is not woken by `wrangler containers ssh` - so something must ask
// for it. Any request does.
import { Container, getContainer } from "@cloudflare/containers";

export class DshShell extends Container<Env> {
  // The image runs an HTTP responder on 8080 for the platform's startup health check and sshd on 22
  // for the session. sshd cannot answer the check because it does not speak HTTP.
  defaultPort = 8080;
  requiredPorts = [8080, 22];

  // Shut down five minutes after the last request. The image polls this Worker while a session is
  // attached, so it lives while someone works and dies when they stop. Idle costs nothing.
  sleepAfter = "5m";

  envVars = { WORKER_HEALTH_URL: "https://dsh.alphaville.space/healthz" };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Cheap and offline: does not start the container. Used by the keepalive and by probes.
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "prod-tooling-dsh-shell" });
    }

    // Everything else wakes it and waits for the ports. Accessing the workspace IS the wake-up, so
    // there is no separate step to remember.
    const container = getContainer(env.DSH, "dsh");
    await container.startAndWaitForPorts({ ports: [8080, 22] });
    return Response.json({ started: true, instance: "dsh" });
  },
};
