# Persistent DSH model-role policy

Effective immediately for DSH sessions and delegated work:

- **Orchestrator:** `cheapinference-com/deepseek-v4.1-flash`
  - Owns decomposition, routing, coordination, and acceptance criteria.
- **Worker:** `cheapinference-com/gpt-5.6-luna`
  - Performs implementation, research, and bounded execution delegated by the orchestrator.
- **Final authority:** `cheapinference-com/gpt-5.6-sol`
  - Performs final synthesis, release judgment, and completion sign-off.
- **Sprint reviewer/advisor:** `cheapinference-com/gpt-5.6-sol`
  - Reviews sprint plans, checks evidence and regressions, and advises the orchestrator before final sign-off.

The word “Sprint” is a role label, not a separate model identifier; no Sprint model is advertised by the configured provider. Do not substitute another model silently. If a role is unavailable, report the routing failure rather than silently changing the ladder.

The orchestrator remains responsible for keeping work efficient and for requiring verification before completion. Workers should return concrete evidence, changed paths, and test results. The final authority should not claim completion without that evidence.
