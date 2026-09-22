# A build claim is measured, not asserted

**Anything you write about a build — that it is smaller, reproducible, pinned, clean or cached — must
be something you verified. If you cannot verify it, say so in as many words.**

A build file is a set of claims, and its claims are read as facts. An unverified claim is worse than
no claim: it is trusted, it is repeated, and it hides the mechanism that is actually running.

## Deletion in a later layer reclaims nothing

Docker layers are additive. Removing bytes in a layer **after** the layer that created them shrinks
the runtime filesystem and reclaims **zero** of the image. The removal has to be in the **same `RUN`**
that creates the bytes.

Worked example: a cleanup `RUN rm -rf` added as the final layer reclaimed **0 bytes** of a **2.2 GB**
image. The correct shape:

```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends <packages> \
 && apt-get clean \
 && rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/*
```

Read the layer sizes rather than guessing which layer is holding the bytes: `docker history <image>`,
or `dive`.

## A reproducibility claim is true only if the mechanism runs

Worked example: a comment claimed the install was reproducible from a frozen lockfile. **The tool
that honours the lockfile was not on `PATH`**, so a fallback ran, the lockfile was **silently ignored
for the entire life of the build**, and the comment was false the whole time. Nobody had run it.

- If you claim a build is pinned or reproducible, **verify the command that does the pinning actually
  executes** — run it, or read the output that proves the lockfile was the input.
- If it cannot be verified, **say so in as many words**: "installs from the lockfile when `pnpm` is
  present; the fallback path is unverified here" is honest and useful. A comment asserting the
  opposite is a defect that survives every review, because it reads as diligence.

Related: [`prior-art.md`](prior-art.md) would have found `slim`, `dive` and `docker history` before
the `rm -rf`; [`attribute-the-measurement.md`](attribute-the-measurement.md) is the check that the
image you are measuring is the image being rejected.
