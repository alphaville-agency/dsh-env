## Design rule: just works first, complexity is progressive and opt-in


Applies to all design, architecture, and build work in every session:

**Default to the configuration requiring the fewest moving parts, fewest credentials, and zero decisions. Everything beyond it is a named, reversible, one-line opt-in, arranged as a ladder where each rung strictly adds capability. Complexity is deferred behind a switch, never banned.**

- **Sunday-morning test:** a competent operator reaches the working default from cold in one sitting, with no undocumented step and no decision they can get wrong.
- **Count the rungs:** if usefulness requires N components, find the version that requires 1. Prefer deleting a component over configuring it.
- **One source of truth:** two stores that must agree is a bug. Derived views are generated, never hand-maintained, never authoritative.
- **Off means absent, not broken:** a disabled feature is invisible — no routes, no tables, no cost, no errors, no noise. Never fail-noisy on the default path.
- **Additive ladder:** rung N+1 never invalidates rung N's data or forces rework; going back down is flipping one value.
- **Prove the rung below before building the rung above.**
- **A complicated experience may exist as an opt-in, never as the default or a prerequisite.**
- **Autonomy is on the ladder too:** authority is earned rung by rung and recorded, never assumed.

When presenting a plan, state the default and name each opt-in rung explicitly. When a plan and this rule disagree, either change the plan or say plainly why the rule does not apply.

Also: **signal never reaches codegen unfiltered** (untrusted input is read by a triage model, and the code writer sees only a written spec), **a transition not recorded didn't happen** (append-only ledger is the system of record), and **a model may advise but a human is the approver of record**.
