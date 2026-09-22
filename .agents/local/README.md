# Skills the repository carries, and why

Everything else in the catalog is installed from its upstream source by `npx skills` and named in
[`../skills.json`](../skills.json). These three are different: they are installed the same way —
`skills add ./.agents/local/<name> -g -y`, so there is still exactly one install mechanism — but the
files come from this repository, because there is no upstream to fetch them from.

| skill | why it is here rather than upstream |
|---|---|
| `plane` | Ours. Authored for the Alphaville workspace; it exists in no registry. |
| `alphaville` | Ours. It is a port into our own agency's MCP surface. |
| `cmo` | **Provenance unconfirmed.** A skill of this name exists upstream, but `pollow/c-suite-skills@cmo` is a different skill that happens to share the name (verified by content, not by name). Pinning a guess would be worse than carrying the copy, so it is carried. |

`cmo` is the honest exception, not a precedent: if its real upstream is identified, delete the
directory and add a `cloudflare/...`-style entry to `skills.json` instead.

## Why this is a directory and not an image `COPY`

The image carries no agent content at all. These files reach the container through the repository
clone on the durable state mount, so they are editable in place inside the container and survive a
wake. Baking them in would reintroduce the rebuild-and-redeploy cycle this layout exists to remove —
see [the README](../../README.md).
