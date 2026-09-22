# Vendored ontology (derived, read-only)

The naming/vocabulary registry this workspace resolves names against lives at
`/root/.dsh/ontology/` in the image. It is a **derived, read-only copy** of the canonical
registry in **`alphaville-agency/agency`**, under `names/` (`names/registry.json`,
`names/validate.py`); the canonical copy is the only one that is authored.

`alphaville-agency/agency` is the location, verified with `gh api
repos/alphaville-agency/agency/contents/names` on 2026-09-22: it is the one repository in the
organisation that carries a `names/` directory. Earlier revisions of this README, of `PIN.json` and
of the deleted `tools/sync.sh` named an `alphaville-agency/capability` repository instead, which
**does not exist** (`gh api repos/alphaville-agency/capability` → 404, and it is absent from
`gh repo list alphaville-agency`). A declared source that 404s is worse than an unrecorded one: it
reads as a fact, and anything built on it fails later and elsewhere.

**This copy is not current, and that is recorded rather than hidden.** `PIN.json` carries a
`known_stale` block. The canonical `names/` has moved on — upstream is now schema
`alphaville.resource-names.v1` while this copy is `v2` — and nothing in this repository re-pins it
any more, because the hand-rolled re-pinner was the deleted `tools/sync.sh`. The pin still proves the
copy has not been hand-edited; it does not claim the copy is up to date. Refresh by hand from
`alphaville-agency/agency` and clear the block; see `PIN.json`.

- `registry.json` — the vocabulary (levels, namespaces, claims). Copied verbatim.
- `validate.py` — the validator. It resolves `registry.json` next to itself
  (`pathlib.Path(__file__).with_name("registry.json")`), so the two files must stay together.
- `PIN.json` — the source, the sha256 of each vendored file, and the staleness record.

**Do not edit these files in place.** An edit here is drift: it diverges from the pin, and
`tools/check-drift.sh` fails and names the file and both hashes. To change the vocabulary, edit the
canonical copy under `names/` in `alphaville-agency/agency`, re-copy the two files, update `PIN.json`
and commit. A change reaches the container only through a rebuild and a deploy.

Usage in the container (no arguments, no network, no extra dependency):

    python3 /root/.dsh/ontology/validate.py list
    python3 /root/.dsh/ontology/validate.py check <logical_id>
    python3 /root/.dsh/ontology/validate.py render <logical_id>

**`--claims` needs the canonical repository, and this environment does not have it.** The validator
resolves its repository root from its own location (`REPO_ROOT = REGISTRY.parent.parent`), so beside
the canonical copy it checks `../../evidence/…` in that repository — but here that resolves to
`/root/.dsh/evidence/`, which does not exist. `--claims` therefore reports three `provisioning`
evidence files as missing. That is a property of where this copy lives, not of the registry: the same
file run from the canonical `names/` directory reports
`claims ok: 3 logical ids, 5 provider names`. The location-independent subcommands are `list`,
`check <logical_id>` and `render <logical_id>`; use `--claims` only beside the canonical copy.