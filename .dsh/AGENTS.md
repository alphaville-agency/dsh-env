# DSH shared agent instructions

For any Plane-related task, invoke the `plane` skill. It is installed in the shared catalog at
`~/.agents/skills/plane/`, alongside every other skill, and the harness discovers it natively —
there is no separate per-agent location and no absolute path to remember.

This applies to DSH DeepSeek sessions, including the TUI and web profiles, subagents, and CLI-backed harnesses. Follow the skill's CLI-first workspace resolution, project setup, workflow, attribution, and verification rules. Load `references/cli-reference.md` only when the requested operation needs detailed command or workflow guidance.

For model routing, read and follow `MODEL-ROLES.md`: deepseek-v4.1-flash orchestrates, gpt-5.6-luna performs worker tasks, and gpt-5.6-sol provides final authority and Sprint review/advice.

## Design rule: just works first, complexity is progressive and opt-in
Full text: [`rules/design-ladder.md`](rules/design-ladder.md) — read it before designing a config, a default, or an optional feature.

## Research taste: prefer the surreal, the found, and the meaningful
Full text: [`rules/research-taste.md`](rules/research-taste.md) — read it before choosing what to investigate.

## Search the field before you build
Full text: [`rules/prior-art.md`](rules/prior-art.md) — read it before hand-rolling plumbing, picking a base image or packaging approach, inventing a format or vocabulary, or building anything the platform, the standard library, or a known tool plausibly already does. Find how the problem is already solved, cite what you found, and name the concrete constraint if you reject the standard approach. The operator should not have to do this searching for you.

## Reaching the internet
Full text: [`rules/web-research.md`](rules/web-research.md) — read it before fetching or searching anything on the web. Use [Agent Reach](https://github.com/Panniantong/agent-reach): `agent-reach doctor` for per-channel status, then call the upstream tool it selects (`curl https://r.jina.ai/<url>`, `gh repo view`, `yt-dlp`, `bili`, `feedparser`, Exa for semantic search). Its default install is a read-only check; only `--system` mutates the machine. Do not `pip install agent-reach` from PyPI — that is a different package.

## Attribute a measurement before you act on it
Full text: [`rules/attribute-the-measurement.md`](rules/attribute-the-measurement.md) — read it before optimising, shrinking, speeding up, or spending time against any number an error, a limit or a dashboard gave you. Name the resource the measurement belongs to and prove it is the one you are changing: two resources sharing a name prefix is how hours went into cutting ~947 MB off an image that was never the image being rejected, while the real error was about an orphaned container application.

## Prove the floor before you stack on it
Full text: [`rules/prove-the-floor.md`](rules/prove-the-floor.md) — read it before adding a second layer on a platform you have not run once. Build the thinnest thing that proves the contract, prove it with real output, then add one layer at a time and stop at the first break. A lease Durable Object, a provisioner, a persistence manifest, a terminal client and a bootstrap were all built on a container that had never executed a command; the operator's fix was to delete them and rebuild from a floor that runs `echo`.

## A build claim is measured, not asserted
Full text: [`rules/build-claims.md`](rules/build-claims.md) — read it before changing a Dockerfile, a build step, a lockfile or an install, and before writing any comment claiming a build is smaller, pinned, cached or reproducible. Deletion in a later layer reclaims 0 bytes (a final `RUN rm -rf` reclaimed nothing of a 2.2 GB image), so the removal belongs in the same `RUN` that creates the bytes; and a reproducibility claim is true only if the mechanism that pins the build actually runs.

## One writer per working tree
Full text: [`rules/one-writer-per-tree.md`](rules/one-writer-per-tree.md) — read it before dispatching two agents at one repository or checkout. One writer per tree; if two must write, partition by file and state the boundary in both prompts, or serialise them. Two concurrent writers on one tree deleted `agent/` while a repointed `Dockerfile` still referenced it, so the image build broke.

## A reference that does not resolve is the defect
Full text: [`rules/dangling-references.md`](rules/dangling-references.md) — read it before documenting a command, path, skill or repository, before deleting or renaming anything something else names, and before creating a capability nothing consumes. Build the check, not the convention: an `AGENTS.md` pointing at a skill file that does not exist in the container, a `Dockerfile` `COPY`ing a deleted directory, and a registry example rendering a namespace that no longer exists all review as correct and fail silently.

## The laptop builds the environment; the environment builds the agency
Full text: [`rules/where-work-happens.md`](rules/where-work-happens.md) — read it before starting any agency, product or infrastructure work that is not about the environment itself. This laptop builds and operates the remote environment; clean-slate development happens inside it; the frozen legacy project is never resumed; and anything that cannot be done remotely is named as a limitation each time rather than assumed.

## Inference spending: the operator decides, the environment decides for itself

The default is the **reserved pool**: `deepseek-v4.1-flash` as the cheapest suitable orchestrator,
with `mimo-v2.6-flash` beside it. During the reserved block that subscription is already paid for, so
using it costs nothing at the margin and it is what every environment should reach for first.

**Escalation is by rule, never by mood.** In order: the pool (free at the margin) → the worker role
(`gpt-5.6-luna`, answered as `mimo-v2.6-flash` inside the reserved block) → the frontier chain
(`gpt-5.6-sol`, `gpt-6-astra`, `claude-opus-5.5`, `claude-opus-5`) for the reviewer, advisor and
final-authority roles. Ask for a higher tier when the ROLE requires it; do not reach for the top
model because a task feels hard.

**A wallet spend needs the operator's confirmation first.** The frontier chain is wallet-only, and
every entry in it answered HTTP 402 `Insufficient wallet balance` when measured on 2026-09-25. So:

- do NOT fund the wallet, and do not enable Cloudflare unified billing, on your own initiative;
- do NOT silently downgrade a role to a free model when the frontier chain refuses — report the 402
  and say what it would cost, then wait;
- do NOT retry a 402 in a loop or across models hoping one succeeds.

That is the line: the reserved pool is the environment's to spend, and the wallet is the operator's to
authorise.

**The agency is the exception, and it is deliberate.** The agency runs with no operator in the loop,
so it acts on its own judgement: autopilot, its own decisions, its own escalation. When the custom
gateway does not carry the model it needs, it routes to **unified billing through Cloudflare's native
providers** rather than to our wallet. Its spending is bounded by two things that do not depend on its
own restraint, and by its agents' own judgement about what a task is worth:

- **a rate limit on `alphaville-inference-gateway` — set, 120 requests per 60 seconds** (measured back
  from the API).
- **a budget of $15/month on that gateway** — *not yet set, and not settable from here*. The
  account-wide `spending_limit` API is deprecated and refuses to be created or modified ("AI Gateway
  spending limits are deprecated and can no longer be created, enabled, or modified"), and the
  replacement per-gateway spend limits have no published API endpoint — four plausible paths all
  answer `Route not found`. So the $15 budget is a **dashboard step**: AI Gateway →
  `alphaville-inference-gateway` → Settings → Spend limits → add a rule for $15 over a monthly
  window. Until it exists, the only spend bound on the agency is its rate limit and its own agents'
  discipline.
