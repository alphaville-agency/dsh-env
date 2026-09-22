# One writer per working tree

**One agent writes to a working tree at a time. If two must write, partition by file and state the
boundary in both prompts, or serialise them.**

Concurrent writers do not produce a merge conflict you can review. They produce a tree that is
internally inconsistent in ways neither writer can see, because each one's view of the files is from
before the other's edit.

## When this fires

- You are dispatching two or more subagents at the same repository, branch or checkout.
- A delegated prompt says "the repository" without naming which files that task owns.
- You are about to edit a tree someone else might be midway through.

## Worked example

Two subagents were editing the same repository concurrently. The visible result:

- one **deleted `agent/`** while the other's **repointed `Dockerfile` still referenced it**, so the
  image build broke;
- a commit **swept up a file from a third task**;
- a rename was **half-applied** — one tree, two names.

## How to notice, and what to do

- `git status` **before** you write, and again before you commit. Staged or untracked work that is
  not yours is a second writer.
- If two of your own reads disagree — a directory that existed a minute ago is gone, a file's size
  changed between reads — another writer is active. **Stop editing that tree**; finish, or hand the
  work off.
- Parallel streams belong in `git worktree`, one per stream, not two agents in one checkout.
- A boundary is stated, not implied: "worker A owns `src/` and `wrangler.jsonc`; worker B owns
  `agent/` and does not touch the Dockerfile."

Related: [`prove-the-floor.md`](prove-the-floor.md) — a tree two writers share is an unproved floor.
