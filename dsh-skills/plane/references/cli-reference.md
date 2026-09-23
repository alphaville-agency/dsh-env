# Plane CLI reference

This skill is intentionally CLI-first and workspace-agnostic. Command names and flags can change, so inspect the installed binary before guessing:

```bash
command -v planecli || command -v plane
planecli --help
planecli <resource> --help
```

The preferred `planecli` conventions are documented by the upstream agent skill and include:

- `--json` for machine-readable output; keep table output off the parsing path.
- `--no-cache` for authoritative reads after mutations.
- Fuzzy resolution of project, state, label, user, and issue names, identifiers, or UUIDs; use UUIDs when ambiguity matters.
- `wi`, `project`, `cycle`, `module`, `intake`, `label`, `state`, `doc`, `comment`, `users`, and `whoami` resource families.

## Safe mutation pattern

1. Resolve repository and workspace from the Git remote and the known mapping.
2. Read the target resource and related context with JSON output.
3. Perform the smallest requested mutation.
4. Re-read with cache bypass and compare the intended fields.
5. Report the Plane identifier and resulting state.

For creates, inspect the returned identifier and verify it server-side before retrying. A formatter or pipe failure can occur after a successful create, and Plane does not provide an idempotency key.

## Content and destructive-operation notes

- Work-item descriptions may be stored as HTML. Convert Markdown to HTML before passing it to a description flag that expects HTML, then verify the stored HTML.
- Intake commands may operate on the underlying work-item UUID rather than the intake wrapper ID; inspect the command output and help before mutating intake.
- Deleting work items, intake records, comments, projects, modules, or cycles is irreversible or difficult to undo. Confirm exact scope and read the current record first.
- Do not put `PLANE_API_KEY` or other credentials in `.env` files committed to a repository. Prefer the CLI keyring/profile; for automation use process environment variables supplied by the runtime.
- When provenance is useful, identify the active agent/tool as `<agent-or-tool-name>@<project-name>` rather than hard-coding a model or vendor name.

## Workflow recipes

### New project or repository

Inspect the Git remote and workspace mapping, then list projects before creating anything. If there is no matching project, ask whether to create one and collect its name, identifier, purpose, owner, and initial delivery horizon. After creation, add only the states, labels, members, cycle/module, and overview document needed by the stated workflow.

### Feature decomposition

Create one parent item describing the outcome and verification criteria. Add child work items with independently testable results, explicit ownership, priority, dependencies, and links. Put the work into a module when it spans multiple cycles; put it into a cycle only when it is a time-bounded commitment.

### Bug or incident triage

Capture impact, reproduction, environment, evidence, severity, and verification criteria. Search for duplicates before creating. Assign an owner, choose a state and priority based on evidence, and link the incident, PR, or logs. Keep sensitive credentials and private data out of Plane.

### Cycle planning and closure

Before starting a cycle, review carry-over, unassigned urgent items, dependencies, and capacity. At closure, identify incomplete work, confirm whether it should transfer, and report what was completed, deferred, blocked, or dropped. Do not archive or transfer items without clear scope.

### Standup and project status

Read recent activity and current work items. Return completed/recently changed work, in-progress work, blockers, stale items, and concrete next actions. Cite Plane identifiers and linked evidence; distinguish observed facts from recommendations.

### Intake triage

List pending intake and inspect each candidate before acting. Recommend accept, duplicate, defer, or decline with rationale. Accept only when the project, title, context, and owner/next action are clear. Treat decline/delete as destructive and require exact user scope.

## Sources used

- ClarityReg `plane-claude-skill`: broad Python API-script coverage and workflow examples.
- Patrick Alves `plane-cli` skill: CLI conventions, cache/write verification, HTML descriptions, and mutation gotchas.
- Plane's official `plane-mcp-server` documentation: supported resources, API-key configuration, and transport behavior.
