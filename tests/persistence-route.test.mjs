// The persistence report must stay read-only.
//
// WHY THIS TEST EXISTS. `/persistence` exists because nothing else can see whether the conversation
// store is being saved: the capture runs as a container is discarded and the restore runs before any
// session exists to report it. The whole value of the route is that it can be asked AT THAT MOMENT -
// after a sleep, with the container stopped - and a report that starts the container destroys the
// state it was asked about, then bills for the container and resets the sleep timer.
//
// That mistake is one line away and invisible in review: `sandboxFor(env)` is the natural thing to
// reach for, and the response still looks right. So the property is pinned against the source, the
// same way tests/dockerfile.test.mjs pins the image's contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = readFileSync(join(REPO_ROOT, "src", "worker.ts"), "utf8");
const NAMES = readFileSync(join(REPO_ROOT, "src", "names.ts"), "utf8");

/** The body of a top-level function declaration, by brace counting from its opening brace. */
function bodyOf(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} must exist in src/worker.ts`);
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

test("the persistence route is declared and dispatched", () => {
  assert.match(NAMES, /export const ROUTE_PERSISTENCE = "\/persistence"/);
  assert.match(WORKER, /url\.pathname === ROUTE_PERSISTENCE/);
});

test("reading the persistence report cannot start the container", () => {
  const body = bodyOf(WORKER, "async function persistence(env: Env)");

  // `sandboxFor` is the only way this Worker reaches the sandbox, and `getSandbox` inside it is what
  // starts a stopped container.
  assert.ok(
    !body.includes("sandboxFor") && !body.includes("getSandbox") && !body.includes("session"),
    "the persistence report touches the sandbox, so reading it would wake the container",
  );
  // What it reads, instead: the snapshot's metadata and the log, both straight out of R2.
  assert.match(body, /env\.STATE\.head\(SESSION_SNAPSHOT_KEY\)/);
  assert.match(body, /env\.STATE\.get\(SESSION_STATUS_KEY\)/);
});

test("the route table advertises it, and says it does not wake anything", () => {
  const described = bodyOf(WORKER, "function describe()");
  assert.match(described, /ROUTE_PERSISTENCE/);
  assert.match(described, /does not wake the sandbox/);
});
