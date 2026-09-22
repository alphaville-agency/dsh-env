## Research taste: prefer the surreal, the found, and the meaningful


Applies to exploratory and research work in every session.

**When two lines of inquiry are equally rigorous, pursue the one whose result
would be more unexpected, more consequential, or more meaningfully strange.**
Discovery value is a first-class selection criterion, ranked alongside
correctness — not below it and not instead of it.

- **Favour the surreal and the found.** Prefer the mechanism, analogy, or
  measurement that nobody would have predicted, over the one that merely
  confirms what was already assumed. A surprising negative beats a predictable
  positive.
- **Rank findings by surprise x consequence.** Keep a running register (e.g.
  `docs/wow.md`) scoring each result on Surprise x Impact x Testability, and let
  the top of that register drive what gets built next.
- **Meaningful over merely novel.** Novelty alone is noise. The target is a
  finding that changes how the system is understood or built.
- **Rigor still gates the verdict, never the ambition.** The selection of WHAT
  to test is chosen for wonder; the ACCEPTANCE of a result still requires
  controls, nulls and ceilings (signal / null / ceiling). Aim high, then
  measure honestly — and report refutations plainly rather than rescuing them.
- **Write down the strange thing.** Whenever a result is odd, overclaimed, or
  unexplained, record it verbatim before moving on; the strange residue is
  usually where the next real idea is hiding.

## Survey the field: GitHub topics, ranked by stars

Before designing in a domain, **survey what already exists in it** — not only what
the vendor documents, but what practitioners actually built and starred.

- **Search GitHub by topic, sorted by stars.** Topics are the discovery handle:
  `automation`, `workflow`, `workflow-engine`, `agent`, `agent-harness`,
  `orchestration`, `llmops`, `data-pipeline`, `etl`, `scheduler`, `scraper`,
  `mcp`, `a2a`, `rag`, `eval`, `durable-execution`, `distributed-systems`.
  A topic's most-starred repos are the field's consensus on names and shape, and
  the *count* is a signal in itself: a domain with a dozen 10k-star repos has
  settled vocabulary worth adopting rather than reinventing.
- **Discover tags as you go.** Read the topics on repos you find and follow them;
  a repo's own topic set names adjacent concepts you would not have guessed to
  search for. Add the ones that turn out to recur — the vocabulary is the finding.
- **Read the top 5-10 by stars for shape, not code.** What are the concepts, the
  layer names, the file layout, the config format? That is the contemporary
  architecture, and the cheapest way to avoid inventing a worse version of it.
- **Read the issues and the ones that died.** The most-starred repo that is
  archived, or the most-commented open issue, tells you the failure mode the
  marketing page does not. Someone has already hit what you are about to hit.
- **Record what you found**, with stars and links, alongside the design. A survey
  that leaves no trace gets repeated next session, which is exactly the cost this
  rule exists to remove.

This pairs with [`prior-art.md`](prior-art.md): this is *what already exists in
the field*; that one is *how the platform already solves it*. Do both before
building either.

