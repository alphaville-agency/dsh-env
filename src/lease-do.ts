/**
 * The lease Durable Object: one holder for input, one upstream terminal socket, and one awake
 * declaration.
 *
 * Why this exists at all. `sandbox.terminal(request)` proxies the WebSocket upgrade straight through
 * to the container, and a Worker cannot read or filter frames after it has returned an upgrade
 * response. The container's own PTY handler treats every connection as equal: it writes any binary
 * frame it receives into the shared PTY and broadcasts every byte of output to all of them
 * (`packages/sandbox-container/src/handlers/pty-ws-handler.ts`). So "let a second client watch but
 * not type" is impossible by forwarding the upgrade - somebody has to *terminate* it.
 *
 * This object is that somebody. It holds the one upstream socket and gives each client its own
 * downstream socket, so it sits in the middle and decides which frames travel upstream. That is the
 * shape the SDK's own `examples/collaborative-terminal` uses, and `proxyTerminal` - which
 * `sandbox.terminal()` is a thin wrapper over - is a public export for exactly it.
 *
 * Three things live here and must not be conflated: the input lease, the awake lease, and the
 * fan-out. The pure state machines for the first two are in `src/leases.ts`; this file is only
 * plumbing - sockets, storage, and the container.
 *
 * The hard rule this file is written around: **an open WebSocket to the container keeps it awake**.
 * `@cloudflare/containers` counts a proxied WebSocket as in flight until it closes, and
 * `isActivityExpired()` refuses to expire while anything is in flight, so `sleepAfter` never fires
 * while one is open. The upstream socket is therefore opened when a client attaches and closed the
 * moment the last one leaves - see `detach()`. Holding it open to "keep things warm" would be a
 * keepalive by another name, which is the defect this repo was already rebuilt once to remove.
 */
import { DurableObject } from "cloudflare:workers";
import { getSandbox, type PtyOptions, type Sandbox, type SandboxOptions } from "@cloudflare/sandbox";
import {
  awakeLeaseActive,
  beginWork,
  emptyAwakeLease,
  emptyInputLease,
  endWork,
  expireWork,
  holdsInputLease,
  releaseInputLease,
  releaseInputLeaseIfAbsent,
  requestInputLease,
  touchInputLease,
  type AwakeLease,
  type InputLease,
} from "./leases";
import {
  CLIENT_PARAM,
  CODE_FIELD,
  COLS_FIELD,
  DATA_FIELD,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  FRESH_FIELD,
  HINT_FIELD,
  HOLDER_FIELD,
  LEASE_TTL_MS,
  MESSAGE_FIELD,
  MSG_COMMAND,
  MSG_ERROR,
  MSG_EXIT,
  MSG_LOST,
  MSG_READONLY,
  MSG_READY,
  MSG_RESIZE,
  ROWS_FIELD,
  SANDBOX_ID,
  SLEEP_AFTER,
  STORAGE_AWAKE_LEASE,
  STORAGE_INPUT_LEASE,
  TAKEOVER_FLAG,
  TAKEOVER_PARAM,
  TAKEOVER_SET,
  TYPE_FIELD,
  UPSTREAM_TERMINAL_URL,
  WEBSOCKET_UPGRADE,
  WORK_ACTION_FIELD,
  WORK_BEGIN,
  WORK_END,
  WORK_TOKEN_FIELD,
  WORK_TTL_MS,
} from "./names";

/** The bindings this object needs. Only the sandbox: both leases are its own storage. */
export interface LeaseEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

/** `keepAlive` is deliberately absent: the awake lease drives it, not a constructor default. */
const SANDBOX_OPTIONS: SandboxOptions = {
  sleepAfter: SLEEP_AFTER,
  enableDefaultSession: false,
};

/**
 * Status codes and one-line bodies. These are HTTP contract rather than identifiers this repo
 * owns, so they are named here rather than in `src/names.ts`.
 */
const STATUS_UPGRADE_REQUIRED = 426;
const STATUS_BAD_REQUEST = 400;
const STATUS_FORBIDDEN = 403;
const STATUS_CONFLICT = 409;
const NEEDS_UPGRADE = "the terminal route needs a WebSocket upgrade";
const UPSTREAM_CLOSED = "the workspace terminal closed";
const UPSTREAM_UNAVAILABLE = "the workspace terminal could not be opened";
const CLOSE_NORMAL = 1000;

/**
 * `terminal()` exists on the object the runtime hands back but is missing from the installed stable
 * typings: @cloudflare/sandbox 0.12.9 declares it on `ExecutionSession` only. Same deliberate cast
 * the Worker used to carry, for the same type gap; delete it when `Sandbox` declares `terminal`.
 */
type TerminalHost = {
  terminal(request: Request, options?: PtyOptions): Promise<Response>;
};

/**
 * What is stapled to each attached client socket. It is a WebSocket attachment rather than an entry
 * in a map so that it survives this object hibernating or being evicted: the socket and who it is
 * come back together. `fresh` is the bootstrap permission and is only ever set by `flush()`.
 */
interface ClientSocket {
  clientId: string;
  token: string;
  /** True while this socket may send input. Cleared the moment it is superseded. */
  holder: boolean;
  /** True when the terminal it is attached to was created by the current upstream connection. */
  fresh: boolean;
}

/**
 * What `declareWork` answers with. It carries a status because a Durable Object RPC cannot return an
 * HTTP response; the Worker turns it into one. Only the request that has no WebSocket upgrade can
 * use RPC at all, which is why the terminal stays on `fetch`.
 */
export type WorkResult =
  | { ok: true; token: string | null; until: number }
  | { ok: false; status: number; error: string };

/** Read one field of an untrusted JSON value without asserting its shape. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

export class DshLease extends DurableObject<LeaseEnv> {
  /** The one socket to the container. Null means no client is attached, or it just died. */
  private upstream: WebSocket | null = null;
  /** The in-flight (or settled) upstream connection, so concurrent attaches share one socket. */
  private upstreamOpen: Promise<boolean> | null = null;
  /** Resolves when the container reports the terminal ready, or when the socket closes. */
  private upstreamReady: (() => void) | null = null;
  /** Bytes the container replayed before it said ready. Zero means it had nothing to replay. */
  private replayed = 0;

  private sandbox(): Sandbox {
    return getSandbox(this.env.Sandbox, SANDBOX_ID, SANDBOX_OPTIONS);
  }

  // ================================================================================================
  // Storage. Both leases are Durable Object storage, so each is the same singleton in every isolate
  // and every region and survives hibernation. A Worker-local variable is none of those things,
  // which is why neither lease is kept in one.
  // ================================================================================================

  private async inputLease(): Promise<InputLease> {
    return (await this.ctx.storage.get<InputLease>(STORAGE_INPUT_LEASE)) ?? emptyInputLease();
  }

  private async saveInputLease(lease: InputLease): Promise<void> {
    await this.ctx.storage.put(STORAGE_INPUT_LEASE, lease);
  }

  private async awakeLease(): Promise<AwakeLease> {
    return (await this.ctx.storage.get<AwakeLease>(STORAGE_AWAKE_LEASE)) ?? emptyAwakeLease();
  }

  private async saveAwakeLease(lease: AwakeLease): Promise<void> {
    await this.ctx.storage.put(STORAGE_AWAKE_LEASE, lease);
  }

  // ================================================================================================
  // Routing
  // ================================================================================================

  override async fetch(request: Request): Promise<Response> {
    // Both expiries are evaluated here, lazily, on the only thing that ever calls this object.
    // Nothing schedules them, so an idle container is never woken just to be told it is idle.
    await this.lapseInputLease();
    await this.lapseWork();
    return await this.attach(request);
  }

  // ================================================================================================
  // The input lease: who may type
  // ================================================================================================

  private async attach(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== WEBSOCKET_UPGRADE) {
      return new Response(NEEDS_UPGRADE, { status: STATUS_UPGRADE_REQUIRED });
    }

    const url = new URL(request.url);
    const clientId = url.searchParams.get(CLIENT_PARAM) ?? crypto.randomUUID();
    const takeover = url.searchParams.get(TAKEOVER_PARAM) === TAKEOVER_SET;

    const outcome = requestInputLease(await this.inputLease(), {
      clientId,
      token: crypto.randomUUID(),
      takeover,
      now: Date.now(),
      ttlMs: LEASE_TTL_MS,
    });
    await this.saveInputLease(outcome.lease);

    const pair = new WebSocketPair();
    const server = pair[1];
    const attachment: ClientSocket = {
      clientId,
      token: outcome.granted ? (outcome.lease.token ?? "") : "",
      holder: outcome.granted,
      fresh: false,
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);

    // The displaced holder is told at once, on the socket it is still holding, before its next
    // keystroke can be dropped without it ever being told.
    if (outcome.superseded !== null) this.displace(outcome.superseded, clientId);

    // Opening the upstream starts the container; its `ready` is what flushes every client's role.
    // If it never comes up, say so on this socket rather than leaving a window that looks attached
    // and is not.
    this.ctx.waitUntil(
      this.openUpstream().then(async () => {
        if (this.upstream === null) {
          this.sendControl(server, {
            [TYPE_FIELD]: MSG_ERROR,
            [MESSAGE_FIELD]: UPSTREAM_UNAVAILABLE,
          });
          return;
        }
        await this.flush();
      }),
    );
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Tell every attached client which side of the input lease it is on. This runs on each upstream
   * connect, not once per socket, so a client that reconnects after the terminal dropped is told
   * again rather than being left silent.
   */
  private async flush(): Promise<void> {
    if (this.upstream === null) return;
    const lease = await this.inputLease();
    const now = Date.now();
    // A terminal that had nothing to replay has just been created, so this connection is the one
    // that may bootstrap it. A terminal that replayed a screen is already running, and injecting
    // `exec dsh` into it would type the command into whatever is there.
    const fresh = this.replayed === 0;

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ClientSocket | null;
      if (attachment === null) continue;
      const typing = holdsInputLease(lease, attachment.clientId, attachment.token, now);
      socket.serializeAttachment({ ...attachment, holder: typing, fresh });
      if (typing) {
        this.sendControl(socket, { [TYPE_FIELD]: MSG_READY, [FRESH_FIELD]: fresh });
      } else {
        this.sendControl(socket, {
          [TYPE_FIELD]: MSG_READONLY,
          [HOLDER_FIELD]: lease.holder,
          [HINT_FIELD]: TAKEOVER_FLAG,
        });
      }
    }
  }

  /**
   * Drop the lease from a holder that is no longer attached. The socket set is authoritative: a
   * holder with no socket cannot be typing, whatever its TTL still says. The TTL is only a backstop
   * for a socket that died without an event.
   */
  private async lapseInputLease(): Promise<void> {
    const lease = await this.inputLease();
    if (lease.holder === null) return;
    const attached = this.ctx.getWebSockets().map((socket) => {
      const attachment = socket.deserializeAttachment() as ClientSocket | null;
      return attachment?.clientId ?? "";
    });
    await this.saveInputLease(releaseInputLeaseIfAbsent(lease, attached));
  }

  /** Take the input flag away from every socket of a client that has just been superseded. */
  private displace(clientId: string, newHolder: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ClientSocket | null;
      if (attachment === null || attachment.clientId !== clientId || !attachment.holder) continue;
      socket.serializeAttachment({ ...attachment, holder: false, fresh: false });
      this.sendControl(socket, {
        [TYPE_FIELD]: MSG_LOST,
        [HOLDER_FIELD]: newHolder,
        [HINT_FIELD]: TAKEOVER_FLAG,
      });
    }
  }

  /** A holder left while observers remain: say so, rather than leaving them guessing. */
  private announceFreeInput(sockets: WebSocket[]): void {
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment() as ClientSocket | null;
      if (attachment === null || attachment.holder) continue;
      this.sendControl(socket, {
        [TYPE_FIELD]: MSG_READONLY,
        [HOLDER_FIELD]: null,
        [HINT_FIELD]: TAKEOVER_FLAG,
      });
    }
  }

  // ================================================================================================
  // The downstream sockets
  // ================================================================================================

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as ClientSocket | null;
    if (attachment === null) return;

    const now = Date.now();
    const lease = await this.inputLease();
    const typing = holdsInputLease(lease, attachment.clientId, attachment.token, now);

    if (!typing) {
      // It still believes it may type. Correct it out loud: a window that silently discards
      // keystrokes is the worst possible failure of this feature.
      if (attachment.holder) {
        ws.serializeAttachment({ ...attachment, holder: false, fresh: false });
        this.sendControl(ws, {
          [TYPE_FIELD]: MSG_LOST,
          [HOLDER_FIELD]: lease.holder,
          [HINT_FIELD]: TAKEOVER_FLAG,
        });
      }
      return;
    }

    if (typeof message !== "string") {
      // A keystroke is the activity that renews the lease's TTL.
      await this.saveInputLease(
        touchInputLease(lease, attachment.clientId, { now, ttlMs: LEASE_TTL_MS }),
      );
      await this.forward(message);
      return;
    }

    let control: unknown;
    try {
      control = JSON.parse(message);
    } catch {
      return;
    }

    // A resize changes the one shared PTY for everyone, so a read-only observer never sends one -
    // but the check is here as well as in the client, because the client is not the authority.
    if (field(control, TYPE_FIELD) === MSG_RESIZE) {
      await this.forward(
        JSON.stringify({
          [TYPE_FIELD]: MSG_RESIZE,
          [COLS_FIELD]: field(control, COLS_FIELD),
          [ROWS_FIELD]: field(control, ROWS_FIELD),
        }),
      );
      return;
    }

    // The bootstrap command is the one input that must not be replayed into a terminal that is
    // already running, so it is forwarded only under the `fresh` permission `flush()` granted.
    if (field(control, TYPE_FIELD) === MSG_COMMAND) {
      if (attachment.fresh) await this.forward(String(field(control, DATA_FIELD) ?? ""));
      return;
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.detach(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.detach(ws);
  }

  private async detach(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as ClientSocket | null;
    const others = this.ctx.getWebSockets().filter((socket) => socket !== ws);

    if (others.length === 0) {
      // The last client has gone, so the container must be allowed to sleep. An open WebSocket to
      // the container counts as in flight and therefore keeps it awake indefinitely; closing this
      // is what starts the `sleepAfter` countdown, and it is the whole cost story of this feature.
      this.closeUpstream();
      await this.saveInputLease(emptyInputLease());
      return;
    }

    if (attachment === null) return;

    const lease = await this.inputLease();
    const sameClientAttached = others.some((socket) => {
      const other = socket.deserializeAttachment() as ClientSocket | null;
      return other?.clientId === attachment.clientId;
    });

    // A clean disconnect frees the lease at once, so the next client does not have to wait out the
    // TTL before it can take it.
    if (lease.holder === attachment.clientId && !sameClientAttached) {
      await this.saveInputLease(releaseInputLease(lease, attachment.clientId));
      this.announceFreeInput(others);
    }
  }

  // ================================================================================================
  // The one upstream socket
  // ================================================================================================

  /**
   * Open the upstream terminal if it is not open. The returned flag is whether this connection
   * created the terminal, which is the bootstrap permission `flush()` hands out.
   *
   * ponytail: freshness is inferred from "the container had nothing to replay", not from a
   * first-class "new terminal" signal, because the PTY protocol does not offer one. The failure
   * direction is safe - a terminal with an empty ring buffer that is not actually new would get one
   * `exec dsh` typed into it - and the ring buffer is only cleared when the PTY is destroyed, so an
   * existing terminal has essentially always replayed something. The upgrade path is for the
   * container to say so explicitly, which would need a change in `@cloudflare/sandbox` itself.
   */
  private async openUpstream(): Promise<boolean> {
    if (this.upstreamOpen === null) this.upstreamOpen = this.connectUpstream();
    try {
      return await this.upstreamOpen;
    } catch {
      this.upstreamOpen = null;
      return false;
    }
  }

  private async connectUpstream(): Promise<boolean> {
    const host = this.sandbox() as unknown as TerminalHost;
    const response = await host.terminal(
      new Request(UPSTREAM_TERMINAL_URL, {
        headers: { Upgrade: WEBSOCKET_UPGRADE, Connection: "Upgrade" },
      }),
      { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
    );

    const upstream = response.webSocket;
    if (upstream === null) throw new Error(UPSTREAM_UNAVAILABLE);

    this.replayed = 0;
    this.upstream = upstream;
    upstream.accept();

    const ready = new Promise<void>((resolve) => {
      this.upstreamReady = resolve;
    });
    upstream.addEventListener("message", (event) =>
      this.fromContainer(event.data as string | ArrayBuffer),
    );
    upstream.addEventListener("close", () => this.closedUpstream());
    upstream.addEventListener("error", () => this.closedUpstream());

    // Resolved by the container's `ready`, or by the socket closing, so this cannot hang on a
    // terminal that never answers.
    await ready;
    return this.replayed === 0;
  }

  private fromContainer(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      this.replayed += data.byteLength;
      this.broadcast(data);
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      this.broadcast(data);
      return;
    }

    const type = field(message, TYPE_FIELD);

    // `ready` is per-connection in the container's protocol, and it is the one frame that must not
    // be forwarded: every downstream client gets its own `ready` or `readonly` from `flush()`.
    if (type === MSG_READY) {
      const resolve = this.upstreamReady;
      this.upstreamReady = null;
      resolve?.();
      this.ctx.waitUntil(this.flush());
      return;
    }

    if (type === MSG_EXIT) {
      this.broadcast(
        JSON.stringify({
          [TYPE_FIELD]: MSG_EXIT,
          [CODE_FIELD]: field(message, CODE_FIELD),
        }),
      );
      this.closeUpstream();
      return;
    }

    if (type === MSG_ERROR) {
      this.broadcast(
        JSON.stringify({
          [TYPE_FIELD]: MSG_ERROR,
          [MESSAGE_FIELD]: field(message, MESSAGE_FIELD),
        }),
      );
      return;
    }

    this.broadcast(data);
  }

  private closedUpstream(): void {
    const wasOpen = this.upstream !== null;
    this.upstream = null;
    this.upstreamOpen = null;
    const resolve = this.upstreamReady;
    this.upstreamReady = null;
    resolve?.();
    if (!wasOpen) return;
    // Clients still attached are told, and the next keystroke from the holder reopens it. Reopening
    // is a request, not a poll: it happens because somebody did something.
    this.broadcast(JSON.stringify({ [TYPE_FIELD]: MSG_ERROR, [MESSAGE_FIELD]: UPSTREAM_CLOSED }));
  }

  private closeUpstream(): void {
    const upstream = this.upstream;
    this.upstream = null;
    this.upstreamOpen = null;
    const resolve = this.upstreamReady;
    this.upstreamReady = null;
    resolve?.();
    if (upstream === null) return;
    try {
      upstream.close(CLOSE_NORMAL, UPSTREAM_CLOSED);
    } catch {
      // A socket that has already gone is the outcome we wanted.
    }
  }

  private async forward(data: string | ArrayBuffer): Promise<void> {
    if (this.upstream === null) await this.openUpstream();
    const upstream = this.upstream;
    if (upstream === null) return;
    try {
      upstream.send(data);
    } catch {
      this.closedUpstream();
    }
  }

  // ================================================================================================
  // Fan-out
  // ================================================================================================

  private broadcast(data: string | ArrayBuffer): void {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, data);
  }

  private send(ws: WebSocket, data: string | ArrayBuffer): void {
    try {
      ws.send(data);
    } catch {
      // A dead socket is cleaned up by its own close/error event; there is nothing to do here.
    }
  }

  /** One control frame. Everything the client sees as JSON goes through here. */
  private sendControl(ws: WebSocket, message: Record<string, unknown>): void {
    this.send(ws, JSON.stringify(message));
  }

  // ================================================================================================
  // The awake lease: is work in progress
  //
  // Deliberately not connected to the input lease. A read-only observer is not work, and an agent
  // running a goal with no client attached is. Releasing one must never release the other.
  // ================================================================================================

  async declareWork(body: unknown): Promise<WorkResult> {
    const action = field(body, WORK_ACTION_FIELD);
    const supplied = field(body, WORK_TOKEN_FIELD);
    const now = Date.now();
    const current = await this.awakeLease();

    if (action === WORK_BEGIN) {
      const token = typeof supplied === "string" ? supplied : crypto.randomUUID();
      const outcome = beginWork(current, { token, now, ttlMs: WORK_TTL_MS });
      if (!outcome.ok) {
        return {
          ok: false,
          status: STATUS_CONFLICT,
          error: "another caller already declared work; end it with its token, or wait for it to lapse",
        };
      }
      await this.saveAwakeLease(outcome.lease);
      if (outcome.changed) await this.setAwake(true);
      await this.ctx.storage.setAlarm(outcome.lease.until);
      return { ok: true, token: outcome.lease.token, until: outcome.lease.until };
    }

    if (action === WORK_END) {
      if (typeof supplied !== "string") {
        return {
          ok: false,
          status: STATUS_BAD_REQUEST,
          error: `end needs the ${WORK_TOKEN_FIELD} that begin returned`,
        };
      }
      const outcome = endWork(current, { token: supplied, now });
      if (!outcome.ok) {
        return {
          ok: false,
          status: STATUS_FORBIDDEN,
          error: "that token does not own the current work declaration",
        };
      }
      await this.saveAwakeLease(outcome.lease);
      if (outcome.changed) await this.setAwake(false);
      await this.ctx.storage.deleteAlarm();
      return { ok: true, token: null, until: 0 };
    }

    return {
      ok: false,
      status: STATUS_BAD_REQUEST,
      error: `${WORK_ACTION_FIELD} must be ${WORK_BEGIN} or ${WORK_END}`,
    };
  }

  /**
   * Release a work declaration whose deadline has passed, on the way into any other request on this
   * object. This is the lazy half; the alarm is the half that works when nobody is attached.
   */
  private async lapseWork(): Promise<void> {
    const result = expireWork(await this.awakeLease(), Date.now());
    if (!result.released) return;
    await this.saveAwakeLease(result.lease);
    await this.setAwake(false);
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * The deadline is the answer to "what if the work-end message is never sent". Without it a
   * crashed run would pin the container awake forever, which is the defect this repo deleted once
   * already.
   *
   * This is a one-shot alarm at a deadline the caller declared - not a heartbeat. It is set once
   * per unit of work, it fires once, and it does not touch the container: releasing the awake lease
   * is pure Durable Object storage on the sandbox object, and `setKeepAlive` never starts a
   * container. It is also the only mechanism that can release the lease when nobody is attached to
   * check lazily, which is precisely the case that would otherwise wedge the workspace awake.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const current = await this.awakeLease();
    const result = expireWork(current, now);
    await this.saveAwakeLease(result.lease);
    if (result.released) {
      await this.setAwake(false);
      return;
    }
    if (awakeLeaseActive(result.lease, now)) await this.ctx.storage.setAlarm(result.lease.until);
  }

  /**
   * `keepAlive` is the platform's own "do not auto-shutdown" flag, persisted by the SDK across
   * hibernation. It is a lease on *awake* held only while work is declared - not a poll loop, and
   * not the keepalive script that was deleted. The distinction is truthfulness: this follows a
   * declaration from the thing doing the work, and it is released when that declaration ends or
   * lapses.
   */
  private async setAwake(awake: boolean): Promise<void> {
    await this.sandbox().setKeepAlive(awake);
  }
}
