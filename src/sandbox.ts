/**
 * The Sandbox subclass, which exists for one reason: to save work before the container is stopped.
 *
 * WHY THIS CLASS EXISTS AT ALL. The platform documents that all disk is ephemeral - "when a Container
 * instance goes to sleep, the next time it is started, it will have a fresh disk as defined by its
 * container image". FUSE against R2 is the only persistence Cloudflare offers today, its own docs
 * warn not to expect SSD-like performance, and this environment measured it failing three separate
 * ways. So the working tree genuinely does not survive a sleep.
 *
 * The obvious answer - "commit and push before you stop" - pushes a machine's problem onto a person,
 * and it is exactly the kind of step that gets forgotten at the end of a session. It is also not
 * necessary, because the platform tells us when it is about to stop: `onActivityExpired()` runs when
 * the sleep timer expires, and `onStop()` runs when the container process exits. Both run Worker code
 * with the container still reachable.
 *
 * So the save happens here, in the one moment it can, rather than being delegated to discipline.
 *
 * WHAT THIS DOES NOT DO. It does not commit anything. A session's work is the agent's or the
 * operator's to describe, and an automatic commit with a generated message produces history nobody
 * can read - which is worse than an honest uncommitted tree. What it does is make the UNCOMMITTED
 * work leave the container: a patch, and a bundle of untracked files, written to R2 through the
 * binding. A person or an agent can then recover it on the next session.
 *
 * It also cannot save what it cannot reach: an agent that is mid-edit when the timer fires gets
 * whatever exists at that instant.
 *
 * THE OTHER THING THAT LEAVES HERE IS THE CONVERSATION. `captureUncommittedWork` covers the working
 * tree; `captureSessions` covers `/root/.dsh/sessions`, which is where the harness keeps every
 * conversation. They are two payloads of one idea - get bytes out of a disk that is about to be
 * discarded - and they share these hooks rather than having a mechanism of their own. The
 * conversation is restored on `onStart`, before anything can use the container.
 */
import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import type { StopParams } from "@cloudflare/containers";
import {
  SESSION_RESTORE_STAGE_DIR,
  SESSION_SNAPSHOT_FILE,
  SESSION_SNAPSHOT_KEY,
  SESSION_SNAPSHOT_MANIFEST_KEY,
  SESSION_SNAPSHOT_MAX_KIB,
  SESSION_SNAPSHOT_MAX_SESSIONS,
  SESSION_STORE_DIR,
  SESSION_TRANSFER_TIMEOUT_MS,
} from "./names";

/**
 * The container calls this file makes, structurally.
 *
 * Declared as a shape rather than importing the SDK's types so the same functions can be called
 * with the Sandbox subclass (which satisfies it) and with a stub in a test.
 */
interface Container {
  exec(
    command: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number; success?: boolean }>;
  writeFile(path: string, content: string): Promise<unknown>;
}

export interface SavedWork {
  /** Where the patch and the untracked bundle were written, if anything was saved. */
  prefix: string;
  /** Repositories that had work worth saving. */
  repos: string[];
  /** Repositories that could not be read, with the reason. */
  failures: string[];
}

/**
 * Capture every repository under /workspace that has uncommitted work, and write it to R2.
 *
 * Returns what it saved. Never throws: this runs while the container is being stopped, and a failure
 * here must not turn a clean shutdown into an error path.
 */
export async function captureUncommittedWork(
  sandbox: Container,
  bucket: R2Bucket,
  stamp: string,
): Promise<SavedWork> {
  const result: SavedWork = { prefix: `dsh-work/${stamp}`, repos: [], failures: [] };

  let listing: string;
  try {
    const found = await sandbox.exec("ls -1 /workspace 2>/dev/null || true");
    listing = found.stdout;
  } catch (error) {
    result.failures.push(`could not list /workspace: ${describe(error)}`);
    return result;
  }

  const repos = listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const repo of repos) {
    const dir = `/workspace/${repo}`;
    try {
      // `status --porcelain` is the test for "is there anything to save". A clean tree needs nothing,
      // and saying so is better than writing an empty patch that looks like work.
      const status = await sandbox.exec(`git -C ${dir} status --porcelain 2>/dev/null || true`);
      if (status.stdout.trim().length === 0) continue;

      // The tracked changes, as a patch that can be applied on the next session.
      const patch = await sandbox.exec(
        `git -C ${dir} diff HEAD --binary 2>/dev/null || true`,
      );
      if (patch.stdout.length > 0) {
        await bucket.put(`${result.prefix}/${repo}/changes.patch`, patch.stdout);
      }

      // Untracked files, which `git diff` does not see and which are often the actual work: a new
      // file is invisible to a patch and is exactly what an agent produces most of.
      const untracked = await sandbox.exec(
        `cd ${dir} && git ls-files --others --exclude-standard -z 2>/dev/null | ` +
          `tar --null -T - -czf - 2>/dev/null | base64 -w0 || true`,
      );
      if (untracked.stdout.trim().length > 0) {
        await bucket.put(`${result.prefix}/${repo}/untracked.tar.gz.b64`, untracked.stdout);
      }

      // Where the repository was, so a recovery knows what it is looking at.
      const head = await sandbox.exec(`git -C ${dir} rev-parse HEAD 2>/dev/null || true`);
      await bucket.put(
        `${result.prefix}/${repo}/HEAD`,
        `${head.stdout.trim()}\nBranch and status at capture:\n${status.stdout}`,
      );

      result.repos.push(repo);
    } catch (error) {
      result.failures.push(`${repo}: ${describe(error)}`);
    }
  }

  await bucket.put(
    `${result.prefix}/MANIFEST.txt`,
    [
      `Captured uncommitted work from the dsh workspace at ${stamp}.`,
      ``,
      `Repositories with work: ${result.repos.length > 0 ? result.repos.join(", ") : "none"}`,
      result.failures.length > 0 ? `Could not read: ${result.failures.join("; ")}` : ``,
      ``,
      `To recover a repository on the next session:`,
      `  git clone <origin> <dir> && cd <dir>`,
      `  git apply <(rclone cat .../changes.patch)          # tracked changes`,
      `  base64 -d < .../untracked.tar.gz.b64 | tar -xzf -  # untracked files`,
      ``,
      `This is a safety net, not a workflow. Pushing is still how work leaves this environment:`,
      `this capture only exists for what was not pushed.`,
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SavedSessions {
  /** The R2 key the snapshot was written to, or empty when nothing was written. */
  key: string;
  /** Session directories in the snapshot. */
  sessions: number;
  /** Size of the tar, in KiB, as measured inside the container. */
  kib: number;
  /** What could not be read, with the reason. */
  failures: string[];
}

/**
 * The container-side half of a capture: choose what to keep, then tar it and base64 it to stdout.
 *
 * One statement per line and joined with `;` rather than a multi-line script, because this string
 * goes through `exec` and it is not worth finding out the hard way whether a newline survives the
 * trip.
 *
 * The count of what it selected and the size in KiB go to STDERR, which `exec` returns separately,
 * so the payload on stdout stays exactly the base64 text with no framing of ours in it. An empty
 * store exits 0 with an empty stdout: nothing to save is not an error.
 */
const SESSION_CAPTURE_SCRIPT = [
  "set -u",
  `store=${SESSION_STORE_DIR}`,
  `[ -d "$store" ] || { echo "0 0" >&2; exit 0; }`,
  `cd "$store" 2>/dev/null || { echo "0 0" >&2; exit 0; }`,
  'list=""; count=0; kib=0',
  // Newest first: `ls -1t` orders by the directory's mtime, which moves when its session is written.
  `for name in $(ls -1t 2>/dev/null); do`,
  `  [ -d "$name" ] || continue`,
  `  [ "$count" -lt ${SESSION_SNAPSHOT_MAX_SESSIONS} ] || break`,
  `  size=$(du -sk "$name" 2>/dev/null | cut -f1)`,
  `  size=\${size:-0}`,
  // The budget is consulted only from the second session on, so the newest one is never the one
  // dropped for being large.
  `  if [ "$count" -gt 0 ] && [ $((kib + size)) -gt ${SESSION_SNAPSHOT_MAX_KIB} ]; then break; fi`,
  `  kib=$((kib + size)); count=$((count + 1)); list="$list $name"`,
  "done",
  `echo "$count $kib" >&2`,
  `[ "$count" -gt 0 ] || exit 0`,
  "tar -cf - $list | base64 -w0",
].join("; ");

/**
 * The container-side half of a restore: decode into a staging directory, then move it into place.
 *
 * Nothing reaches the store until the whole archive has decoded - `&&` stops the chain at the first
 * failure - so a half-transfer cannot masquerade as "this container already has sessions".
 */
const SESSION_RESTORE_SCRIPT = [
  `rm -rf ${SESSION_RESTORE_STAGE_DIR}`,
  `mkdir -p ${SESSION_RESTORE_STAGE_DIR}`,
  `base64 -d ${SESSION_SNAPSHOT_FILE} | tar -xf - -C ${SESSION_RESTORE_STAGE_DIR}`,
  `mkdir -p ${SESSION_STORE_DIR}`,
  `find ${SESSION_RESTORE_STAGE_DIR} -mindepth 1 -maxdepth 1 -exec mv -n {} ${SESSION_STORE_DIR}/ \\;`,
  `rm -rf ${SESSION_RESTORE_STAGE_DIR} ${SESSION_SNAPSHOT_FILE}`,
].join(" && ");

/** How many session directories the container currently holds. */
const SESSION_COUNT_SCRIPT =
  `find ${SESSION_STORE_DIR} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l`;

/**
 * Copy the harness's session store out of the container into R2.
 *
 * IDEMPOTENT, BECAUSE OF THE KEY RATHER THAN BECAUSE OF A CHECK. The snapshot is a whole-store tar
 * at one key, so capture is a pure function of the store: running it twice writes the same bytes
 * twice, and a capture that arrives after another has overwritten it with the newer store. Nothing
 * is appended, nothing is timestamped, and there is no half of a previous capture to reconcile.
 * `onActivityExpired` and `onStop` both fire on an ordinary sleep, and both calling this is fine.
 *
 * IT REFUSES TO WRITE AN EMPTY SNAPSHOT. A container with no sessions is either brand new or one
 * whose restore failed, and in both cases overwriting the durable copy with nothing would destroy
 * the only copy of the conversations. Nothing to capture means nothing is written.
 *
 * Never throws: it runs while the container is being stopped.
 */
export async function captureSessions(
  sandbox: Container,
  bucket: R2Bucket,
  stamp: string,
): Promise<SavedSessions> {
  const result: SavedSessions = { key: "", sessions: 0, kib: 0, failures: [] };

  let output: { stdout: string; stderr: string; exitCode: number };
  try {
    output = await sandbox.exec(SESSION_CAPTURE_SCRIPT, {
      signal: AbortSignal.timeout(SESSION_TRANSFER_TIMEOUT_MS),
    });
  } catch (error) {
    result.failures.push(`could not read the session store: ${describe(error)}`);
    return result;
  }

  const counted = /(\d+)\s+(\d+)/.exec(output.stderr);
  result.sessions = counted ? Number(counted[1]) : 0;
  result.kib = counted ? Number(counted[2]) : 0;

  if (result.sessions === 0) {
    // Not a failure and not a write: see "refuses to write an empty snapshot" above.
    return result;
  }
  if (output.exitCode !== 0) {
    result.sessions = 0;
    result.failures.push(`tar of the session store exited ${output.exitCode}: ${output.stderr.trim()}`);
    return result;
  }

  try {
    await bucket.put(SESSION_SNAPSHOT_KEY, output.stdout);
    await bucket.put(
      SESSION_SNAPSHOT_MANIFEST_KEY,
      [
        `The dsh session store, snapshotted from the container at ${stamp}.`,
        ``,
        `Sessions: ${result.sessions} (newest first, capped at ${SESSION_SNAPSHOT_MAX_SESSIONS} or`,
        `${SESSION_SNAPSHOT_MAX_KIB} KiB of files, whichever comes first).`,
        `Tar size: ${result.kib} KiB. Base64 payload: ${output.stdout.length} bytes.`,
        ``,
        `Restored automatically on the next container start, but only into an EMPTY store:`,
        `a container that already has sessions keeps them, because they are newer than this.`,
        ``,
        `To read it by hand: base64 -d sessions.tar.b64 | tar -tf -`,
      ].join("\n"),
    );
    result.key = SESSION_SNAPSHOT_KEY;
  } catch (error) {
    result.failures.push(`could not write the snapshot to R2: ${describe(error)}`);
  }

  return result;
}

/**
 * Put the last snapshot back into a container that has no sessions of its own.
 *
 * THE RULE: RESTORE ONLY INTO AN EMPTY STORE. If the container already holds a single session
 * directory, the snapshot is older than what is on disk - the disk is only non-empty when the
 * container did not restart, or when it restarted and something has already written a conversation
 * - and unpacking an older copy over newer state is the one outcome worth refusing. The check is
 * the first thing this does, and it is the only reason the store is ever skipped.
 *
 * Never throws: it runs inside `onStart`, and a container that cannot be used because a restore
 * failed would trade a missing conversation for a missing workspace.
 */
export async function restoreSessions(
  sandbox: Container,
  bucket: R2Bucket,
): Promise<SavedSessions> {
  const result: SavedSessions = { key: SESSION_SNAPSHOT_KEY, sessions: 0, kib: 0, failures: [] };

  let snapshot: R2ObjectBody | null;
  try {
    snapshot = await bucket.get(SESSION_SNAPSHOT_KEY);
  } catch (error) {
    result.failures.push(`could not read the snapshot from R2: ${describe(error)}`);
    return result;
  }
  if (snapshot === null) {
    // A first-ever start. Nothing to restore is not a failure.
    return result;
  }

  try {
    const existing = await sandbox.exec(SESSION_COUNT_SCRIPT, {
      signal: AbortSignal.timeout(SESSION_TRANSFER_TIMEOUT_MS),
    });
    const onDisk = Number(existing.stdout.trim());
    if (onDisk > 0) {
      result.key = "";
      result.sessions = onDisk;
      return result;
    }

    const payload = await snapshot.text();
    await sandbox.writeFile(SESSION_SNAPSHOT_FILE, payload);

    const restored = await sandbox.exec(SESSION_RESTORE_SCRIPT, {
      signal: AbortSignal.timeout(SESSION_TRANSFER_TIMEOUT_MS),
    });
    if (restored.exitCode !== 0) {
      result.failures.push(
        `restore exited ${restored.exitCode}: ${restored.stderr.trim() || "no output"}`,
      );
      return result;
    }

    const after = await sandbox.exec(SESSION_COUNT_SCRIPT, {
      signal: AbortSignal.timeout(SESSION_TRANSFER_TIMEOUT_MS),
    });
    result.sessions = Number(after.stdout.trim());
  } catch (error) {
    result.failures.push(`could not restore the session store: ${describe(error)}`);
  }

  return result;
}

export class Sandbox extends BaseSandbox<Env> {
  /**
   * The container is up. This is the first moment its disk can be written, and the only moment a
   * restore can run before anything reads the store.
   *
   * `super.onStart()` FIRST, and it is not a formality: the SDK's own `onStart` is what marks the
   * runtime started and reconciles tunnel storage, and skipping it makes the container look
   * unstarted to every later call. The restore follows, and only into an empty store.
   *
   * The container's startup is gated on this method returning (`blockConcurrencyWhile` in
   * containers/dist/lib/container.js), so a slow restore delays the first request rather than
   * racing it - and `restoreSessions` carries its own timeout so "slow" cannot become "never".
   */
  override async onStart(): Promise<void> {
    await super.onStart();
    await this.restoreSessionStore();
  }

  /**
   * The sleep timer expired and nothing is connected. The platform is about to stop the container, so
   * this is the last moment the working tree can be read.
   */
  override async onActivityExpired(): Promise<void> {
    await this.saveWorkThenStop();
  }

  /**
   * The container process is exiting, for a rollout or a stop. Same reasoning, and this path also
   * covers a shutdown the sleep timer did not initiate.
   */
  override async onStop(params: StopParams): Promise<void> {
    await this.saveWork();
    await super.onStop(params);
  }

  private async saveWorkThenStop(): Promise<void> {
    await this.saveWork();
    await this.stop();
  }

  private async saveWork(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await this.captureSessionStore(stamp);

    try {
      const captured = await captureUncommittedWork(this.container(), this.env.STATE, stamp);
      if (captured.repos.length > 0) {
        console.log(
          `dsh: saved uncommitted work to ${captured.prefix} for ${captured.repos.join(", ")}`,
        );
      }
      for (const failure of captured.failures) {
        console.log(`dsh: could not capture ${failure}`);
      }
    } catch (error) {
      // Reported, never rethrown: this runs during shutdown, and failing here must not turn a clean
      // stop into a crash loop that keeps the container alive.
      console.log(`dsh: capture failed: ${describe(error)}`);
    }
  }

  /**
   * The conversation, captured on the same two hooks as the working tree.
   *
   * Its failures are logged exactly like the working tree's and for the same reason: this runs at
   * shutdown, and an exception here must not turn a clean stop into an error path.
   */
  private async captureSessionStore(stamp: string): Promise<void> {
    try {
      const captured = await captureSessions(this.container(), this.env.STATE, stamp);
      if (captured.key !== "") {
        console.log(
          `dsh: saved ${captured.sessions} session(s) (${captured.kib} KiB) to ${captured.key}`,
        );
      }
      for (const failure of captured.failures) {
        console.log(`dsh: could not capture sessions: ${failure}`);
      }
    } catch (error) {
      console.log(`dsh: session capture failed: ${describe(error)}`);
    }
  }

  /** The conversation, put back on start. Never fatal, for the reason given on restoreSessions. */
  private async restoreSessionStore(): Promise<void> {
    try {
      const restored = await restoreSessions(this.container(), this.env.STATE);
      if (restored.key !== "") {
        console.log(`dsh: restored ${restored.sessions} session(s) from ${SESSION_SNAPSHOT_KEY}`);
      }
      for (const failure of restored.failures) {
        console.log(`dsh: could not restore sessions: ${failure}`);
      }
    } catch (error) {
      console.log(`dsh: session restore failed: ${describe(error)}`);
    }
  }

  /**
   * This object as the container interface the capture and restore functions take.
   *
   * The cast is the SDK's, not ours: the base class installs `exec` on the instance at runtime but
   * the 0.12.9 `Sandbox` type does not declare the file and command methods on the class (they are
   * declared on `ISandbox` and on the proxy facade). The shape in `Container` above is what these
   * functions actually use, so the cast claims nothing beyond it.
   */
  private container(): Container {
    return this as unknown as Container;
  }
}
