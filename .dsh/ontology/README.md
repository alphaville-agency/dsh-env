# Vendored ontology (derived, read-only)

The naming/vocabulary registry this workspace resolves names against lives at
`/root/.dsh/ontology/` in the image. It is a **derived, read-only copy** of the canonical
registry in the capability repository (`names/registry.json`, `names/validate.py`); the
canonical copy is the only one that is authored.

- `registry.json` — the vocabulary (levels, namespaces, claims). Copied verbatim.
- `validate.py` — the validator. It resolves `registry.json` next to itself
  (`pathlib.Path(__file__).with_name("registry.json")`), so the two files must stay together.
- `PIN.json` — the source and the sha256 of each vendored file.

**Do not edit these files in place.** An edit here is drift: it diverges from the pin, and
`agent/ontology/check-drift.sh` (run by `agent/sync.sh`) fails and names the file and both hashes.
To change the vocabulary, edit the canonical copy and re-run `agent/sync.sh`, then commit the
result. A change reaches the container only through a rebuild and a deploy.

Usage in the container (no arguments, no network, no extra dependency):

    python3 /root/.dsh/ontology/validate.py list
    python3 /root/.dsh/ontology/validate.py check <logical_id>
    python3 /root/.dsh/ontology/validate.py render <logical_id>

**`--claims` needs the capability repository, and this environment does not have it.** The validator
resolves its repository root from its own location (`REPO_ROOT = REGISTRY.parent.parent`), so beside
the canonical copy it checks `../../evidence/…` in the capability repo — but here that resolves to
`/root/.dsh/evidence/`, which does not exist. `--claims` therefore reports three `provisioning`
evidence files as missing. That is a property of where this copy lives, not of the registry: the same
file run from the capability repo's `names/` directory reports
`claims ok: 3 logical ids, 5 provider names`. The location-independent subcommands are `list`,
`check <logical_id>` and `render <logical_id>`; use `--claims` only beside the canonical copy.