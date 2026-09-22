/**
 * The two leases, as pure state machines.
 *
 * They are different things and the whole feature turns on not conflating them:
 *
 * - the **input lease** answers "who may type". Exactly one client holds it. Every other attached
 *   client is live - it sees output as it happens - and cannot send input.
 * - the **awake lease** answers "is work in progress". It is what keeps the container from sleeping
 *   in the middle of a task. It does not care who is attached: a read-only observer is not work,
 *   and an agent running a goal with nobody attached is.
 *
 * Both are pure functions of `(state, event, now)`, with no storage, no sockets and no clock of
 * their own. That is what lets `tests/leases.test.mjs` drive every rule - grant, refuse, takeover,
 * supersession, expiry, release - without a Durable Object, a container or a network.
 *
 * ponytail: there are no timers in here, deliberately. Every expiry is decided from the `now` it is
 * handed, so expiry is only ever evaluated when something actually happens. Nothing in this module
 * can keep a container awake, which is the repo's hard cost rule (docs/COST.md).
 *
 * This module imports nothing, on purpose: Node loads it directly in the test suite by stripping
 * types, and an extensionless import would not resolve outside a bundler.
 */

/** Who may type. `expiresAt` is renewed by any frame from the holder. */
export interface InputLease {
  holder: string | null;
  token: string | null;
  /**
   * Monotonically increasing, and bumped only when a holder is *displaced*. A superseded holder
   * compares the token it was granted against the current one to discover it lost the lease.
   */
  takeovers: number;
  expiresAt: number;
}

export interface InputLeaseRequest {
  clientId: string;
  /** The opaque token minted for this client's socket. */
  token: string;
  takeover: boolean;
  now: number;
  ttlMs: number;
}

export interface InputLeaseOutcome {
  lease: InputLease;
  /** True when this client may send input. */
  granted: boolean;
  /** The holder this request displaced, if any. It is told at once that it lost the lease. */
  superseded: string | null;
}

export interface LeaseTiming {
  now: number;
  ttlMs: number;
}

export function emptyInputLease(): InputLease {
  return { holder: null, token: null, takeovers: 0, expiresAt: 0 };
}

/**
 * A lease is free when nobody holds it, or when the holder's TTL has run out. Expiry is evaluated
 * here, on demand, and never by a timer.
 */
export function inputLeaseFree(lease: InputLease, now: number): boolean {
  return lease.holder === null || lease.expiresAt <= now;
}

/** True while the given client still holds the lease with the given token. */
export function holdsInputLease(
  lease: InputLease,
  clientId: string,
  token: string,
  now: number,
): boolean {
  return lease.holder === clientId && lease.token === token && !inputLeaseFree(lease, now);
}

/**
 * Ask for the input lease.
 *
 * - free, or the same client reconnecting -> granted, nothing displaced, counter unmoved;
 * - held by someone else, no takeover -> not granted; the client attaches read-only;
 * - held by someone else, takeover -> granted, the previous holder is returned as `superseded`
 *   and the takeover counter moves.
 */
export function requestInputLease(
  lease: InputLease,
  request: InputLeaseRequest,
): InputLeaseOutcome {
  const held = !inputLeaseFree(lease, request.now);

  if (held && lease.holder === request.clientId) {
    // The same client is reconnecting. It already holds the lease, so there is nothing to displace
    // and the takeover counter must not move - a reconnect is not a takeover.
    return {
      lease: { ...lease, token: request.token, expiresAt: request.now + request.ttlMs },
      granted: true,
      superseded: null,
    };
  }

  if (held && !request.takeover) {
    return { lease, granted: false, superseded: null };
  }

  const superseded = lease.holder;
  return {
    lease: {
      holder: request.clientId,
      token: request.token,
      takeovers: superseded === null ? lease.takeovers : lease.takeovers + 1,
      expiresAt: request.now + request.ttlMs,
    },
    granted: true,
    superseded,
  };
}

/** Renew the holder's TTL. Anything else leaves the lease alone. */
export function touchInputLease(
  lease: InputLease,
  clientId: string,
  timing: LeaseTiming,
): InputLease {
  if (lease.holder !== clientId) return lease;
  return { ...lease, expiresAt: timing.now + timing.ttlMs };
}

/**
 * A clean disconnect frees the lease immediately, so the next client is free to take it. The
 * takeover counter is kept: it only ever moves forward, so a superseded holder can never be
 * confused with a current one by a counter that went backwards.
 */
export function releaseInputLease(lease: InputLease, clientId: string): InputLease {
  if (lease.holder !== clientId) return lease;
  return { ...lease, holder: null, token: null, expiresAt: 0 };
}

/**
 * Drop a lease whose holder is no longer attached. This is the authoritative check - the Durable
 * Object knows which sockets it is actually holding - and the TTL is only the backstop for the case
 * where a socket died without a close event.
 */
export function releaseInputLeaseIfAbsent(
  lease: InputLease,
  attachedClientIds: readonly string[],
): InputLease {
  if (lease.holder === null) return lease;
  return attachedClientIds.includes(lease.holder) ? lease : emptyInputLease();
}

// ==================================================================================================
// The awake lease: is work in progress, and therefore should the container stay awake?
//
// This is *not* the input lease. Nothing in this half of the file looks at who is attached, because
// attachment is not work. It is driven by a bounded, truthful declaration from inside the container
// - two messages per unit of work, "begin" and "end" - and never by a ping.
// ==================================================================================================

/** A declared unit of work. `until` is the deadline that stops a never-closed declaration wedging. */
export interface AwakeLease {
  token: string | null;
  until: number;
}

export type WorkFailure = "held" | "unknown-token";

export type WorkOutcome =
  | { ok: true; lease: AwakeLease; changed: boolean }
  | { ok: false; reason: WorkFailure };

export function emptyAwakeLease(): AwakeLease {
  return { token: null, until: 0 };
}

/** Work is in progress only while a declaration exists and has not passed its deadline. */
export function awakeLeaseActive(lease: AwakeLease, now: number): boolean {
  return lease.token !== null && lease.until > now;
}

/**
 * Declare that work has started, or extend a declaration already made under the same token.
 * A declaration made by someone else is refused rather than silently replaced: two work sources
 * sharing one deadline is how a container ends up awake with neither of them owning the release.
 */
export function beginWork(
  lease: AwakeLease,
  request: { token: string; now: number; ttlMs: number },
): WorkOutcome {
  if (awakeLeaseActive(lease, request.now)) {
    if (lease.token !== request.token) return { ok: false, reason: "held" };
    return {
      ok: true,
      lease: { token: lease.token, until: request.now + request.ttlMs },
      changed: false,
    };
  }
  return {
    ok: true,
    lease: { token: request.token, until: request.now + request.ttlMs },
    changed: true,
  };
}

/**
 * Declare that work has finished. The token must match: a stale or unknown caller must not be able
 * to release a declaration it does not own, or an old run could sleep the container under a live
 * one. Releasing an already-expired declaration is a success - it is the state the caller wanted.
 */
export function endWork(lease: AwakeLease, request: { token: string; now: number }): WorkOutcome {
  if (!awakeLeaseActive(lease, request.now)) {
    return { ok: true, lease: emptyAwakeLease(), changed: false };
  }
  if (lease.token !== request.token) return { ok: false, reason: "unknown-token" };
  return { ok: true, lease: emptyAwakeLease(), changed: true };
}

/**
 * Expire a declaration whose deadline has passed. This is the answer to "what if work end is never
 * sent": the declaration lapses on its own clock, and `released` tells the caller it must now let
 * the container sleep.
 */
export function expireWork(lease: AwakeLease, now: number): { lease: AwakeLease; released: boolean } {
  if (awakeLeaseActive(lease, now)) return { lease, released: false };
  // `released` means "a declaration existed and has now lapsed", which is the caller's signal to
  // let the container sleep again. A lease that was already empty released nothing.
  return { lease: emptyAwakeLease(), released: lease.token !== null };
}
