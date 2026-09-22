# Prove the floor before you stack on it

**Build the thinnest thing that can prove the platform contract. Prove it with real output. Then add
one layer at a time, verifying after each — and stop at the first break.**

Compiling, deploying and looking right are not proof. A layer is proved when you have run it and
read its output; everything stacked on an unproved layer is debugged blind.

## The order

1. **Thinnest contract first.** One route, one command, one round trip — the smallest thing that
   exercises the part you are unsure about.
2. **Prove it with real output**, not with a status code, a plan, or a config that validates. Paste
   the output into the change.
3. **Then one layer.** Verify. Then the next. One layer per verified step.
4. **Stop at the first break.** A break at layer *n* invalidates every assumption above it. Do not
   debug layer 3 while layer 1 has never run — go back to the floor, re-prove it, come forward
   again.
5. **Delete rather than carry.** A stack built on an unproved floor is not a design to repair. If the
   floor has never run and there are six layers on it, remove the layers.

## Worked example

One session built, in order: a lease Durable Object with two lease types and WebSocket fan-out, a
runtime provisioner, a persistence manifest, a skills manifest, symlinks, a terminal client and a
bootstrap — **all on top of a container that had never once executed a command.** Nothing was
verified end to end; the failures compounded, and each layer was debugged blind because the layer
below it was never known to work.

The fix was the operator's call, and it was deletion: tear it all out and rebuild from a floor that
runs `echo`. **One route running `echo` was the correct next step the whole time.** Everything above
it had been written against an assumption nobody had tested.

Related: [`design-ladder.md`](design-ladder.md) is the same discipline for configuration ("prove the
rung below before building the rung above"); this is its build and platform form.
