// The two container-side scripts, run for real against a store this file builds.
//
// WHY THIS TEST EXISTS. `SESSION_CAPTURE_SCRIPT` and `SESSION_RESTORE_SCRIPT` are shell, they run
// inside the container, and nothing on the laptop ever executed them - so two defects that cost the
// operator every conversation they had were reviewed as correct:
//
//   1. The command is an array of statements joined with `; `, and an element that ends in `do` or
//      `then` cannot be followed by a `;`: `for x in y; do; z; done` is a SYNTAX ERROR (exit 2). And
//      `exec` does not run a command in a fresh process - it runs it in the container's PERSISTENT
//      SHELL for a session - so a syntax error there does not fail a command, it ENDS THE SHELL. The
//      live persistence log recorded exactly that, and it is the reason no capture has ever
//      succeeded: `capture FAILED: ... Session 'sandbox-dsh' shell exited (exit code: 2)`.
//   2. The harness names each project directory after its working directory: `--workspace--`. Passed
//      to `tar` as an operand, both GNU and BSD read that as an option and refuse it ("Option
//      --workspace-- is not supported"). The restore's `mv` had the same trap.
//
// Both are visible in milliseconds here and were invisible for days in production, because the only
// place their output can be read is a container that has already been discarded.
//
// The scripts are extracted from src/sandbox.ts rather than duplicated - including the array's join
// separator and its constants - and the capture is run in a real `sh` that stays open afterwards,
// which is the property defect 1 was.
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = readFileSync(join(REPO_ROOT, "src", "sandbox.ts"), "utf8");
const NAMES = readFileSync(join(REPO_ROOT, "src", "names.ts"), "utf8");

/** The project directory the harness names after its working directory, dashes and all. */
const PROJECT = "--workspace--";
const SESSION = "06aec587-9f30-4d0e-9a24-2f6a4b7c31d8";

/** A constant's value, read out of src/names.ts so a change there cannot silently desync this file. */
function valueOf(name) {
  const match = new RegExp(`export const ${name} = ([^;]+);`).exec(NAMES);
  assert.notEqual(match, null, `${name} must be declared in src/names.ts`);
  const expression = match[1].trim();
  if (expression.startsWith('"')) return expression.slice(1, -1);
  // `8 * 1024` and `20` are both plain arithmetic literals; anything else is a change this file has
  // not been taught to follow, and reading it as a number would be the wrong kind of clever.
  assert.match(expression, /^[\d\s*+]+$/, `${name} must be a plain arithmetic literal`);
  return String(expression.split("*").reduce((product, f) => product * Number(f.trim()), 1));
}

/**
 * The array's elements, split on the commas that separate them - not on every string literal, because
 * an element may be written as several literals joined with `+`, and those concatenate with NO
 * separator where the elements get the separator below. Reproducing that distinction is the point:
 * getting it wrong is precisely the syntax error this file exists to catch.
 */
function arrayElements(body) {
  const elements = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote !== null) {
      current += char;
      if (char === "\\") {
        current += body[++i];
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "`" || char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      elements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  elements.push(current);
  return elements.filter((element) => element.trim() !== "");
}

/** Every array element, with its escapes resolved the way the runtime resolves them. */
function scriptElements(declaration) {
  const start = SANDBOX.indexOf(`const ${declaration} = [`);
  assert.notEqual(start, -1, `${declaration} must exist in src/sandbox.ts`);
  const marker = SANDBOX.indexOf("].join(", start);
  assert.notEqual(marker, -1, `${declaration} must be joined into one command`);

  const body = SANDBOX.slice(start + `const ${declaration} = [`.length, marker)
    .split("\n")
    // Comments in that array are prose about the script, not part of it - and prose carries backticks.
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  const elements = arrayElements(body).map((element) =>
    [...element.matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/g)]
      .map((match) => match[1] ?? match[2] ?? match[3])
      .join("")
      // A template literal's escapes are resolved by the runtime, so `\$` in the source is a `$` in
      // the command - and `\\;` for `find -exec` is `\;`. Reading the source without that step turns
      // `size=\${size:-0}` into an arithmetic error in the shell, which is how this was found.
      .replace(/\\(.)/g, "$1"),
  );
  assert.ok(elements.length > 3, `${declaration} should be several statements`);
  return elements;
}

/**
 * The command as the Worker would send it, with every `${CONSTANT}` resolved - from `overrides` where
 * a test needs its own path, and from src/names.ts otherwise. An unresolved placeholder throws: a
 * constant this file does not know about would otherwise travel to the shell as literal text.
 */
function scriptFrom(declaration, overrides = {}) {
  const start = SANDBOX.indexOf(`const ${declaration} = [`);
  const marker = SANDBOX.indexOf("].join(", start);
  // The separator is part of the contract and is read, not assumed: the capture is joined with `; `
  // and the restore with ` && `, and using the wrong one turns a chain into a pile of statements.
  const separator = /"([^"]*)"/.exec(SANDBOX.slice(marker, SANDBOX.indexOf("\n", marker)))?.[1];
  assert.ok(separator !== undefined, `${declaration}'s join separator must be a plain string`);

  const script = scriptElements(declaration)
    .join(separator)
    .replace(/\$\{(\w+)\}/g, (_, name) => overrides[name] ?? valueOf(name));

  // Constants are named in capitals; `${size:-0}` is the shell's own parameter expansion and stays.
  const unresolved = /\$\{[A-Z_]+\}/.exec(script);
  assert.equal(
    unresolved,
    null,
    `${declaration} has a placeholder this test cannot resolve: ${unresolved?.[0]}`,
  );
  return script;
}

/** Run a command in a shell that stays open, then prove the shell is still alive afterwards. */
function inPersistentShell(command, { alive = true } = {}) {
  const child = spawn("sh", [], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  child.stdin.write(`${command}\n`);
  if (alive) child.stdin.write("echo STILL-ALIVE\n");
  child.stdin.end();

  const done = new Promise((resolveDone) => child.on("close", resolveDone));
  return done.then(() => ({ stdout, stderr }));
}

const MARKER = "STILL-ALIVE";
const payloadOf = (stdout) => stdout.slice(0, stdout.indexOf(MARKER)).trim();

/** The entry names in a tar stream, read straight out of its 512-byte headers. */
function tarEntries(buffer) {
  const names = [];
  for (let offset = 0; offset + 512 <= buffer.length; offset += 512) {
    const header = buffer.subarray(offset, offset + 512);
    const end = header.indexOf(0);
    const name = header.subarray(0, end === -1 ? 100 : Math.min(end, 100)).toString("utf8");
    if (name === "") break;
    names.push(name);
  }
  return names;
}

function makeHome() {
  return mkdtempSync(join(tmpdir(), "dsh-capture-"));
}

/** A store with one conversation in it, in the shape the harness writes. */
function makeStore() {
  const home = makeHome();
  const store = join(home, "sessions");
  mkdirSync(join(store, PROJECT, SESSION), { recursive: true });
  writeFileSync(join(store, PROJECT, SESSION, "session.v3.jsonl.zstd"), "not really zstd");
  writeFileSync(join(store, PROJECT, SESSION, "session.lock"), "");
  return { home, store };
}

test("the capture script never exits, because `exit` would end the session it runs in", () => {
  const script = scriptFrom("SESSION_CAPTURE_SCRIPT");

  assert.ok(
    !/(^|[;&\s])exit\b/.test(script),
    "the capture must not call exit: exec runs it in the container's persistent shell",
  );
  assert.ok(!script.includes("set -u"), "an unbound variable would take the session down too");
  assert.ok(!script.includes("cd "), "the working directory is session state, not this script's");
});

test("no element is left hanging, which the join would turn into a syntax error", () => {
  for (const declaration of ["SESSION_CAPTURE_SCRIPT", "SESSION_RESTORE_SCRIPT"]) {
    for (const element of scriptElements(declaration)) {
      const trimmed = element.trim();
      // `; ` is inserted BETWEEN elements, so an element that ends in `do` or `then` becomes `; do;`
      // and the whole command is unparseable - and an unparseable command does not fail, it takes the
      // session's shell down with it. This is the defect, stated as the property it violates.
      assert.ok(
        !/\b(do|then)$/.test(trimmed) && !/[{\\]$/.test(trimmed),
        `an element ends where the join cannot follow it: ${trimmed}`,
      );
    }
  }
});

test("the capture script names the store's state, so 'nothing' can be told from 'wrong place'", () => {
  const script = scriptFrom("SESSION_CAPTURE_SCRIPT");
  assert.match(script, /echo "\$count \$kib \$state"/);
});

test("capturing an empty store is quiet, and leaves the shell alive", async () => {
  const store = join(makeHome(), "sessions");
  mkdirSync(store, { recursive: true });
  const script = scriptFrom("SESSION_CAPTURE_SCRIPT", { SESSION_STORE_DIR: store });

  const { stdout, stderr } = await inPersistentShell(script);

  assert.equal(payloadOf(stdout), "", "an empty store writes no payload");
  assert.match(stderr, /^0 0 empty$/m);
  assert.ok(stdout.includes(MARKER), "the shell must survive the capture");
});

test("capturing an absent store is quiet, and leaves the shell alive", async () => {
  const script = scriptFrom("SESSION_CAPTURE_SCRIPT", {
    SESSION_STORE_DIR: join(makeHome(), "sessions"),
  });

  const { stdout, stderr } = await inPersistentShell(script);

  assert.equal(payloadOf(stdout), "");
  assert.match(stderr, /^0 0 absent$/m);
  assert.ok(stdout.includes(MARKER), "the shell must survive the capture");
});

test("capturing a real store tars it, project directory and all", async () => {
  const { store } = makeStore();
  const script = scriptFrom("SESSION_CAPTURE_SCRIPT", { SESSION_STORE_DIR: store });

  const { stdout, stderr } = await inPersistentShell(script);

  assert.match(stderr, /^1 \d+ present$/m);
  const payload = payloadOf(stdout);
  assert.notEqual(payload, "", "a store with a conversation must produce a payload");

  const entries = tarEntries(Buffer.from(payload, "base64"));
  // The name that both tar and mv would otherwise read as an option.
  assert.ok(entries.includes(`${PROJECT}/`), `expected the project directory, got: ${entries}`);
  assert.ok(
    entries.includes(`${PROJECT}/${SESSION}/session.v3.jsonl.zstd`),
    `expected the session log, got: ${entries}`,
  );
  assert.ok(stdout.includes(MARKER), "the shell must survive the capture");
});

test("the restore script moves a project directory without reading it as an option", () => {
  const script = scriptFrom("SESSION_RESTORE_SCRIPT");

  // `mv -n {}` fails on `--workspace--` with "illegal option -- -", which stops the && chain after
  // the archive has already been decoded: a restore that reports a failure and moves nothing.
  assert.match(script, /mv -n -- \{\}/);
});

test("a captured store is restored into a fresh one, under the same name", () => {
  const { home, store } = makeStore();
  const capture = scriptFrom("SESSION_CAPTURE_SCRIPT", { SESSION_STORE_DIR: store });

  const captured = spawnSync("sh", ["-c", capture], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(captured.status, 0, captured.stderr);
  const payload = captured.stdout.trim();
  assert.notEqual(payload, "", "the capture must produce a payload before a restore can be tested");

  // A second container: the store is gone, and the snapshot arrives as base64 in a staging file.
  const restoredStore = join(home, "restored");
  const snapshot = join(home, "snapshot.b64");
  writeFileSync(snapshot, payload);

  const restore = scriptFrom("SESSION_RESTORE_SCRIPT", {
    SESSION_STORE_DIR: restoredStore,
    SESSION_RESTORE_STAGE_DIR: join(home, "stage"),
    SESSION_SNAPSHOT_FILE: snapshot,
  });

  const restored = spawnSync("sh", ["-c", restore], { encoding: "utf8" });
  assert.equal(restored.status, 0, restored.stderr);

  const log = readFileSync(join(restoredStore, PROJECT, SESSION, "session.v3.jsonl.zstd"), "utf8");
  assert.equal(log, "not really zstd", "the session log must come back byte for byte");
});