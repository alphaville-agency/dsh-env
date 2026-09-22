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

