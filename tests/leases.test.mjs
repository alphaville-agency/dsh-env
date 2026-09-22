// The two leases, driven directly.
//
// `src/leases.ts` is pure - no storage, no sockets, no clock of its own - which is what makes these
// runnable with nothing but Node's own test runner: no Durable Object, no container, no network, no
// extra dependency. Every rule the workspace depends on is decided here, so this is where the rules
// are pinned.
//
// The input lease and the awake lease are tested separately *and* against each other, because the
// whole feature turns on their not being the same thing: who may type is not the same question as
// whether work is happening.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  awakeLeaseActive,
  beginWork,
  emptyAwakeLease,
  emptyInputLease,
  endWork,
  expireWork,
  holdsInputLease,
  requestInputLease,
  releaseInputLease,
  releaseInputLeaseIfAbsent,
  touchInputLease,
} from "../src/leases.ts";

const TTL = 600_000;
const WORK_TTL = 7_200_000;
const START = 1_700_000_000_000;

/** One client asking for the input lease, the way the Durable Object asks. */
function ask(lease, clientId, { now = START, takeover = false, token = `token-${clientId}` } = {}) {
  return requestInputLease(lease, { clientId, token, takeover, now, ttlMs: TTL });
}

describe("input lease: one holder at a time", () => {
  it("is granted to the first client and not to a second", () => {
    const free = emptyInputLease();

    const first = ask(free, "alice");
    assert.equal(first.granted, true, "a free lease is granted");
    assert.equal(first.superseded, null, "nothing was displaced");
    assert.equal(first.lease.holder, "alice");

    // The second client attaches - live, but read-only. It is not refused the session; it is
    // refused the *input*.
    const second = ask(first.lease, "bob");
    assert.equal(second.granted, false, "a held lease is not granted");
    assert.equal(second.lease.holder, "alice", "the holder is unchanged");
    assert.equal(second.superseded, null, "no takeover happened");
    assert.equal(holdsInputLease(second.lease, "bob", "token-bob", START), false);
    assert.equal(holdsInputLease(second.lease, "alice", "token-alice", START), true);
  });

  it("tells a second client who holds it, so the window can say so", () => {
    const { lease } = ask(emptyInputLease(), "alice");
    assert.equal(lease.holder, "alice");
    assert.equal(lease.takeovers, 0, "the first holder is not a takeover");
  });

  it("treats the same client reconnecting as a renewal, not a takeover", () => {
    const first = ask(emptyInputLease(), "alice");
    const again = ask(first.lease, "alice", { token: "token-alice-2" });
    assert.equal(again.granted, true);
    assert.equal(again.superseded, null, "a reconnect displaces nobody");
    assert.equal(again.lease.takeovers, 0, "the counter must not move on a reconnect");
    assert.equal(holdsInputLease(again.lease, "alice", "token-alice-2", START), true);
    assert.equal(
      holdsInputLease(again.lease, "alice", "token-alice", START),
      false,
      "the old socket's token is dead",
    );
  });
});

describe("input lease: takeover", () => {
  it("moves the lease and moves the counter forward", () => {
    const first = ask(emptyInputLease(), "alice");
    const seized = ask(first.lease, "bob", { takeover: true });

    assert.equal(seized.granted, true, "takeover always wins");
    assert.equal(seized.lease.holder, "bob");
    assert.equal(seized.superseded, "alice", "the displaced holder is named, to be told at once");
    assert.equal(seized.lease.takeovers, 1, "the counter moves once");

    const back = ask(seized.lease, "alice", { takeover: true });
    assert.equal(back.lease.takeovers, 2, "it only ever moves forward");
    assert.equal(back.superseded, "bob");
  });

  it("detects a superseded holder by its token no longer matching", () => {
    const first = ask(emptyInputLease(), "alice");
    const held = first.lease.token;
    const seized = ask(first.lease, "bob", { takeover: true });

    // What the Durable Object does with the old socket's next keystroke.
    assert.equal(
      holdsInputLease(seized.lease, "alice", held, START),
      false,
      "alice's token is superseded",
    );
    assert.equal(
      holdsInputLease(seized.lease, "bob", seized.lease.token, START),
      true,
      "only bob's current token may type",
    );
  });
});

describe("input lease: expiry and release", () => {
  it("expires an abandoned lease after its TTL, so it can be taken without a takeover flag", () => {
    const abandoned = ask(emptyInputLease(), "alice").lease;

    const justBefore = START + TTL - 1;
    assert.equal(holdsInputLease(abandoned, "alice", abandoned.token, justBefore), true);
    assert.equal(ask(abandoned, "bob", { now: justBefore }).granted, false, "still held");

    const after = START + TTL + 1;
    const taken = ask(abandoned, "bob", { now: after });
    assert.equal(taken.granted, true, "an expired lease is free");
    assert.equal(taken.superseded, "alice", "but the abandoned holder is still displaced");
    assert.equal(taken.lease.takeovers, 1);
  });

  it("renews the TTL on activity from the holder only", () => {
    const held = ask(emptyInputLease(), "alice").lease;
    const renewed = touchInputLease(held, "alice", { now: START + TTL, ttlMs: TTL });
    assert.equal(renewed.expiresAt, START + TTL + TTL);
    assert.equal(
      touchInputLease(held, "bob", { now: START + TTL, ttlMs: TTL }),
      held,
      "a bystander cannot renew someone else's lease",
    );
  });

  it("releases on a clean disconnect, so the next client is free to take it", () => {
    const held = ask(emptyInputLease(), "alice").lease;
    const freed = releaseInputLease(held, "alice");

    assert.equal(freed.holder, null, "the holder is gone");
    assert.equal(freed.token, null, "and so is the token");
    assert.equal(freed.takeovers, 0, "the counter is not rewound");
    assert.equal(ask(freed, "bob").granted, true, "the next client is granted");
    assert.equal(releaseInputLease(held, "bob"), held, "an outsider cannot release it");
  });

  it("releases a lease whose holder is not attached, which is the authoritative check", () => {
    const held = ask(emptyInputLease(), "alice").lease;
    assert.equal(releaseInputLeaseIfAbsent(held, ["bob"]).holder, null);
    assert.equal(releaseInputLeaseIfAbsent(held, ["alice", "bob"]).holder, "alice");
  });
});

describe("awake lease: is work in progress", () => {
  it("is held by an agent working with no client attached", () => {
    // No input lease at all: nobody is attached, nobody is typing. Work is still happening.
    const idleInput = emptyInputLease();
    assert.equal(idleInput.holder, null);

    const declared = beginWork(emptyAwakeLease(), { token: "run-1", now: START, ttlMs: WORK_TTL });
    assert.equal(declared.ok, true);
    assert.equal(declared.changed, true, "this is the call that turns keepAlive on");
    assert.equal(awakeLeaseActive(declared.lease, START + 1), true);
  });

  it("is not held by an attached but abandoned terminal", () => {
    // A client is attached and holds the input lease. That is not work.
    const attached = ask(emptyInputLease(), "alice").lease;
    assert.equal(attached.holder, "alice");

    assert.equal(
      awakeLeaseActive(emptyAwakeLease(), START),
      false,
      "holding the input lease does not keep the container awake",
    );
  });

  it("expires a work signal that is never closed, and says it must be released", () => {
    const declared = beginWork(emptyAwakeLease(), { token: "run-1", now: START, ttlMs: WORK_TTL });
    assert.equal(declared.ok, true);

    const early = expireWork(declared.lease, START + WORK_TTL - 1);
    assert.equal(early.released, false, "still inside its deadline");
    assert.equal(awakeLeaseActive(early.lease, START + WORK_TTL - 1), true);

    const late = expireWork(declared.lease, START + WORK_TTL + 1);
    assert.equal(late.released, true, "a missed end lapses instead of wedging the container");
    assert.equal(awakeLeaseActive(late.lease, START + WORK_TTL + 1), false);
    assert.deepEqual(late.lease, emptyAwakeLease());
  });

  it("ends on a matching token and refuses an unknown one", () => {
    const declared = beginWork(emptyAwakeLease(), { token: "run-1", now: START, ttlMs: WORK_TTL });
    assert.equal(declared.ok, true);

    const wrong = endWork(declared.lease, { token: "run-2", now: START + 1 });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.ok === false && wrong.reason, "unknown-token", "an old run cannot sleep a live one");

    const right = endWork(declared.lease, { token: "run-1", now: START + 1 });
    assert.equal(right.ok, true);
    assert.equal(right.changed, true, "this is the call that lets the container sleep");
    assert.deepEqual(right.lease, emptyAwakeLease());
  });

  it("refuses a second concurrent declarer rather than sharing one deadline", () => {
    const first = beginWork(emptyAwakeLease(), { token: "run-1", now: START, ttlMs: WORK_TTL });
    assert.equal(first.ok, true);

    const second = beginWork(first.lease, { token: "run-2", now: START + 1, ttlMs: WORK_TTL });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, "held");

    const renewed = beginWork(first.lease, { token: "run-1", now: START + 1, ttlMs: WORK_TTL });
    assert.equal(renewed.ok, true);
    assert.equal(renewed.changed, false, "renewing does not re-toggle keepAlive");
  });
});

describe("the two leases are independent", () => {
  it("releasing the input lease does not release the awake lease while work continues", () => {
    const input = ask(emptyInputLease(), "alice").lease;
    const work = beginWork(emptyAwakeLease(), { token: "run-1", now: START, ttlMs: WORK_TTL });
    assert.equal(work.ok, true);

    // Alice closes her window, or is taken over, while the agent keeps working.
    const freed = releaseInputLease(input, "alice");
    assert.equal(freed.holder, null, "input is free again");
    assert.equal(
      awakeLeaseActive(work.lease, START + 1),
      true,
      "work in progress still holds the container awake",
    );

    // And a takeover must not disturb it either.
    const seized = ask(freed, "bob", { takeover: true, now: START + 1 });
    assert.equal(seized.granted, true);
    assert.equal(awakeLeaseActive(work.lease, START + 1), true);
  });

  it("ending the awake lease does not drop the input lease", () => {
    const input = ask(emptyInputLease(), "alice").lease;
    const work = beginWork(emptyAwakeLease(), { token: "run-1", now: START, ttlMs: WORK_TTL });
    assert.equal(work.ok, true);

    const done = endWork(work.lease, { token: "run-1", now: START + 1 });
    assert.equal(done.ok, true);
    assert.equal(awakeLeaseActive(done.lease, START + 1), false, "the container may sleep again");
    assert.equal(holdsInputLease(input, "alice", input.token, START + 1), true, "alice may still type");
  });
});
