# Persistent DSH model-role policy

Effective immediately for DSH sessions and delegated work. Every entry below is a model on the **one**
provider, `cf-ai-gateway` — the inference router at `aig.drksci.com`, whose path segment names the
environment (`/operator`, `/dsh`, `/alphaville`). Nothing here names an account, because which account
answers is decided per request and is not the caller's business.

- **Orchestrator:** `cf-ai-gateway/deepseek-v4.1-flash`
  - Owns decomposition, routing, coordination, and acceptance criteria.
  - The only ladder model served by BOTH accounts, so it is available in every window and is the
    reason the ladder keeps its shape when the reserved block is active.
- **Worker:** `cf-ai-gateway/gpt-5.6-luna`
  - Performs implementation, research, and bounded execution delegated by the orchestrator.
  - **During the reserved block it is answered as `mimo-v2.6-flash`.** The unlimited subscription's
    pool is `deepseek-v4.1-flash` and `mimo-v2.6-flash`; it does not carry `gpt-5.6-luna`, so the
    router substitutes the closest match in the pool rather than moving the work to the wallet. This
    is the one substitution in the policy, it is deliberate, it is logged on every request it applies
    to, and it is recorded in `docs/LLM-ROUTING.md`.
- **Final authority:** `cf-ai-gateway/gpt-5.6-sol`
  - Performs final synthesis, release judgment, and completion sign-off.
  - Wallet only. **Measured 2026-09-25: it answers HTTP 402 `insufficient_balance`** — the wallet
    holds no funds, so this role cannot currently be exercised at all. That is a funding state, not a
    routing failure, and it must be reported as such rather than worked around silently.
- **Sprint reviewer/advisor:** `cf-ai-gateway/gpt-5.6-sol`
  - Reviews sprint plans, checks evidence and regressions, and advises the orchestrator before final
    sign-off. Same 402 while the wallet is unfunded.

The word “Sprint” is a role label, not a separate model identifier; no Sprint model is advertised by
the configured provider. Do not substitute another model silently. If a role is unavailable, report
the routing failure rather than silently changing the ladder — the one substitution above is the sole
exception, and it is the router's, not an agent's.

The orchestrator remains responsible for keeping work efficient and for requiring verification before
completion. Workers should return concrete evidence, changed paths, and test results. The final
authority should not claim completion without that evidence.
