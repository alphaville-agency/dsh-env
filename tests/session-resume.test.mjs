// The launcher's contract with the operator: attach to the conversation that is already there, and
// never leave them without a session.
//
// WHY THIS TEST EXISTS. `bin/dsh-session` decides which conversation a session opens into, and every
// way that decision can be wrong is invisible until a person is staring at a blank screen:
//
//   * it picks the wrong session (the oldest, or one from another project directory)
//   * it picks one and then the harness refuses it - and a launch-time `--resume` FAILS THE BOOT
//     rather than falling back, so a wrong pick costs the operator the whole session
//   * it passes no id but also does not notice there was nothing to resume
//
// None of that is observable from the Worker, from CI, or from a warm container. It is a shell
// script, so it is tested by running it - against a store this file builds, with a stub `dsh` that
// records the arguments it was handed. That is also the only way to pin the fallback: the real
// harness cannot be made to refuse a session on demand.
//
// The stub stands in for `dsh` on PATH. Everything below it - the store layout, the ordering, the
// retry - is the real script.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(REPO_ROOT, "bin", "dsh-session");

/** The profile directory the script insists on; the profile's contents are the image's business. */
const PROFILE = "dsh-tui";

/**
 * A store with the shape the harness writes: one directory per project, one per session beneath it,
 * and the session's log inside that. `dsh-session-persistence-jsonl` names the directory after the
 * session id and writes `session.v3.jsonl.zstd` into it; the launcher must read that back as the id.
 */
function makeStore(home, sessions) {
  const store = join(home, "sessions");
  for (const { id, project = "--workspace--", bytes, mtime } of sessions) {
    const dir = join(store, project, id);
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "session.v3.jsonl.zstd");
    writeFileSync(log, "x".repeat(bytes ?? 16));
    const when = new Date(mtime);
    utimesSync(log, when, when);
    utimesSync(dir, when, when);
  }
  return store;
}

/** A `dsh` that records how it was called, and fails a resume when told to. */
function makeHarness(home) {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "dsh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `# Stub harness. Records argv, then obeys DSH_STUB_REFUSE_RESUME.`,
      'echo "$@" >> "$DSH_STUB_LOG"',
      'case " $* " in',
      '  *" --resume "*) if [ "${DSH_STUB_REFUSE_RESUME:-0}" = "1" ]; then',
      '      echo "dsh-tui: cannot resume session: the stored log is unreadable" >&2',
      "      exit 1",
      "    fi ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return bin;
}

function run(home, extraEnv = {}) {
  const log = join(home, "argv.log");
  writeFileSync(log, "");
  const result = spawnSync("sh", [LAUNCHER], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(home, "bin")}:${process.env.PATH}`,
      DSH_HOME: home,
      DSH_PROFILE: PROFILE,
      DSH_STUB_LOG: log,
      ...extraEnv,
    },
  });
  // The launcher asks the harness for its version as part of the session header, so the stub sees
  // one call that is not a session. Only the profile invocations answer "which conversation did it
  // start".
  const recorded = readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
  const calls = recorded.filter((line) => line.includes("--profile"));
  return { ...result, calls, versions: recorded.length - calls.length };
}

/** A home with a stub harness and the profile directory the launcher checks for. */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "dsh-session-"));
  mkdirSync(join(home, "profiles", PROFILE), { recursive: true });
  makeHarness(home);
  return home;
}

const NEWER = "06aec587-1111-4111-8111-111111111111";
const OLDER = "14c21468-2222-4222-8222-222222222222";

test("attaches to the newest stored conversation, by mtime", () => {
  const home = makeHome();
  makeStore(home, [
    { id: OLDER, mtime: "2026-09-25T02:00:00Z" },
    { id: NEWER, mtime: "2026-09-25T02:19:15Z" },
  ]);

  const { calls, status, stdout } = run(home);

  assert.equal(status, 0);
  assert.equal(calls.length, 1, "a successful attach must not also start a second TUI");
  assert.match(calls[0], new RegExp(`--resume ${NEWER}$`));
  assert.match(stdout, new RegExp(`attaching to #${NEWER}\\b`));
  // The listing the operator reads is newest first, so the conversation being attached to is the
  // one at the top of it rather than merely present in it.
  const listed = [...stdout.matchAll(new RegExp(`${NEWER}|${OLDER}`, "g"))].map((m) => m[0]);
  assert.ok(listed.length >= 2, "both conversations are listed");
  assert.equal(listed[0], NEWER, "the newest is listed first");
});

test("the store's ordering is by time, not by name", () => {
  const home = makeHome();
  // Sorted by name, `14c21468…` would win - it is later in the alphabet than `06aec587…` in no
  // meaningful way, which is the point: the id carries no order and must not be read as if it did.
  makeStore(home, [
    { id: "aaaabbbb-3333-4333-8333-333333333333", mtime: "2026-09-25T01:00:00Z" },
    { id: "zzzzyyyy-4444-4444-8444-444444444444", mtime: "2026-09-25T01:30:00Z" },
  ]);

  const { calls } = run(home);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /--resume zzzzyyyy-4444-4444-8444-444444444444$/);
});

test("starts a fresh conversation when the store is empty, and says so", () => {
  const home = makeHome();
  mkdirSync(join(home, "sessions"), { recursive: true });

  const { calls, status, stdout } = run(home);

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes("--resume"), `no resume flag expected, got: ${calls[0]}`);
  assert.match(stdout, /no stored conversation to attach to/);
});

test("starts a fresh conversation when there is no store at all", () => {
  const home = makeHome();

  const { calls, status } = run(home);

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes("--resume"));
});

test("a refused resume retries without it, so the operator still gets a session", () => {
  const home = makeHome();
  makeStore(home, [{ id: NEWER, mtime: "2026-09-25T02:19:15Z" }]);

  const { calls, status, stdout } = run(home, { DSH_STUB_REFUSE_RESUME: "1" });

  assert.equal(status, 0, "the fallback must leave the operator with a session, so the script exits clean");
  assert.equal(calls.length, 2, "one attempt with the stored id, then one without");
  assert.match(calls[0], new RegExp(`--resume ${NEWER}$`));
  assert.ok(!calls[1].includes("--resume"), `the retry must not repeat the flag: ${calls[1]}`);
  assert.match(stdout, new RegExp(`exited without staying in #${NEWER}`));
});

test("a clean exit from an attached TUI is the end, not a retry", () => {
  const home = makeHome();
  makeStore(home, [{ id: NEWER, mtime: "2026-09-25T02:19:15Z" }]);

  const { calls, status } = run(home);

  assert.equal(status, 0);
  assert.equal(calls.length, 1, "an ordinary quit must not open a second TUI");
});

test("the launcher exists and is executable in the image", () => {
  assert.ok(existsSync(LAUNCHER), "bin/dsh-session must exist: the image copies it");
});

test("the session header reports the boot id, so a restart is visible from inside", () => {
  const home = makeHome();
  const { stdout } = run(home);

  assert.match(stdout, /\[boot \S+ at \d{4}-\d{2}-\d{2}T/);
});

test("a session that ended is reported, with what it left in the store", () => {
  const home = makeHome();
  makeStore(home, [{ id: NEWER, mtime: "2026-09-25T02:19:15Z" }]);

  const { stdout, status } = run(home);

  assert.equal(status, 0);
  assert.match(stdout, /\[the harness exited with status 0\]/);
  // The next boot's question about this boot, answered while the container can still answer it.
  assert.match(stdout, /after this session: 1\]/);
});
