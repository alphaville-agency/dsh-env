# Search the field before you build

**Before you design or hand-roll anything non-trivial, find out how this problem is already
solved.** The operator should never have to do this searching on your behalf — do it, and report
what you found.

## When this fires

- You are about to **hand-roll plumbing**: a daemon, supervisor, heartbeat, poll loop, sync, proxy,
  auth gate, scheduler, retry layer, session mechanism, upload, or queue.
- You are **choosing a base image, runtime, or packaging approach**.
- You are **inventing a format, schema, vocabulary or naming scheme**.
- The work is **not specific to this product** — anything the platform, standard library, or a
  well-known tool plausibly already does.
- You catch yourself thinking **"this is simple, I'll just write it"**, **"there's no library for
  this"**, or **"we're the first to need this"**. Those are the trigger, not a licence to proceed.

## How to search

1. **The platform's own docs and templates first.** Official docs, the vendor's example/template
   repository, the vendor's SDK, the changelog. If the platform ships a way, that *is* the answer and
   your job becomes following it rather than improving on it.
2. **Whether the platform already does this natively** — often a config flag, not a mechanism.
3. **Established standards** for anything with prior art: naming, identifiers, provenance, access
   control, interchange formats. Adopt rather than invent locally.
4. **What others actually did**, including failure modes and post-mortems. Someone has hit it.
5. **Whether a known tool exists** for the exact job, and whether it is standard.

## What done looks like

State, in the change itself: **what you found** (mechanism/tool/standard + link), **what you chose**,
and if it is your own approach, **the concrete constraint the standard one violates**. "It's simple"
and "I didn't look" are not reasons. Cite the source — research that leaves no trace may as well not
have happened, and the next session repeats it.

## Worked example

Asked to shrink a container image, the instinct is to hand-write `rm -rf` of caches — which does not
even work across Docker layers. The field already has tools for exactly this
([slim](https://github.com/slimtoolkit/slim), `dive`, `docker history`). Searching first would have
found them in one query; not searching cost several build cycles and a wrong fix. **The rule is:
search before you build, then say what you found.**

Related: [`design-ladder.md`](design-ladder.md) decides *when not to write code* — this rule is how
you find out what to write instead when you do. [`research-taste.md`](research-taste.md) is about
what is worth investigating; this is about not inventing what exists.
