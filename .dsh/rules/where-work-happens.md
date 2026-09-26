# The laptop builds the environment; the environment builds the agency

**This laptop's job is to build and operate the remote environment. It is not where the agency is
built.** Once the environment works, clean-slate development — the agency, its products and its
infrastructure — happens inside it.

The reason is not preference. The laptop is slow, work on it is reproducible for nobody else, and it
makes the project depend on one machine — which is the opposite of the governing test, that the
agency must not depend on us. **Code that only runs on this laptop is not shipped code.**

## The frozen legacy project is not resumed

Its stored sessions are archived, not runnable. **If one becomes resumable again, that is a defect to
fix, not an invitation to continue.**

## What local work is still legitimate

- Building and fixing the environment itself.
- Anything that genuinely cannot be done remotely — and the specific limitation gets **named each
  time**, never assumed.

## Worked example

A long stretch of agency-adjacent design — the naming registry, the ontology, goals and decisions —
was done locally. It belonged in the environment as soon as the environment existed; it was tolerable
only because the environment did not work yet. That is the whole test: **locally, because nothing
else runs yet — never locally because it is convenient.**

Related: [`prove-the-floor.md`](prove-the-floor.md) — the environment is the floor the agency is
built on; this rule is where that floor is stood up.

## Commit and push after every step, not at the end

The disk here is ephemeral, and a turn can end without warning. Measured: a session spent its whole
turn designing and writing the step-1 console, and before it pushed anything the container's Durable
Object was reset because the Worker's code was updated. The turn died mid-plan. `git log` on the
capability repo still showed the commit from before the session started — **the entire turn's work was
in `/workspace` and is gone.** The R2 capture on stop is a safety net for a clean stop, not a
substitute for pushing.

So the discipline is:

- **Push the first thing that is coherent**, then keep pushing. A commit you have pushed survives a
  reset, a deploy, a crash and a sleep; a commit you are still working on does not.
- Write a note to the repo EARLY — what you are about to do, what you learned — and push it, before
  the long part. If the turn dies, the next one starts from your note rather than from nothing.
- Never let "commit and push" be the last item on a plan. It is the first item, repeated.

An operator deploying the environment can also end a turn by accident, because a Worker update resets
the Durable Object that holds the container. Both ends of that are the same fix: the work has to leave
the box continuously, not at the end.
