# Attribute a measurement before you act on it

**Every number is about a resource. Before you change anything in its name, establish which resource
the number belongs to — and prove that is the resource you are about to change.**

Measurements, error messages and limits arrive without a reliable subject. Two resources can share a
name prefix, an account, a worker and a dashboard, and the one an error is about may be one you have
forgotten exists.

## When this fires

- An error quotes a size, a limit, a quota, a timeout or an identifier, and you are about to optimise
  against it.
- You are about to spend time making something smaller, faster or cheaper.
- The number is plausible and you never watched it come from the resource you are editing.

## Attribute it in one step

List the actual resources and match the identifier in the message against them — the one that is
there, not the name you remember:

```sh
# every resource of the kind the error is about, with the identifier the error quoted
wrangler containers list
docker image inspect <image> --format '{{.Id}} {{.Size}}'
```

If the identifier in the message is not on that list for the resource you are editing, **stop**. You
are about to optimise a stranger.

## Worked example

A container image was rejected repeatedly as **too large: needs 2189 MB / 2250 MB, limit 2000 MB**.
Hours went into cutting **~947 MB** — dependency trees moved into runtime state, apt caches purged,
tools dropped from the image. The error belonged to a **different, orphaned container application
that shared a name prefix** with the image under test. The number was real; it was about someone
else's resource. Nothing cut in those hours was ever measured against the limit that was failing.

**The failure has a name: optimising against a stale ghost.**

Related: [`prove-the-floor.md`](prove-the-floor.md) is how a ghost resource gets found in the first
place; [`build-claims.md`](build-claims.md) is what to do once the measurement is really yours.
