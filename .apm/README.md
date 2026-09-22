# The primitives this repository authors

Everything under `.apm/` is the local source content of the `dsh-env` package declared in
[`../apm.yml`](../apm.yml). APM deploys it alongside the remote dependencies, so there is exactly one
install mechanism for the whole catalog and exactly one place to edit a primitive we own.

```
.apm/
+-- local/            # skills that have no upstream to be fetched from
|   +-- plane/
|   +-- alphaville/
|   +-- cmo/
+-- instructions/     # always-on rules, also read by the harness from .dsh/rules/
    +-- design-ladder.md
    +-- research-taste.md
```

## Why three skills live here

| skill | why it is here rather than upstream |
|---|---|
| `plane` | Ours. Authored for the Alphaville workspace; it exists in no registry. |
| `alphaville` | Ours. It is a port into our own agency's MCP surface. |
| `cmo` | **Provenance unconfirmed.** A skill of this name exists upstream, but `pollow/c-suite-skills@cmo` is a different skill that happens to share the name (verified by content, not by name). Pinning a guess would be worse than carrying the copy, so it is carried. |

`cmo` is the honest exception, not a precedent: if its real upstream is identified, delete the
directory and replace the `./.apm/local/cmo` entry in `apm.yml` with the upstream source.

## Why these are local source and not an image `COPY`

The disk is ephemeral. The durable part of this environment is the repository clone on the state
mount, and the clone's `.agents/` is symlinked into the harness's discovery path — so a primitive
edited here, in place, survives a wake. Baking a skill into the image instead would reintroduce the
rebuild-and-redeploy cycle the current layout exists to remove. See
[the README](../README.md), "Cutover".

## Why `instructions/` duplicates `.dsh/rules/`

`.dsh/rules/` is where the running harness reads these rules, and it stays the readable,
hand-editable source the `AGENTS.md` router links to. `.apm/instructions/` is the same content as
installable primitives, because that is the only shape APM deploys for the instruction primitive. A
rule change is therefore two edits, and `tools/check-drift.sh` fails if they diverge — the check is
named in that script and in the README, so the duplication cannot drift silently.

## `local/` is not a primitive type

`local/` is a plain directory of skill-shaped folders addressed by path in `apm.yml`; APM accepts any
directory that carries `SKILL.md` at its root as a skill. `instructions/` is the one APM-reserved
source subdirectory used here.