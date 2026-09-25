// The Worker in front of the dsh developer workspace.
//
// Two routes. `GET /healthz` is liveness and deliberately does NOT touch the sandbox: a probe must
// never wake a stopped container, because a monitor that wakes it is a heartbeat by another name.
// `GET /ws/terminal` proxies a WebSocket upgrade to the container's PTY, and is the only way in.
//
// There is no command endpoint. One existed, unauthenticated, and executed arbitrary commands as
// root; see src/names.ts for why it is not coming back.
//
// The request IS the wake-up: touching the sandbox starts a stopped container on first use, so there
// is no separate start step to forget. Nothing keeps it awake from the inside; it stops `sleepAfter`
// after the last request, which is the whole cost control. An open terminal counts as activity, so
// it stays up while someone is typing and stops five minutes after they leave.
//
// WHY THE TERMINAL IS HERE AND NOT ON SSH. `wrangler containers ssh` is the obvious answer for
// "attach a shell" and it does not work under this lifecycle: Cloudflare's SSH guide states it
// connects only to a RUNNING instance, that it will not start a stopped one, and that a live SSH
// session does not keep a container alive - and wrangler exposes no `containers start`. So with
// `sleepAfter` set, an SSH-only design has no way back in after the first sleep. The upgrade being a
// request is exactly the property SSH lacks.
//
// AUTHENTICATION IS NOT HERE. It is Cloudflare Access, in front of the hostname, and that is
// deliberate: an earlier version of this Worker carried its own bearer check, which meant a
// hand-rolled credential compared in constant time, a token to distribute, and a second place for
// it to be wrong. Access does it at the edge, for HTTP and for the WebSocket upgrade, and the
// client holds a service token it can actually possess. One gate, not two.
//
// What this Cost: `/healthz` is now behind Access as well, because a pathless bypass policy
// bypasses the whole application rather than one route. A liveness probe therefore needs the
// service token; that is a smaller price than an administratively-open host to keep one route free.
//
// The lease Durable Object and the provisioner are not coming back in their old form: the lease had
// nothing to arbitrate for one operator. The R2 mount IS back, one route below, and in a narrower
// shape than the attempt that was abandoned: it backs the harness's session store and nothing else,
// because s3fs was measured unusably slow for the git/npm workload that `/workspace` carries.
import {
  DESCRIPTION_FIELD,
  GH_TOKEN_ENV,
  METHOD_FIELD,
  METHOD_GET,
  METHOD_POST,
  MODEL_KEY_ENV,
  OK_FIELD,
  ROUTES_FIELD,
  ROUTE_FIELD,
  ROUTE_AGENT,
  ROUTE_AGENT_PROFILE,
  ROUTE_AGENT_TIMEOUT_MS,
  ROUTE_HEALTHZ,
  ROUTE_ROOT,
  ROUTE_TERMINAL,
  SANDBOX_ID,
  SERVICE_FIELD,
  SERVICE_NAME,
  SLEEP_AFTER,
  STATE_BINDING,
  STATE_MOUNT_PATH,
  STATE_MOUNT_TIMEOUT_MS,
  STATE_PROBE_TIMEOUT_MS,
  AGENT_PROMPT_PATH,
  AGENT_SESSION,
  DSH_HOME_PATH,
  DSH_HOME_ENV,
  TERMINAL_SHELL,
  WEBSOCKET_UPGRADE,
} from "./names";
import { getSandbox, type SandboxOptions } from "@cloudflare/sandbox";
import type { Sandbox } from "./sandbox";

/**
 * BOTH exports are required. The second is not optional, and its absence is what stopped this
 * container from ever starting.
 *
 * `Sandbox` is the Durable Object class the `containers` binding names. `ContainerProxy` is a
 * WorkerEntrypoint the SDK builds its outbound-interception fetchers through, and the SDK states the
 * requirement in its own source (sandbox-D0rNqxlr.js:7201-7206): "Users must export this class from
 * their Worker entrypoint so the Sandbox DO can create outbound-interception fetchers that
 * reference it."
 *
 * When it is missing, the base Container class throws (containers/dist/lib/container.js:1176):
 *
 *   ctx.exports.ContainerProxy is undefined, export ContainerProxy from the containers package
 *   in your worker entrypoint
 *
 * Why it fires here even though nothing mounts anything: interception is switched on by
 * `persistedOutboundConfiguration !== undefined` (container.js:362), and that configuration is
 * PERSISTED IN DURABLE OBJECT STORAGE (container.js:1065, key OUTBOUND_CONFIGURATION). The earlier
 * "Layer 1: the R2 binding mount" deploy called mountBucket, which set outbound handlers and wrote
 * that record. The mount code is gone; the record is not, and this is still the same object
 * (`SANDBOX_ID = "dsh"`), so every construction since restores it and turns interception back on.
 *
 * The symptom looked nothing like the cause: `container.startup` warned
 * "ctx.exports.ContainerProxy is undefined", the SDK retried eight times over 135 seconds, and all a
 * caller ever saw was 502 "Container is starting. Please retry in a moment." - permanently.
 *
 * The official minimal example exports only `Sandbox` and gets away with it precisely because it
 * never mounts, so it never persists an outbound configuration. Any app that has ever mounted one
 * needs this export permanently.
 */
export { ContainerProxy } from "@cloudflare/sandbox";

// Our Sandbox subclass, not the SDK's. It exists to save uncommitted work when the platform stops
// the container - see src/sandbox.ts for why that is necessary and what it does and does not do.
export { Sandbox } from "./sandbox";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  STATE: R2Bucket;
  [MODEL_KEY_ENV]?: string;
  [GH_TOKEN_ENV]?: string;
}

/**
 * `keepAlive` is deliberately absent: its default, false, is what lets the container stop.
 *
 * `enableDefaultSession` is on because sessionless sandbox calls land in the default session; the
 * terminal below names its session explicitly anyway, so that the type-safe `ExecutionSession` path
 * is used rather than the sandbox-level convenience method - the SDK installs that method on the
 * proxy at runtime (sandbox.ts:955-956) but the 0.12.9 `Sandbox` type returns `as T` (line 987) and
 * does not declare it, so calling it from TypeScript needs a cast. Naming the session avoids the
 * cast without pretending the method is not there.
 */
const SANDBOX_OPTIONS: SandboxOptions = {
  sleepAfter: SLEEP_AFTER,
  enableDefaultSession: true,
};

/**
 * The session the terminal attaches to.
 *
 * Stable on purpose: disconnecting leaves the PTY and its scrollback alive, so reattaching replays
 * what happened while you were away. A session per connection would throw that away, which is the
 * opposite of what a terminal is for.
 */
const TERMINAL_SESSION = "dsh";

function sandboxFor(env: Env): Sandbox {
  return getSandbox(env.Sandbox, SANDBOX_ID, SANDBOX_OPTIONS);
}

/**
 * Put the model credential into the container's environment, where the harness looks for it.
 *
 * This is the join between the two halves of the design. The credential lives in a Worker SECRET -
 * never in the image, never in this repository, never in the profile's settings, which name the
 * environment variable rather than carrying its value. `settings.yaml` says
 * `apiKeyEnv: CF_AI_GATEWAY_TOKEN`, so the container has to have that variable set or the
 * harness starts and then cannot reach a model at all.
 *
 * The SDK has no `envVars` option on `getSandbox`; `setEnvVars` is the API, so this runs before each
 * operation rather than once at construction. That is idempotent and cheap - the SDK stores the
 * values against the sandbox - and it means a rotated secret takes effect on the next request rather
 * than on the next container.
 *
 * If the secret is absent this does nothing and the environment still works as a shell. Failing the
 * request instead would trade a usable workspace for a clear error message, which is the wrong way
 * round: the harness reports its own missing key far better than a 500 from here would.
 */
async function injectSecrets(sandbox: Sandbox, env: Env): Promise<void> {
  const values: Record<string, string> = {};

  const modelKey = env[MODEL_KEY_ENV];
  if (typeof modelKey === "string" && modelKey.length > 0) values[MODEL_KEY_ENV] = modelKey;

  // gh's credential. Its absence is not fatal: the environment still works as a shell, and the
  // harness reports a missing model key far better than a failed request here would. What it costs
  // is the ability to clone and push, which dsh-prime reports plainly when it runs.
  const ghToken = env[GH_TOKEN_ENV];
  if (typeof ghToken === "string" && ghToken.length > 0) values[GH_TOKEN_ENV] = ghToken;

  if (Object.keys(values).length === 0) return;
  await sandbox.setEnvVars(values);
}

/**
 * Liveness. Deliberately does not touch the sandbox: a probe must never wake a stopped container.
 *
 * Unauthenticated, and that is a decision rather than an oversight: it reports only that this Worker
 * exists, reveals nothing about the sandbox, and a liveness probe that needs a credential is a probe
 * that fails for the wrong reason. It must stay incapable of waking anything.
 */
function health(): Response {
  return Response.json({ [OK_FIELD]: true, [SERVICE_FIELD]: SERVICE_NAME });
}

/**
 * What this Worker answers, so the surface is discoverable without reading the source. Behind the
 * bearer check, unlike liveness, because the route table is not public information.
 */
function describe(): Response {
  return Response.json({
    [SERVICE_FIELD]: SERVICE_NAME,
    [ROUTES_FIELD]: [
      { [ROUTE_FIELD]: ROUTE_ROOT, [METHOD_FIELD]: METHOD_GET, [DESCRIPTION_FIELD]: "this description" },
      { [ROUTE_FIELD]: ROUTE_HEALTHZ, [METHOD_FIELD]: METHOD_GET, [DESCRIPTION_FIELD]: "liveness; does not wake the sandbox" },
      { [ROUTE_FIELD]: ROUTE_TERMINAL, [METHOD_FIELD]: METHOD_GET, [DESCRIPTION_FIELD]: "interactive terminal; needs a WebSocket upgrade" },
      { [ROUTE_FIELD]: ROUTE_AGENT, [METHOD_FIELD]: METHOD_POST, [DESCRIPTION_FIELD]: "prompt a session over ACP and read its reply; bounded to one fixed profile" },
      { [ROUTE_FIELD]: ROUTE_AGENT, [METHOD_FIELD]: "GET + WebSocket", [DESCRIPTION_FIELD]: "the same turn as it happens: send one prompt, receive session/chunk/done frames" },
    ],
  });
}

/** What the mount probe prints, so the answer is matched by name rather than by exit code alone. */
const MOUNTED = "STATE-MOUNTED";

/**
 * Give a promise a deadline, and say which one ran out.
 *
 * There is no `AbortSignal` on `mountBucket`, so this cannot cancel the mount - it stops WAITING for
 * it, which is the property that matters here: the request has to finish. The abandoned operation
 * settles on its own or not at all, and the next request asks the container rather than the SDK
 * whether the path is mounted, so a mount that eventually lands is still picked up.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: number | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Back the container's session store with R2, before the PTY that will read it opens.
 *
 * WHY THIS IS HERE AND NOT IN A LIFECYCLE HOOK. Two earlier attempts restored and captured the store
 * from `onStart`/`onActivityExpired`; after an eight-minute sleep the container still came back cold,
 * re-cloned its repositories and printed `[no stored conversation to attach to: starting a new one]`.
 * A hook is a maybe. This runs where the operator actually arrives - a `GET /ws/terminal` upgrade is
 * a real request, and it is the same request that starts a stopped container - so the backing is
 * established on exactly the path that reads it.
 *
 * WHY IT ASKS THE CONTAINER FIRST. `s3fs` refuses a mount point that already has a mount, and the
 * SDK's own bookkeeping (`activeMounts`) lives in the Durable Object's memory, where it can outlive
 * the container it describes. `mountpoint` inside the container is the ground truth; when it says
 * the path is mounted, there is nothing to do and nothing to re-do.
 */
async function ensureStateMounted(sandbox: Sandbox): Promise<string> {
  const started = Date.now();
  // THE PROBE IS BOUNDED, AND IT HAS TO BE.
  //
  // This was the one `exec` in the file with no `timeout`, and the measured cost of that was the
  // terminal never opening: `wrangler tail` showed `exec` and `getSession` both returning
  // `outcome=canceled` at 29.7s with no exception, immediately after
  // `dsh: terminal session ready; backing the session store`, and no `session store backing:` line
  // ever followed. The inner 30s `withTimeout` below bounds `mountBucket` but cannot help a `mountpoint`
  // call that never returns, because the timeout wraps the OUTER promise and the request is what gets
  // canceled - so the route died inside the mount and never reached `session.terminal()`. Every
  // subsequent alarm then found no container instance to give, which is why the log read
  // `There is no container instance that can be provided to this Durable Object` once a second.
  //
  // A probe that answers "mounted" or "not-mounted" in milliseconds is the normal case; one that
  // hangs is a broken container, and the store being unbacked for this session is the documented
  // fallback (the caller below logs it and opens the terminal anyway) rather than a dead route.
  const probe = await withTimeout(
    sandbox.exec(
      `mountpoint -q ${STATE_MOUNT_PATH} && echo ${MOUNTED} || echo not-mounted`,
      { timeout: STATE_PROBE_TIMEOUT_MS },
    ),
    STATE_PROBE_TIMEOUT_MS,
    "the state mount probe",
  );
  console.log(
    `dsh: state mount probe answered in ${Date.now() - started}ms: ` +
      `${probe.stdout.trim() || probe.stderr.trim()}`,
  );
  if (probe.stdout.includes(MOUNTED)) return "already mounted";

  console.log(`dsh: mounting ${STATE_BINDING} at ${STATE_MOUNT_PATH}`);
  const mount = () => withTimeout(
    sandbox.mountBucket(STATE_BINDING, STATE_MOUNT_PATH, {}),
    STATE_MOUNT_TIMEOUT_MS,
    "mountBucket",
  );
  try {
    await mount();
  } catch (first) {
    // THE RETRY IS THE WHOLE POINT, AND REMOVING IT COST THE STORE.
    //
    // The SDK may still hold a mount record for a container that is gone - `activeMounts` lives in
    // the Durable Object's memory, which outlives the container it describes - and it refuses a
    // second mount at a path it believes is in use. Clearing that record is what lets the retry reach
    // s3fs at all. An unmount of a mount that is not there is itself an error and not an interesting
    // one, because the mount below is the thing being attempted.
    //
    // This was deleted in commit d8682e9 ("Bound the state mount") in favour of a bare rethrow, and
    // the effect was measured today: the container booted with
    // `[the session store is NOT backed by R2: /mnt/state is not a mount point]`, the terminal still
    // opened because the caller swallows a mount failure, and after the next sleep there was
    // `[no stored conversation to attach to: starting a new one]`. A bounded mount that fails is not
    // an improvement over an unbounded one that succeeds.
    console.log(`dsh: first mount attempt failed (${describeError(first)}); clearing and retrying`);
    try {
      await sandbox.unmountBucket(STATE_MOUNT_PATH);
    } catch {
      // Deliberately ignored: see above.
    }
    await mount();
    return "mounted after clearing a stale mount record";
  }
  return "mounted";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/**
 * The agent surface: prompt a session over ACP and return its reply.
 *
 * WHY THIS EXISTS. Driving the remote session meant scraping ANSI off a terminal that redraws
 * constantly, and the tell-tale failure was that my own input came back looking like the model's
 * answer — several rounds went into telling them apart with nothing to show for it. ACP is the
 * protocol the harness already ships for out-of-process control (`dsh-acp`), and it answers the
 * provider-picking question that `dsh-sdk-jsonrpc-server` cannot: that plugin gates the provider
 * through `hasAdapterFor()` and rejects a pi-ai route, while ACP's provider is an ordinary config
 * row, so it runs on our gateway like everything else.
 *
 * BOUNDED BY CONSTRUCTION. `POST /run` existed once and executed arbitrary commands as root; it
 * answered 200 to an anonymous curl. This route runs one fixed program — `dsh --profile acp` — with
 * a prompt in place of any command. There is no command field, no shell and no profile selection,
 * so there is no path from a request field to argv. The prompt is passed as one argument and read
 * back from stdout, which the ACP server is documented to reserve for JSON-RPC frames.
 *
 * Returns `text` (the assistant's reply), `stopReason`, and `usage`. It fails loudly: a route that
 * silently returns an empty reply would be indistinguishable from a session that ignored the prompt.
 */
/**
 * The environment every `agent-ask` run needs, stated rather than inherited.
 *
 * WHY THIS IS NOT LEFT TO THE IMAGE. The image sets `DSH_HOME=/root/.dsh` with an `ENV` line and the
 * container is given `CF_AI_GATEWAY_TOKEN` through `setEnvVars`. Neither is visible to an `exec`
 * environment: the ACP session failed with
 *
 *   session/new: Internal error {"details":"no adapter registered for provider \"cf-ai-gateway\""}
 *
 * which is what the harness reports when the pi-ai provider list is empty - and the list is empty
 * when `settings.yaml` cannot be found under `DSH_HOME`, or when the provider's `apiKeyEnv` variable
 * is not set. The profile resolved (`--profile acp` started an ACP server and answered), so the
 * symptom is specifically the settings/credential half of the environment. Naming all three here
 * makes the route independent of what the exec environment happens to carry.
 */
/**
 * A prompt as a base64 payload, so it can travel on a command line without being code.
 *
 * WHY NOT `sandbox.writeFile`, WHICH IS WHAT THIS REPLACED. Measured with `wrangler tail` against the
 * live Worker: `RPC writeFile` came back `outcome=canceled` at 69s and the `exec` that depended on it
 * never ran at all - so the route stalled before the model was ever asked anything. A file API call
 * that does not return is a worse foundation for a control surface than a shell command that is
 * provably inert.
 *
 * base64 is `[A-Za-z0-9+/=]`, so the payload has no quote, no `$`, no backtick and no backslash: it
 * cannot break out of the single quotes it is wrapped in, and it cannot be interpreted as anything.
 * The prompt becomes data on a command line rather than syntax on one, which is the property the
 * previous `JSON.stringify` interpolation did not have.
 */
/**
 * Fetch the workspace if it is not there yet, with every byte of it on stderr.
 *
 * WHY THE AGENT ROUTE PRIMES AND DID NOT. `dsh-session` runs `dsh-prime` before the TUI - that is what
 * makes a session "primed" rather than "primed if you remember" - and the agent route had no such
 * step, so the first real turn through it reported, correctly and honestly:
 *
 *   /workspace contains only my probe file. No agency repo.
 *
 * The container's disk resets when it sleeps, so an unprimed workspace is the normal state on this
 * path, not an edge case.
 *
 * THE OUTPUT GOES TO STDERR BECAUSE STDOUT IS THE REPLY. `dsh-prime` prints progress as it clones, and
 * on stdout that text would land in front of the assistant's message - in the buffered route it would
 * be concatenated into `text`, and in the streaming route it would arrive as a `chunk` that looks like
 * the model talking. Everything a prime says belongs beside the reply, never inside it.
 */
const PRIME_COMMAND = '{ [ -d /workspace/agency ] || dsh-prime >&2; }; ';

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function agentEnv(env: Env): Record<string, string> {
  const values: Record<string, string> = {
    HOME: "/root",
    [DSH_HOME_ENV]: DSH_HOME_PATH,
  };
  const modelKey = env[MODEL_KEY_ENV];
  if (typeof modelKey === "string" && modelKey.length > 0) values[MODEL_KEY_ENV] = modelKey;
  return values;
}

async function agent(sandbox: Sandbox, request: Request, env: Env): Promise<Response> {
  if (request.method !== METHOD_POST) {
    return new Response("the agent route takes a prompt: POST {\"prompt\": \"...\"}", { status: 405 });
  }

  let body: { prompt?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "the body must be JSON" }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  // A bound on size, not on content: this is a message to a model, and an unbounded one would be a
  // way to spend a session' budget with a single request.
  if (prompt.length === 0 || prompt.length > 8000) {
    return Response.json({ error: "prompt must be 1..8000 characters" }, { status: 400 });
  }

  const started = Date.now();
  // THE PROMPT IS A FILE, NOT AN ARGUMENT, AND THAT IS A SECURITY PROPERTY.
  //
  // The previous version interpolated `JSON.stringify(prompt)` into a shell command line. Inside
  // double quotes the shell still performs command substitution, so a prompt containing `$(...)` or
  // backticks executed in the container - on a route that exists precisely so no request field can
  // reach argv. Writing it to a fixed path and letting the script read it removes the shell from the
  // path entirely: the only thing interpolated here is a constant.
  const session = await sandbox.getSession(AGENT_SESSION);
  const result = await session.exec(
    PRIME_COMMAND +
      `printf %s '${toBase64(prompt)}' | base64 -d > ${AGENT_PROMPT_PATH} && ` +
      `AGENT_PROMPT_FILE=${AGENT_PROMPT_PATH} AGENT_PROFILE=${ROUTE_AGENT_PROFILE} ` +
      `node /usr/local/bin/agent-ask`,
    { timeout: ROUTE_AGENT_TIMEOUT_MS, env: agentEnv(env) },
  );
  const stdout = (result.stdout ?? "").trim();
  const exitCode = result.exitCode ?? 1;
  // `agent-ask` exits 0 only on `end_turn` with a non-empty reply, so exit code and text agree: a
  // truncated or refused turn is reported as one rather than presented as an answer.
  return Response.json({
    text: stdout,
    stopReason: exitCode === 0 ? "end_turn" : "failed",
    exitCode,
    stderr: (result.stderr ?? "").slice(-400),
    elapsedMs: Date.now() - started,
  });
}

/**
 * The same agent surface over a WebSocket, for callers that want the turn as it happens.
 *
 * WHY THIS EXISTS ON TOP OF `POST /agent`. The one-shot route holds an HTTP request open for the
 * whole model turn - measurably the expensive shape here - and it shows the caller nothing until the
 * turn is over. A WebSocket sends the prompt once and forwards each frame as it arrives, so the
 * caller sees `session`, then `chunk` per assistant delta, then `done`; the socket is also the live
 * request that keeps the container awake for exactly as long as somebody is listening, which is the
 * same property the terminal relies on and the reason neither needs a keepalive.
 *
 * THE TRANSPORT IS THE ONLY DIFFERENCE. Both routes run the identical fixed program with the prompt
 * as an argument, so this adds no capability: there is still no command field, no shell and no
 * profile selection. `AGENT_ASK_STREAM=1` is what makes `agent-ask` write newline-delimited JSON
 * instead of a bare reply, and those lines are forwarded verbatim - the Worker parses nothing, so a
 * framing change cannot silently become an answer.
 *
 * ONE PROMPT PER SOCKET, deliberately. The session is shared, and a socket that could queue several
 * prompts would interleave turns of the same conversation with no ordering the caller can see. Ask,
 * read the answer, close, reconnect.
 */
async function agentStream(sandbox: Sandbox, request: Request, env: Env): Promise<Response> {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const send = (value: unknown) => {
    try {
      server.send(JSON.stringify(value));
    } catch {
      // The peer is gone; nothing to report it to.
    }
  };

  server.addEventListener("message", async (event) => {
    let prompt = "";
    try {
      const parsed = JSON.parse(typeof event.data === "string" ? event.data : "") as { prompt?: unknown };
      prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
    } catch {
      // Falls through to the empty-prompt error below.
    }
    if (prompt.length === 0) {
      send({ type: "error", message: 'send {"prompt": "..."}' });
      return;
    }
    // Same bound as the POST route, for the same reason: one message must not spend a whole budget.
    if (prompt.length > 8000) {
      send({ type: "error", message: "prompt must be 1..8000 characters" });
      return;
    }

    send({ type: "started" });
    let partial = "";
    // Each container stdout line is one JSON frame from `agent-ask`, forwarded as its own socket
    // message. A chunk boundary can split a line, so the remainder is kept until its newline lands.
    const forward = (data: string) => {
      partial += data;
      let nl: number;
      while ((nl = partial.indexOf("\n")) !== -1) {
        const line = partial.slice(0, nl).trim();
        partial = partial.slice(nl + 1);
        if (line.length > 0) send({ type: "frame", raw: line });
      }
    };

    try {
      const agentSession = await sandbox.getSession(AGENT_SESSION);
      const result = await agentSession.exec(
        PRIME_COMMAND +
          `printf %s '${toBase64(prompt)}' | base64 -d > ${AGENT_PROMPT_PATH} && ` +
          `AGENT_PROMPT_FILE=${AGENT_PROMPT_PATH} AGENT_PROFILE=${ROUTE_AGENT_PROFILE} ` +
          `AGENT_ASK_STREAM=1 node /usr/local/bin/agent-ask`,
        {
          timeout: ROUTE_AGENT_TIMEOUT_MS,
          env: agentEnv(env),
          stream: true,
          // stderr is forwarded as its own frame type rather than parsed as protocol. It is where
          // `dsh --profile headless` streams its REASONING and where every diagnostic lands, so
          // dropping it (the previous behaviour) left a stalled turn with nothing to read: the route
          // could say that nothing came back but never why.
          onOutput: (stream, data) => {
            if (stream === "stdout") forward(data);
            else send({ type: "stderr", text: data });
          },
        },
      );
      if (partial.trim().length > 0) send({ type: "frame", raw: partial.trim() });
      // The captured stderr tail travels with the exit, because a run can fail before it prints
      // anything to the stream (a spawn error, a boot failure) and then the frames alone say nothing.
      send({
        type: "exit",
        exitCode: result.exitCode ?? 1,
        stderr: (result.stderr ?? "").slice(-2000),
      });
    } catch (error) {
      send({ type: "error", message: describeError(error) });
    } finally {
      try {
        server.close(1000, "turn complete");
      } catch {
        // Already closed by the peer.
      }
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

/** The interactive terminal: back the session store, then hand the upgrade to the SDK. */
async function terminal(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== WEBSOCKET_UPGRADE) {
    return new Response("the terminal route needs a WebSocket upgrade", { status: 426 });
  }

  // The explicit session is what makes this type-safe; see TERMINAL_SESSION and SANDBOX_OPTIONS.
  const sandbox = sandboxFor(env);
  await injectSecrets(sandbox, env);

  // The container is started HERE, before the mount is timed. A cold start is the whole point of this
  // path, so timing the mount from before the container exists would abandon it on exactly the
  // reconnect it is for. Naming the session is the wait, and the platform bounds it.
  const session = await sandbox.getSession(TERMINAL_SESSION);
  console.log("dsh: terminal session ready; backing the session store");

  try {
    const backed = await withTimeout(
      ensureStateMounted(sandbox),
      STATE_MOUNT_TIMEOUT_MS,
      "the state mount",
    );
    console.log(`dsh: session store backing: ${backed}`);
  } catch (error) {
    console.log(
      `dsh: could not back the session store with R2: ${describeError(error)}. The terminal still ` +
        `opens; the store is on the container's ephemeral disk for this session.`,
    );
  }

  return await session.terminal(request, { shell: TERMINAL_SHELL });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === METHOD_GET && url.pathname === ROUTE_HEALTHZ) return health();
    if (request.method === METHOD_GET && url.pathname === ROUTE_ROOT) return describe();
    if (url.pathname === ROUTE_AGENT) {
      const sandbox = sandboxFor(env);
      await injectSecrets(sandbox, env);
      // The upgrade is what makes this the streaming surface; without it the same path is the
      // one-shot JSON route, so a caller that only wants an answer needs no second URL.
      if (request.headers.get("Upgrade")?.toLowerCase() === WEBSOCKET_UPGRADE) {
        return await agentStream(sandbox, request, env);
      }
      return await agent(sandbox, request, env);
    }
    if (url.pathname === ROUTE_TERMINAL) return await terminal(request, env);

    return new Response("not found", { status: 404 });
  },
};