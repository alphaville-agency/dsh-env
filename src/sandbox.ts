/**
 * The Sandbox subclass, which exists for one reason: to save uncommitted WORK before the container
 * is stopped.
 *
 * WHY THIS CLASS EXISTS AT ALL. The platform documents that all disk is ephemeral - "when a Container
 * instance goes to sleep, the next time it is started, it will have a fresh disk as defined by its
 * container image". The obvious answer - "commit and push before you stop" - pushes a machine's
 * problem onto a person, and it is exactly the kind of step that gets forgotten at the end of a
 * session. It is also not necessary, because the platform tells us when it is about to stop:
 * `onActivityExpired()` runs when the sleep timer expires, and `onStop()` runs when the container
 * process exits. Both run Worker code with the container still reachable.
 *
 * WHAT THIS DOES NOT DO. It does not commit anything. A session's work is the agent's or the
 * operator's to describe, and an automatic commit with a generated message produces history nobody
 * can read - which is worse than an honest uncommitted tree. What it does is make the UNCOMMITTED
 * work leave the container: a patch, and a bundle of untracked files, written to R2 through the
 * binding.
 *
 * It also cannot save what it cannot reach: an agent that is mid-edit when the timer fires gets
 * whatever exists at that instant.
 *
 * THIS FILE NO LONGER TOUCHES THE CONVERSATION STORE, AND THAT IS THE POINT. An earlier version
 * captured `/root/.dsh/sessions` on these same hooks and restored it in `onStart`. After an
 * eight-minute sleep the container still came back cold, re-cloned its repositories and printed
 * `[no stored conversation to attach to: starting a new one]`. So the store is no longer copied at
 * all: it is MOUNTED. The Worker mounts the R2 bucket at `/mnt/state` from the terminal route,
 * immediately before the PTY opens (src/worker.ts, `ensureStateMounted`), and `bin/dsh-session`
 * symlinks `/root/.dsh/sessions` into it. One mechanism, on the path that actually runs.
 *
 * What is left here is the other payload, which has no mount and could not have one: `/workspace`
 * is a git working tree, and s3fs was measured unusably slow for that workload. It is captured on
 * the shutdown hooks, where the platform says the container is about to go.
 */
import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import type { StopParams } from "@cloudflare/containers";

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
      ``,
      `The CONVERSATION is not here. It is not copied at shutdown at all: the session store is`,
      `mounted from R2 before the terminal opens, so it is never on the ephemeral disk to lose.`,
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Nothing in this class is `private`, deliberately.
 *
 * A `private` member makes a class NOMINAL in TypeScript, so this subclass stops being structurally
 * assignable to the SDK's `Sandbox<any>` - and the failure surfaces somewhere unrelated: the Worker
 * cannot pass `DurableObjectNamespace<Sandbox>` to `getSandbox`, reporting instead that our type is
 * "missing" the very methods this file defines. That is a confusing error for a one-word cause.
 *
 * `protected` is fine where the method is genuinely internal; the helpers below are simply not
 * marked, which keeps the class structural.
 */
export class Sandbox extends BaseSandbox<Env> {
  /**
   * The sleep timer expired and nothing is connected. The platform is about to stop the container, so
   * this is the last moment the working tree can be read.
   *
   * THERE IS NO `onStart` HERE ANY MORE. It existed to put the conversation store back before
   * anything read it, and it did not do that - see the file header. Restoring is now a mount, made
   * from the terminal route before the PTY opens, which needs no hook and cannot be skipped.
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
    await this.stoppingHook(params);
  }

  /**
   * `super.onStop`, with the one failure that repeats made survivable.
   *
   * WHY THIS WRAPPER EXISTS. `wrangler tail` on the live Worker showed the alarm firing roughly once
   * a second, every time with:
   *
   *   There is no container instance that can be provided to this Durable Object, try again later
   *
   * That is a hot loop, and it costs money and blocks the DO: `Container.alarm()` re-arms itself
   * (`setAlarm(Date.now())`) BEFORE it runs the stopping path, so any exception thrown in that path
   * leaves the alarm due immediately and it fires again at once. Each iteration re-throws the same
   * platform message. The container being unavailable is precisely the situation this hook runs in,
   * so asking the base class to tear down a runtime that the platform will not hand over is expected
   * to fail - and an expected failure must not be the thing that keeps the DO awake forever.
   */
  async stoppingHook(params: StopParams): Promise<void> {
    try {
      await super.onStop(params);
    } catch (error) {
      console.log(
        `dsh: the base stop hook could not run (${describe(error)}); ` +
          `the container is already gone, so there is nothing left to tear down here.`,
      );
    }
  }

  async saveWorkThenStop(): Promise<void> {
    await this.saveWork();
    // Same reasoning as `stoppingHook`: the sleep timer fires when nobody is connected, so a
    // container that has already gone is the ordinary case here rather than an error. A throw from
    // `stop()` is what turned one expiry into an alarm loop.
    try {
      await this.stop();
    } catch (error) {
      console.log(`dsh: could not stop the container (${describe(error)}); it is already stopped.`);
    }
  }

  async saveWork(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    try {
      const captured = await captureUncommittedWork(this.asContainer(), this.env.STATE, stamp);
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
   * This object as the container interface the capture functions take.
   *
   * The cast is the SDK's, not ours: the base class installs `exec` on the instance at runtime but
   * the 0.12.9 `Sandbox` type does not declare the file and command methods on the class (they are
   * declared on `ISandbox` and on the proxy facade). The shape in `Container` above is what these
   * functions actually use, so the cast claims nothing beyond it.
   */
  protected asContainer(): Container {
    return this as unknown as Container;
  }
}
