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

## 1. Specification comes first, and it is an artifact

Nothing is implemented before its design exists in the repository. Each work item carries, as files in
`docs/specs/<issue-number>-<slug>/`:

| Document | Question it answers |
|---|---|
| `PRD.md` | What problem, for whom, and what does done look like |
| `ARD.md` | The architecture: components, boundaries, data flow, and what we are deliberately not doing |
| `DLD.md` | The detailed design: schemas, interfaces, state machines, failure modes |
| `wireframes/` | Where there is a surface, what it looks like |
| `EVIDENCE.md` | What was actually run, and what it returned |

The spec is a **pull request of its own**, merged before implementation begins. A design that lives only
in a turn dies with the turn, and this project has watched that happen.

`EVIDENCE.md` is not optional and not prose: commands and their real output. "It works" is not evidence.

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
