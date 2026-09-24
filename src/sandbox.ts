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
 */
import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import type { StopParams } from "@cloudflare/containers";

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
  sandbox: { exec: (command: string) => Promise<{ stdout: string; exitCode: number }> },
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

export class Sandbox extends BaseSandbox<Env> {
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
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const sandbox = this as unknown as {
        exec: (command: string) => Promise<{ stdout: string; exitCode: number }>;
      };
      const captured = await captureUncommittedWork(sandbox, this.env.STATE, stamp);
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
}
