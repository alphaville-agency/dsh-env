# The development loop: specification, branching, review, merge

This is the process the remote environment runs. It is not advisory — the loop's trigger reads an issue
and works it, and nothing is merged without the gates below.

## Why GitHub rather than Plane

Both were acceptable. GitHub wins on one concrete fact: **`gh` is already authenticated in the container
and works** (`gh search`, `gh api`, `gh pr` all verified), whereas Plane needs another live credential
before the loop can read a single requirement. A loop that cannot read its own plan is the knee-jerk
this process exists to prevent, so the tool that works today is the tool that runs today. The process
below is deliberately written against concepts Plane also has — documents, items, cycles, states — so a
move to Plane is a translation of the vocabulary, not a redesign.

## 1. Specification comes first, and it follows SpecKit

**This is prior art, not an invention.** [`github/spec-kit`](https://github.com/github/spec-kit) is the
established spec-driven-development toolkit, shipping `constitution-template.md`, `spec-template.md`,
`plan-template.md`, `tasks-template.md`, `checklist-template.md` and the `commands/` that drive them
(`/specify`, `/plan`, `/tasks`). The frozen `alphaville-foundry` repository already uses exactly this
shape — `specs/004-appflowy-state-plane/{spec,plan,tasks}.md` — so the convention is already in the
family and adopting it is a continuation rather than a new vocabulary.

The first draft of this document invented `PRD.md` / `ARD.md` / `DLD.md` instead. That was the
prior-art rule being broken by the document that enforces it, and it is corrected here.

**Structure**, one directory per work item, `specs/<issue>-<slug>/`:

| File | From | What it holds |
|---|---|---|
| `constitution.md` | SpecKit | The standing rules this work is bound by, inherited rather than re-derived |
| `spec.md` | SpecKit | The requirement: what problem, for whom, what done looks like, and the acceptance criteria |
| `plan.md` | SpecKit | The technical approach: components, boundaries, data flow, and what is deliberately not being done |
| `tasks.md` | SpecKit | The ordered, individually checkable tasks that implement the plan |
| `checklist.md` | SpecKit | Pre-merge checks, so review is a checklist and not a mood |
| `EVIDENCE.md` | this environment | Commands and their real output. Not prose, and not optional: "it works" is not evidence |

**How it runs in the loop.** The session drafts each sprint/feature from an initial sketch, then the
heavier model writes the formal `spec.md` / `plan.md` / `tasks.md` against it, taking into account the
standing rules (`constitution.md`, `.dsh/rules/`), the clean-slate docs, and prior work on
`alphaville-foundry`. The spec is a pull request of its own, merged before implementation begins.

## 2. Branching

- `main` is the only long-lived branch and is **protected**: no direct pushes, no force pushes, PR
  required.
- One branch per item: `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `docs/<issue>-<slug>`,
  `chore/<issue>-<slug>`.
- Specs land on the same branch as the work they describe (`docs` commits first, then implementation),
  unless the spec is a PR of its own — in which case the work branch is cut from it after merge.
- Commit messages reference the issue: `(#123)`. The issue is the durable index; a commit that does not
  reference one cannot be traced back to a requirement.

## 3. Review gates, in order

A PR moves through three gates. Each leaves **comments on the PR**, because the review's value is in what
it told the next reader, not in the fact that it happened.

1. **Orchestrator** — the session's own model (`deepseek-v4.1-flash`) reviews first: does the diff match
   the spec, does it follow the rules, does `EVIDENCE.md` support the claims. Comments on the PR.
2. **Heavier model** — `gpt-5.6-sol` reviews architecture and design decisions. Comments on the PR.
   This is the reviewer role, and it is deliberately not the implementer's own judgement.
3. **Operator (optional)** — the operator may join at any point. Operator absence is not a block;
   operator comment is.

**Merge rule.** Auto-merge when: every gate has run, no gate left a blocking comment, and required
checks are green. The mechanism is `gh pr merge --auto --squash`, enabled when the PR opens, so it merges
the moment the last condition clears rather than waiting for someone to notice.

**Escalation, not stalling.** If the reviewer model is unavailable (a 402, an outage), the PR is labelled
and the loop waits — it does not downgrade the gate to keep moving. A gate that can be skipped under
pressure is not a gate.

## 4. States, as labels

`spec` → `ready` → `in-progress` → `in-review` → `approved` → `merged`, plus `blocked` with a reason. The
loop picks up `ready` items only, and an item is `ready` only when its spec is merged. This is what makes
"work on what is assigned" mean something.

## 5. What the loop does on each wake

1. Read intake: new mail to `dev@alphaville.space`, a changed queue, a scheduled tick, a PR comment.
2. **Decide, do not execute.** Is this a change to the plan? Create or update an issue, write the spec,
   or reject it with the reason recorded on the issue.
3. If an item is `ready` and assigned, work exactly one to its acceptance criteria on its own branch.
4. Open the PR, enable auto-merge, and let the gates decide.
5. Record what happened on the issue, so the next wake starts from the record and not from scratch.

A wake that edits code before step 2 has happened is the failure mode this process exists to prevent.

## 6. Non-transience

Everything above lives in git or in issues — never only in a turn, a container, or a chat. The container's
disk is ephemeral; the process cannot be. Concretely: specs in `docs/specs/`, the process in this file,
state in labels, history in commits that reference issues, and evidence in `EVIDENCE.md`.

**Rules this process is bound by**, and must be checked against in the orchestrator gate: one writer per
tree; a build claim is measured, not asserted; a reference that does not resolve is the defect; prove the
floor before stacking on it; attribute a measurement before optimising against it.


## 7. Build on the harness's own lifecycle, not beside it

The first draft of this document proposed a bespoke loop: a Worker cron, a queue in R2, and a prompt
kept in the loop's own text. That duplicates machinery the harness already runs and is exactly the kind
of hand-rolled plumbing the prior-art rule exists to stop.

[`docs/agent-lifecycle.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md)
defines what is natively supported, and the loop should be composed from these:

| Need | Native primitive |
|---|---|
| Queue work into a session | `followup(content)`, and the `agent/inbox/*` events (`spliced`, `inserted`, `claimed`) that publish it |
| Loop the same goal across rounds | `dsh-goal` + `dsh-goal-round-driver` ("race-fenced same-session goal-round driver") |
| Iterate a fresh agent per attempt | `dsh-tool-ralph` |
| Fan work out across many agents | the workflow tool, and `dsh-tool-subagent` (continuable) |
| Run on a schedule | `dsh-schedule` |
| Inject or reject the next step | the `agent/pre-step` waterfall — its decision is authoritative |
| Rewrite the request before it is derived | the `agent/request` waterfall |
| Recover from a failed request | the `agent/request-error` waterfall (retry returns an action; otherwise the original error stands) |
| Terminal checkpoint before a turn stops | `agent/turn-stopping` (serial) |
| Steer or inject context mid-flight | steering and injected context, through the same waterfall after a later claim |
| Durable replay facts | `session/event` — read this, not `agent/*`, for a transcript |
| Live control and status | `agent/*` (queue, status, interception, steering, continuation, errors) |
| Bridge to the remote environment | `dsh-mcp-client` + `bin/remote-mcp.mjs` (already built and verified) |
| React to CI or PR events | `dsh-hooks-claude-code` / `dsh-hooks-codex` hook protocols |

**Two consequences for the design above.**

- **The plan is injected, not remembered.** "Read intake, decide, then execute" is a composition:
  a schedule or a webhook wakes the session, an `agent/pre-step` listener supplies the plan and the
  rules as context, and the driver's own queue supplies the item. The loop does not need its own
  prompt to carry the process, because the waterfall can supply it every step.
- **The review gates are hook points, not a bespoke state machine.** Intake being deliberate is
  enforceable natively: a `pre-step` listener that rejects a step whose item has no merged spec is the
  rule expressed in the mechanism that already governs steps.

The bespoke version is not forbidden — but it must be a deliberate rejection of a native primitive with
the constraint named, not an oversight. Nothing in the first draft met that bar.
