# DSH shared agent instructions

For any Plane-related task, lazily load the canonical shared Plane skill by name:

`plane`

This applies to DSH DeepSeek sessions, including the TUI and web profiles, subagents, and CLI-backed harnesses. Follow the skill's CLI-first workspace resolution, project setup, workflow, attribution, and verification rules. Load `references/cli-reference.md` only when the requested operation needs detailed command or workflow guidance.

For model routing, read and follow `MODEL-ROLES.md`: deepseek-v4.1-flash orchestrates, gpt-5.6-luna performs worker tasks, and gpt-5.6-sol provides final authority and Sprint review/advice.

## Design rule: just works first, complexity is progressive and opt-in
Full text: [`rules/design-ladder.md`](rules/design-ladder.md) — read it before designing a config, a default, or an optional feature.

## Research taste: prefer the surreal, the found, and the meaningful
Full text: [`rules/research-taste.md`](rules/research-taste.md) — read it before choosing what to investigate.

