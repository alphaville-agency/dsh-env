# A reference that does not resolve is the defect

**A capability nothing consumes, or an instruction pointing at something absent, is not a convention
problem — it is the bug. The remedy is always to build the check, not to agree to be careful.**

This recurs: a thing is created and then consumed by nothing, or documented and then removed. It
fails **silently**, and it fails hardest in the environment you were least able to test.

## When this fires

- You add a file, route, script, manifest entry or config key that nothing yet reads.
- You document a command, a path, a skill, a task or a repository.
- You delete, move or rename anything that something else names.

## Real examples, all from live trees

- An `AGENTS.md` router pointed at `/Users/blake/.codex/skills/plane/SKILL.md`, **which does not
  exist in the container** — the line looked correct in the repository and the instruction never
  loaded.
- A vendored config named a **laptop path**; it reviews as correct and resolves nowhere.
- A `Dockerfile` **`COPY`d a directory that had been deleted** in the same change.
- An `AGENTS.md` documented **`mise run test` while `mise/` was empty**.
- A registry's **`worked_example` rendered a namespace that no longer exists**, and the validator
  only **warned**, so the stale example stayed and keeps being copied.
- A comment claimed lockfile reproducibility while the lockfile was **silently ignored**.
- A **`.sh` script that did not run.**

## The remedy: build the check

A convention that says "keep these in step" is a wish. A check that fails when the reference dangles
is the fix:

- **Every referenced path exists** in the tree or image it will be read from.
- **Every created capability has a consumer**; no consumer is a recorded reason with a matching
  lifecycle, never a blank.
- **Every documented command runs** in the environment that documents it.
- **Every rendered example matches what the code renders now**, and drift **fails** rather than
  warns.

A documented-but-absent command is **worse than an undocumented one**: an undocumented command is
visibly missing, while a documented one is trusted, fails silently, and is trusted again next
session.

Related: [`prior-art.md`](prior-art.md) — many dangling references exist because a thing was built
instead of found.
