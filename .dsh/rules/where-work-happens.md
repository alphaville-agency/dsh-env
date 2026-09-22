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