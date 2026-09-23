---
name: plane
description: Use the Plane CLI for project-management work involving projects, work items/issues, cycles, modules, intake, labels, states, documents, comments, members, and related resources. Apply when Plane is the system of record or a Plane identifier is mentioned.
---

# Plane CLI

Use the installed Plane CLI as the primary interface. Prefer `planecli` when available; if only another Plane CLI is installed, inspect its help and use its native equivalents. Do not silently fall back to ad hoc HTTP calls or local tracking files.

## Workspace resolution

Resolve the workspace per repository, never globally.

- Ignore directories that are not Git repositories or have no remote.
- Inspect the active repository's remote (normally `git remote get-url origin`) and extract the Git organization/account.
- Use an already-established repository-to-workspace mapping without asking again.
- If no mapping exists, suggest the Git organization/account as the Plane workspace name and ask for confirmation before the first Plane operation that depends on workspace selection.
- Keep the workspace selection scoped to the current operation/repository; do not write organization or workspace names into this skill.

## Operating rules

- Read current Plane state before mutations, including the target project/item and relevant comments, state, labels, cycle, module, or members.
- Use JSON output for agent parsing and bypass stale caches after writes. Read back important writes from the server before reporting success.
- Before creating or changing records, summarize the intended external change when the request is ambiguous. Deletions, intake rejection/deletion, bulk updates, and other irreversible actions require explicit user intent.
- Preserve rich descriptions as HTML when the CLI expects HTML; do not assume Markdown will render correctly.
- If a create command returns an unclear result, verify by searching/listing before retrying to avoid duplicates.
- Attribute work by the actual agent/tool identity in the form `<agent-or-tool-name>@<project-name>` when comments or descriptions need provenance. Do not assume a particular model, vendor, or delegated-agent profile.
- Never place API keys in repositories, prompts, issue descriptions, comments, shell history, or generated files. Use the CLI's secure profile/keyring or environment variables.

## Common command families

Use the CLI's current help/reference for exact flags. Typical `planecli` families are:

```text
planecli whoami --json
planecli project ls --json
planecli wi ls -p PROJECT --json
planecli wi show ISSUE --no-cache --json
planecli wi create ... --json
planecli wi update ISSUE ... --json
planecli cycle ls -p PROJECT --json
planecli module ls -p PROJECT --json
planecli intake ls -p PROJECT --json
planecli label ls -p PROJECT --json
planecli state ls -p PROJECT --json
planecli doc ls -p PROJECT --json
planecli comment ls ISSUE --json
```

Read [references/cli-reference.md](references/cli-reference.md) before using unfamiliar commands, bulk operations, documents, intake, or any destructive operation.

## Triggers and suggested actions

Use Plane proactively when the repository has a remote and the user asks to plan, track, prioritize, assign, triage, schedule, review, or report work. Suggest—but do not silently perform—these follow-ups when the context supports them:

- New repository or product area: discover the workspace, find or create the matching Plane project, then offer a lightweight project setup.
- New feature or significant change: propose an initiative/epic or parent work item, child work items, labels, ownership, and a cycle.
- Bug or incident: capture reproduction, impact, severity/priority, owner, evidence links, and a clear verification condition.
- Pull request or completed implementation: link the PR, update the work item, add a concise implementation note, and move it only when the evidence supports the state change.
- Sprint/cycle planning: review carry-over items, capacity/ownership, unassigned urgent work, and dependencies before proposing a cycle.
- Standup/status request: summarize recently changed items, current blockers, next actions, and stale/unowned work.
- Intake/triage request: list pending intake, classify duplicates, identify missing information, and recommend accept/decline/defer; do not delete or reject without explicit scope.
- Project appears stale: report evidence first, then suggest archiving, re-scoping, or a cleanup pass rather than changing it automatically.

## Recommended project setup

For a new or materially changed project, use this order:

1. Confirm the repository-to-workspace mapping and project identity.
2. Inspect existing projects, states, labels, members, cycles, modules, and documents to avoid duplicates.
3. Create or update only the project-level structure needed for the requested work.
4. Define a small state flow, useful labels, ownership, and a first cycle only when they serve an identified workflow.
5. Add a project overview document with purpose, scope, links, operating status, and decision log when documentation is requested or clearly useful.
6. Create parent work items before child items; link dependencies and external evidence.
7. Read back the resulting structure and report identifiers, assumptions, and open decisions.

Avoid creating speculative labels, empty cycles, duplicate projects, or elaborate custom properties before there is a demonstrated need.

## Workflow quality bar

- Every active work item should have a useful title, enough context to act, a project, an appropriate state, and an owner or an explicit unassigned reason.
- Prefer one canonical work item over parallel notes; link related PRs, documents, incidents, and discussions.
- Keep descriptions outcome-oriented: context, requested result, acceptance/verification criteria, constraints, and links.
- Use cycles for time-bounded commitments and modules for larger feature groupings; do not use either as a generic filing cabinet.
- Keep state changes evidence-based and avoid moving items merely to make a report look tidy.
- After a batch operation, verify counts and representative records server-side.
