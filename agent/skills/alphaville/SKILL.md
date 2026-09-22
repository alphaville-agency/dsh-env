---
name: alphaville
description: "Observe and trigger the live Alphaville Foundry agency through its own MCP surface. Use when you need the deployed pilot's control or desk status, a campaign's budget ledger, a campaign's trail or model calls, the coaching the agency currently holds, or to start a campaign on the pilot; also for following a live campaign event by event while coaching it. The MCP is a port into the agency — it triggers and observes, and never performs the agency's work itself."
---

# Alphaville Foundry — the agency's own interface

The agency is self-contained: its roles, its planning, its validation and its coaching all live
inside the Foundry packages. This MCP is a **port** into it. A tool either **triggers** the agency
(the agency's own runtime does everything after that) or **observes** what the agency stored. It
never plans a campaign, decides a stage, evaluates a rule, or writes a learning — a copy of any of
those here would be a second agency that could disagree with the first.

## Run it

The server speaks MCP over stdio. Any MCP client can drive it; this repository also ships a client:

```bash
# what the client can be pointed at, and what is currently reachable
python -m agency.client list

# one tool call; arguments are a JSON object
FOUNDRY_MCP_CONTROL_URL=http://127.0.0.1:53421 \
  python -m agency.client call foundry_control_status

# follow a live campaign as the agency writes its trail
python -m agency.client watch <campaign_id>
```

From Python, or from a test:

```python
from agency.client import McpClient

with McpClient(environment={"FOUNDRY_MCP_CONTROL_URL": "http://127.0.0.1:53421"}) as client:
    print(client.call("foundry_control_status")["ready"])
```

Point the server at the pilot with `FOUNDRY_MCP_CONTROL_URL` and `FOUNDRY_MCP_DESK_URL` (the same
values the live suite uses, `FOUNDRY_LIVE_CONTROL` / `FOUNDRY_LIVE_DESK`, are accepted). The
services' ports are private, so forward them first:

```bash
northflank forward service --projectId alphaville-foundry --serviceId control --skipHostnames --quiet
northflank forward service --projectId alphaville-foundry --serviceId desk --skipHostnames --quiet
```

## The tools

| Tool | Kind | What it answers |
| --- | --- | --- |
| `foundry_environment` | observe | The endpoints and trail this client is pointed at, and what is missing |
| `foundry_control_status` | observe | Control's liveness, readiness and status (including `store=ephemeral` or `durable`) |
| `foundry_desk_status` | observe | Desk's liveness, readiness and observed dimensions |
| `foundry_ledger` | observe | One scope's committed, reserved, and whether the total is complete |
| `foundry_campaign_run` | **trigger** | Starts one campaign on the pilot, and reports the launch it dispatched |
| `foundry_events` | observe | The trail so far; pass `next` back as `after` to follow incrementally |
| `foundry_trail` | observe | A campaign's reviewable record: tasks, findings, usage, coaching in force |
| `foundry_model_calls` | observe | Every model call: the induction, the raw answer, the digests, the usage |
| `foundry_coaching` | observe | The rules in force, the learnings log and its digest, and the roster |

Read-only tools need nothing configured beyond an endpoint or a trail directory. A tool that is
missing what it needs says which variable would set it, rather than guessing an endpoint and
reporting a different environment as the pilot.

## Operating rules

- **The agency does the work.** Never reach past this surface to edit a learning, a rule, a task or
  a ledger entry on the agency's behalf. Coaching is the coach role's responsibility, and it acts
  inside a campaign, where it can see the run, the findings and the evidence.
- **A trigger is not a campaign.** `foundry_campaign_run` dispatches through
  `FOUNDRY_MCP_DISPATCH_COMMAND`; with no command configured it answers `dispatched: false` and
  returns the launch document. That is the honest answer — read it rather than assuming a run began.
- **Report the inconvenient truth.** An ephemeral store, a desk that is not ready, an `unknown`
  charge: those are the findings worth having. Do not summarise them away when reporting to a human.
- **No credentials here.** The model key belongs to the campaign job. Never put one in a client
  environment, a tool argument, a launch document, or a message.

## Reading a trail

`foundry_trail` is the record to review a run with, and `findings` is the field that matters: every
failing rule, named with its reason. A refusal recorded only as an artefact digest is auditable but
not coachable, so when a campaign halts, read the findings before proposing anything.

`foundry_model_calls` is the other half: the induction each role received and the raw text it
answered with, including the calls that failed to parse. When a role disappoints, the text is the
evidence for what to change — in the role's starting prompt, in the rules, or in a learning.

## When something is wrong

| Symptom | Likely cause |
| --- | --- |
| `no control endpoint is configured` | `FOUNDRY_MCP_CONTROL_URL` unset |
| `the MCP server closed the connection` | The server died; run `python -m agency.server` by hand to see stderr |
| `no run record for '<id>'` | The trail lives where the campaign ran; point `FOUNDRY_TELEMETRY_ROOT` at it |
| `dispatched: false` | No `FOUNDRY_MCP_DISPATCH_COMMAND`; the launch document is in the answer |
| `a launch needs the campaign image` | Set `FOUNDRY_MCP_CAMPAIGN_IMAGE` to the pinned digest |
