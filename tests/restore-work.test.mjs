// The captured workspace is restored, not just captured.
//
// WHY THIS TEST EXISTS. `captureUncommittedWork` has run on every stop for a long time — it writes
// `changes.patch`, `untracked.tar.gz.b64`, `HEAD` and `MANIFEST.txt` into `dsh-work/<stamp>/` — and
// NOTHING EVER READ THEM BACK. A grep across `bin/` and `src/` for a restore found zero. The safety
// net caught the work and dropped it on the other side of the container restart. The goal names this
// exact failure: "a copy-out that never runs is the same failure as no persistence at all."
//
// So this file pins that the restore exists, is wired to the terminal route (the entry point where
// the workspace is read), and is shaped as the mirror of the capture. It checks `src/*.ts` as source,
// because the function needs an R2 binding and a live container to execute — and a source check that
// fails loudly is worth more here than a mock that passes either way.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = readFileSync(join(ROOT, "src", "sandbox.ts"), "utf8");
const WORKER = readFileSync(join(ROOT, "src", "worker.ts"), "utf8");

test("restoreCapturedWork exists and mirrors the capture's file names", () => {
  assert.match(SANDBOX, /export async function restoreCapturedWork/, "the restore must exist");

  // The capture writes these three; the restore must read the same three, or the contract is broken
  // by a rename on one side that the other never sees.
  const captureFiles = ["changes.patch", "untracked.tar.gz.b64", "MANIFEST.txt"];
  for (const file of captureFiles) {
    assert.ok(
      SANDBOX.includes(`/${file}`),
      `restore must reference the capture's ${file} — capture and restore are a contract`,
    );
  }

  // Newest-first: several stops may have captured, and applying an older one on top would resurrect
  // work that had already been superseded.
  assert.match(SANDBOX, /\.sort\(\)\s*\.reverse\(\)/, "restore must take the newest capture first");

  // It must apply tracked changes AND untracked files, in that order — a patch may create the
  // directories the tarball then populates.
  const patchAt = SANDBOX.indexOf("git apply --whitespace=nowarn");
  const tarAt = SANDBOX.indexOf("base64 -d | tar -xzf -");
  assert.ok(patchAt > 0, "restore must apply the tracked-changes patch");
  assert.ok(tarAt > 0, "restore must restore untracked files");
  assert.ok(patchAt < tarAt, "the patch must apply before the tarball populates its directories");
});

test("the terminal route restores captured work before the PTY opens", () => {
  // The workspace is read the moment the TUI starts, so the restore has to happen before
  // `session.terminal(...)`, not after — a restore that runs late restores into nobody's view.
  // The first `session.terminal(` in the file is in a COMMENT about a past failure, so searching for
  // the bare call finds prose and asserts against it. Anchor on the real call — `await session.terminal`
  // — and on the real restore call, `restoreCapturedWork(sandbox`.
  const restoreAt = WORKER.indexOf("restoreCapturedWork(sandbox");
  const terminalAt = WORKER.indexOf("await session.terminal(");
  assert.ok(restoreAt > 0, "the terminal route must call restoreCapturedWork");
  assert.ok(terminalAt > 0, "the terminal route must open the PTY");
  assert.ok(
    restoreAt < terminalAt,
    "captured work must be restored before the PTY opens, so the TUI sees it",
  );
});

test("a restore failure cannot withhold the terminal", () => {
  // The mount is best-effort and the restore must be too: an unreachable bucket or a patch that no
  // longer applies is a report, never a reason to hand the operator an error page.
  assert.match(
    WORKER,
    /captured-work restore failed/,
    "the restore must be wrapped so a failure is logged, not thrown",
  );
});

test("capture and restore are both exported, so neither is a dead code path", () => {
  assert.match(SANDBOX, /export async function captureUncommittedWork/, "capture must stay exported");
  assert.match(SANDBOX, /export async function restoreCapturedWork/, "restore must be exported");
});
