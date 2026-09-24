---
name: cmo
description: Fix the marketing substance of a page or site — identity, promise, message sequence, content density, emphasis, and CTA hierarchy. Use when a page "feels weird", buries the point, speaks to the wrong audience, repeats itself, or has flat/duplicated calls to action. Complements design skills (which fix how it looks); this fixes what it says and in what order.
---

# CMO

A design skill makes a page *look* made. This skill makes it *say* something. Run it before or alongside a visual pass — a beautiful page with a broken message is still a broken page.

The output is a **message architecture** plus rewritten copy, not a mood board.

---

## The seven faults

Almost every "this feels weird" page fails on one or more of these. Diagnose all seven explicitly before editing anything.

### 1. Identity — does the reader know what this is, in five seconds?

A tagline is not an identity. `"Hear with you."` tells a first-time reader nothing.

The hero must answer, above the fold, without scrolling:
- **What category is this?** (an app, a service, a fund, a report)
- **For whom?**
- **Who is behind it?**

A poetic line may *sit beside* the identity. It may never *replace* it.

**Test:** cover everything except the first screen. Show it to someone who has never heard of the product. If they cannot say what it is in one sentence, the identity fails.

### 2. Promise — is there one specific, falsifiable claim?

Not a feeling. Not a mission. One sentence stating what changes for the reader, specific enough that it could be wrong.

- ✗ "Reimagining regional storytelling"
- ✓ "It tells you what you're looking at, out loud, while you're still looking at it."

The promise appears **once**, in the hero, and is never restated in different words later. Restating a promise reads as insecurity.

### 3. Audience — who is actually reading this?

Name the **primary** audience in one noun phrase. Then name secondaries. Then check every section against the primary.

The most common failure: the *body* speaks to one audience while the *CTAs* speak to another. (A consumer narrative with an investor button.) Pick one primary; serve secondaries through a clearly-labelled sidedoor, never by alternating voice.

Where the real reader is a panel, buyer, or committee, the page is still allowed to be evocative — but every evocative passage must be **earning a specific decision**, not performing.

### 4. Sequence — is the argument in an order that survives a stranger?

The default working spine:

| # | Beat | Job |
|---|---|---|
| 1 | **Identity + promise** | Orient. One primary CTA. |
| 2 | **The felt problem** | Make them want it. Narrative allowed here, once. |
| 3 | **The answer** | Name the thing and what it does. |
| 4 | **How it works** | Mechanism. Never before beat 3. |
| 5 | **Why trust it** | Governance, provenance, credentials, standards. |
| 6 | **Why it's worth the money** | Evidence, numbers, cited. |
| 7 | **The ask** | One block, differentiated by audience. |

Violations to hunt for:
- **Flashback** — narrative/emotional setup placed *after* proof or features. It reads as filler because the reader already moved on.
- **Mechanism-first** — explaining how before establishing why anyone cares.
- **Defensive opening** — knocking down alternatives before stating what you are. Competitive framing belongs *inside* beat 2, compressed, never as a standalone early section.

### 5. Density — what is said more than once?

Build a **repetition ledger**: list every claim, and every place it appears.

Rules:
- A claim appears **once at full weight**. Later mentions must *escalate* (add specificity, evidence, or consequence) or be cut.
- A chip, a card, and a full section all making the same claim = cut two.
- If a section can be reduced to its best sentence, reduce it to its best sentence.
- Competitor/alternative lists: **three maximum**. Five is a wall, and a wall reads as anxiety.

Target: a substantive page is 5–8 sections. Ten sections nearly always contains two merges and one deletion.

### 6. Emphasis — is visual weight allocated to what matters?

Rank sections by strategic importance. Then rank them by visual weight (dark bands, saturated fills, large type, full-bleed). The two rankings should match.

- **Accent colours must encode meaning.** Five different accents across five sibling cards encodes nothing; it's decoration pretending to be information. Either the colour means something (a tier, a status, a source) or every sibling gets the same one.
- **Heavy bands are a scarce resource.** One or two per page. Three or more and none of them land.
- The differentiator — the thing no competitor has — should be in the top third of the page and carry real weight. It is usually buried around section 7.

### 7. CTAs — is there a hierarchy, and does each one fit a reader?

- **One primary CTA per page.** It appears in the hero and again in the closing block, with *identical* label wording.
- Secondary CTAs are visually quieter and fewer.
- **Label the action, not the object**: "Read the 2026 application" beats "Application".
- Repeating the same CTA pair verbatim at top and bottom with nothing gained in between is a smell — the closing block should carry a different *reason* even if the same action.
- If the page serves multiple audiences, the closing block routes them explicitly, by audience name, in one grid. Never by alternating buttons throughout the page.

---

## Method

**1 · Read the whole thing first.** Every section, in order. Do not edit while reading.

**2 · Write the diagnosis before touching code.** Emit this block:

```
CMO diagnosis — <page>

Identity:  <what a stranger learns in 5s — or "nothing">
Promise:   <the single claim — or "absent / diffuse">
Audience:  primary <X>; secondaries <Y, Z>; conflict at <sections>
Sequence:  <current beat order, with violations named>
Density:   <repeated claims, and where>
Emphasis:  <strategic rank vs visual rank mismatch>
CTAs:      <count, hierarchy, mismatch to audience>
```

**3 · Propose the new spine as a table** — old sections mapped to new, with `merge` / `cut` / `move` / `keep` marked, and a one-line reason for every cut. Cuts are the whole value of this skill; a restructure that deletes nothing has not diagnosed anything.

**4 · Rewrite copy under the project's own voice rules.** If the project has a `BRAND.md`, style guide, or tone doc, it outranks this skill on wording. This skill governs *architecture*; that file governs *diction*.

**5 · Honest copy.** Never invent a metric, a testimonial, a logo, or a customer count. If a stat-led block has no real numbers behind it, change the block, don't fabricate the numbers. Prefer a number that is *about this product* over an impressive industry number that is about the category — an orphaned market-size stat proves nothing and reads as padding.

**6 · Hand off to the visual pass.** State which structural decisions the design pass must honour: section count, which sections get heavy treatment, where the single primary CTA lives.

---

## Rules of thumb

- **Cut before you polish.** Restructuring 10 sections into 7 fixes more than rewriting all 10.
- **One idea per section.** If a section needs an "and", it's two sections or it's one section with a passenger.
- **Evocative language is a budget.** Spend it in beat 2 and the closing line. Everywhere else, be plain.
- **The best sentence in a cut section survives** — lift it into whatever absorbed it.
- **A page that argues with alternatives is weaker than a page that is simply specific about itself.**
