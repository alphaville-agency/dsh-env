// The session store is backed by R2, and a failure to back it must not cost the session.
//
// WHY THIS TEST EXISTS. The store is the operator's conversations, and the whole history of this
// problem is a mechanism that looked right and never ran: capture and restore were wired to
// `onStart`/`onActivityExpired`, reviewed as correct, and after an eight-minute sleep the container
// still came back cold with `[no stored conversation to attach to: starting a new one]`. So this
// file pins the two properties that replace it, in the two places they can actually be checked:
//
//   1. THE MOUNT IS MADE FROM THE TERMINAL ROUTE, before the PTY opens, and a mount failure is
//      swallowed. It is not a lifecycle hook, and it cannot turn `./dsh.sh` into an error page.
//      That is a property of `src/worker.ts`, checked against the source.
//   2. THE STORE IS POINTED AT THE MOUNT BY `bin/dsh-session`, and only when the path is really a
//      mount point. A mount that failed still `mkdir -p`s its target, so a test for "the directory
//      exists" would link the store into an empty local directory and lose everything at the next
//      sleep. That is a property of a shell script, checked by running it.
//
// The container's own `mountpoint` is a platform primitive this file does not re-implement; it is
// stubbed on PATH so the launcher's BEHAVIOUR either side of that answer can be tested on a laptop.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(REPO_ROOT, "bin", "dsh-session");
const WORKER = readFileSync(join(REPO_ROOT, "src", "worker.ts"), "utf8");
const SANDBOX = readFileSync(join(REPO_ROOT, "src", "sandbox.ts"), "utf8");
const NAMES = readFileSync(join(REPO_ROOT, "src", "names.ts"), "utf8");

const PROFILE = "dsh-tui";
const PROJECT = "--workspace--";
const SESSION = "06aec587-9f30-4d0e-9a24-2f6a4b7c31d8";

/** A constant's string value, read out of src/names.ts so a change there cannot desync this file. */
function valueOf(name) {
  const match = new RegExp(`export const ${name} = "([^"]*)";`).exec(NAMES);
  assert.notEqual(match, null, `${name} must be declared in src/names.ts`);
  return match[1];
}

/** The body of a top-level function declaration, by brace counting from its opening brace. */
function bodyOf(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} must exist`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${declaration} has no closing brace`);
}

// ---------------------------------------------------------------------------------------------
// The Worker half: where the mount is made, and what happens when it fails.
// ---------------------------------------------------------------------------------------------

test("the session store is mounted from the terminal route, before the PTY opens", () => {
  const terminal = bodyOf(WORKER, "async function terminal(request: Request, env: Env)");

  const mountAt = terminal.indexOf("ensureStateMounted(");
  const ptyAt = terminal.indexOf("session.terminal(");
  assert.notEqual(mountAt, -1, "the terminal route must ensure the store is mounted");
  assert.notEqual(ptyAt, -1, "the terminal route must open the PTY");
  assert.ok(
    mountAt < ptyAt,
    "the mount must be established before the PTY opens: the harness reads the store as it starts",
  );
});

test("a mount that fails cannot stop the session opening", () => {
  const terminal = bodyOf(WORKER, "async function terminal(request: Request, env: Env)");

  // The only call site is inside a `try`, and the PTY is opened after it rather than inside it: a
  // throw here would otherwise return a 500 from an upgrade whose whole job is to be a way in.
  assert.match(
    terminal,
    /try\s*\{[^}]*ensureStateMounted\(sandbox\)[\s\S]*?\}\s*catch\s*\(/,
    "ensureStateMounted must be wrapped so its failure is a log line, not a failed upgrade",
  );
});

test("the mount names the R2 binding and an empty path, not the store directory", () => {
  const mount = bodyOf(WORKER, "function ensureStateMounted(sandbox: Sandbox)");

  assert.match(mount, /mountBucket\(STATE_BINDING, STATE_MOUNT_PATH, \{\}\)/);
  assert.match(mount, /unmountBucket\(STATE_MOUNT_PATH\)/, "a stale SDK mount record is cleared once");
  // s3fs refuses a non-empty mount point. The mounted path must therefore not be the store itself,
  // which is exactly the mistake an earlier attempt made.
  assert.notEqual(valueOf("STATE_MOUNT_PATH"), valueOf("SESSION_STORE_DIR"));
});

test("the mount asks the container whether it is already there, rather than a boolean it remembers", () => {
  const mount = bodyOf(WORKER, "function ensureStateMounted(sandbox: Sandbox)");

  // `activeMounts` lives in the Durable Object's memory and can outlive the container it describes;
  // `mountpoint` runs in the container and cannot.
  assert.match(mount, /mountpoint -q \$\{STATE_MOUNT_PATH\}/);
  assert.match(mount, /exec\(/, "the ground-truth check must run in the container");
});

test("nothing persists the session store from a lifecycle hook any more", () => {
  // Two mechanisms claiming one job is the defect this change exists to remove: the hook copy was
  // reviewed as correct and never ran. The old one is gone, not parked.
  for (const gone of ["SESSION_CAPTURE_SCRIPT", "SESSION_RESTORE_SCRIPT", "captureSessions", "restoreSessions"]) {
    assert.ok(!SANDBOX.includes(gone), `${gone} is gone: the mount replaces it, so it must not linger`);
  }
  assert.ok(!/override async onStart\(/.test(SANDBOX), "onStart existed only to restore the store");
  for (const gone of ["SESSION_SNAPSHOT_KEY", "SESSION_STATUS_KEY", "SESSION_STATUS_FILE", "ROUTE_PERSISTENCE"]) {
    assert.ok(!NAMES.includes(gone), `${gone} belongs to the removed mechanism`);
  }
});

// ---------------------------------------------------------------------------------------------
// The launcher half: the symlink, and the fallback when the mount is not there.
// ---------------------------------------------------------------------------------------------

/** A home with a stub harness and the profile directory the launcher checks for. */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "dsh-state-"));
  mkdirSync(join(home, "profiles", PROFILE), { recursive: true });
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });

  const harness = join(bin, "dsh");
  writeFileSync(
    harness,
    ["#!/bin/sh", 'echo "$@" >> "$DSH_STUB_LOG"', "exit 0", ""].join("\n"),
  );
  chmodSync(harness, 0o755);

  // Stands in for the container's `mountpoint`, which is the platform's answer to a question this
  // file is not re-implementing. DSH_MOUNT_STUB is the answer it gives.
  const mountpoint = join(bin, "mountpoint");
  writeFileSync(mountpoint, ["#!/bin/sh", 'exit "${DSH_MOUNT_STUB:-1}"', ""].join("\n"));
  chmodSync(mountpoint, 0o755);

  return home;
}

function run(home, stateDir, extraEnv = {}) {
  const log = join(home, "argv.log");
  writeFileSync(log, "");
  const result = spawnSync("sh", [LAUNCHER], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(home, "bin")}:${process.env.PATH}`,
      DSH_HOME: home,
      DSH_PROFILE: PROFILE,
      DSH_STATE_MOUNT: stateDir,
      DSH_STUB_LOG: log,
      ...extraEnv,
    },
  });
  const calls = readFileSync(log, "utf8").split("\n").filter((line) => line.includes("--profile"));
  return { ...result, calls };
}

/** A conversation in the shape the harness writes, under whatever store directory is given. */
function writeConversation(store, mtime) {
  const dir = join(store, PROJECT, SESSION);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "session.v3.jsonl.zstd");
  writeFileSync(log, "x".repeat(32));
  const when = new Date(mtime);
  utimesSync(log, when, when);
  utimesSync(dir, when, when);
}

test("the launcher's default mount path is the Worker's constant, not a second spelling of it", () => {
  assert.ok(
    LAUNCHER_TEXT().includes(`STATE_MOUNT="\${DSH_STATE_MOUNT:-${valueOf("STATE_MOUNT_PATH")}}"`),
    "bin/dsh-session and src/names.ts must agree on where the bucket is mounted",
  );
});

test("a mounted path links the store into the backing before the harness reads it", () => {
  const home = makeHome();
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });

  const { stdout, status } = run(home, state, { DSH_MOUNT_STUB: "0" });

  assert.equal(status, 0);
  const store = join(home, "sessions");
  assert.ok(lstatSync(store).isSymbolicLink(), "the store must be a symlink, not a real directory");
  assert.equal(readlinkSync(store), join(state, "sessions"));
  assert.match(stdout, /session store backed by R2/);
});

test("a conversation already in the local store is moved into the backing, not discarded", () => {
  const home = makeHome();
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  // The upgrade path: a container that already held conversations before the mount existed.
  writeConversation(join(home, "sessions"), "2026-09-25T02:19:15Z");

  const { status } = run(home, state, { DSH_MOUNT_STUB: "0" });

  assert.equal(status, 0);
  assert.ok(
    existsSync(join(state, "sessions", PROJECT, SESSION, "session.v3.jsonl.zstd")),
    "the pre-existing conversation must be under the mount, not left on the ephemeral disk",
  );
});

test("a conversation in the backing is attached to, through the symlink", () => {
  const home = makeHome();
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  writeConversation(join(state, "sessions"), "2026-09-25T02:19:15Z");

  const { calls, stdout, status } = run(home, state, { DSH_MOUNT_STUB: "0" });

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(`--resume ${SESSION}$`));
  assert.match(stdout, new RegExp(`attaching to #${SESSION}\\b`));
});

test("an unmounted path leaves the store local, says so, and still opens the session", () => {
  const home = makeHome();
  const state = join(home, "state");
  // The SDK `mkdir -p`s the mount path on the way to a mount that may then fail. A directory that
  // merely exists is therefore NOT evidence of a backing, and this is the case that proves it.
  mkdirSync(state, { recursive: true });

  const { calls, stdout, status } = run(home, state, { DSH_MOUNT_STUB: "1" });

  assert.equal(status, 0, "a failed mount must not cost the operator the session");
  assert.ok(!existsSync(join(home, "sessions")) || !lstatSync(join(home, "sessions")).isSymbolicLink());
  assert.match(stdout, /NOT backed by R2/);
  assert.equal(calls.length, 1, "the harness still runs");
});

test("the launcher never reads the removed persistence log", () => {
  assert.ok(
    !LAUNCHER_TEXT().includes("/tmp/dsh-persistence"),
    "the log belonged to the capture/restore mechanism, which the mount replaces",
  );
});

let launcherText;
function LAUNCHER_TEXT() {
  launcherText ??= readFileSync(LAUNCHER, "utf8");
  return launcherText;
}

test("the store's name inside the mount is derived, so the subdirectory is named once", () => {
  // `basename` of the store path, rather than a second literal "sessions" that could drift.
  assert.match(LAUNCHER_TEXT(), /STATE_STORE="\$STATE_MOUNT\/\$\(basename "\$STORE"\)"/);
});
