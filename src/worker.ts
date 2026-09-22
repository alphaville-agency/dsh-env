// The Worker in front of the container exists for two reasons: Containers reach the world through a
// Worker, and a stopped container is not woken by `wrangler containers ssh` - so something must ask
// for it. Any request does.
import { Container, getContainer } from "@cloudflare/containers";

export class DshShell extends Container<Env> {
  // The image runs an HTTP responder on 8080 for the platform's startup health check and sshd on 22
  // for the session. sshd cannot answer the check because it does not speak HTTP.
  defaultPort = 8080;
  // Only the HTTP port. The platform verifies every port listed here, and SSH cannot answer an
  // availability probe on 22 - listing it made every start fail with "failed to verify port 22".
  // SSH is declared separately in wrangler.jsonc and reached with `wrangler containers ssh`.
  requiredPorts = [8080];

  // Shut down five minutes after the last request. The image polls this Worker while a session is
  // attached, so it lives while someone works and dies when they stop. Idle costs nothing.
  sleepAfter = "5m";

  // Passed at start rather than baked in: the object-store credentials live as Worker secrets so
  // the workspace's state can persist without a credential ever entering the repository or image.
  envVars = { WORKER_HEALTH_URL: "https://dev-dsh.alphaville.space/healthz" };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Cheap and offline: does not start the container. Used by the keepalive and by probes.
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "dev-tooling-dsh-shell" });
    }

    // Everything else wakes it and waits for the ports. Accessing the workspace IS the wake-up, so
    // there is no separate step to remember.
    const container = getContainer(env.DSH, "dsh");
    await container.startAndWaitForPorts({
      ports: [8080],
      startOptions: {
        envVars: {
          WORKER_HEALTH_URL: "https://dev-dsh.alphaville.space/healthz",
          // Worker secrets, passed through at start. Not in this file, not in the image.
          ...(env.R2_ACCESS_KEY_ID ? {
            R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
            R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
            R2_ENDPOINT: env.R2_ENDPOINT,
            DSH_STATE_REMOTE: "r2:af-dev-tooling-dsh/home",
          } : {}),
        },
      },
    });
    return Response.json({ started: true, instance: "dsh", state: env.R2_ACCESS_KEY_ID ? "r2" : "ephemeral" });
  },
};
