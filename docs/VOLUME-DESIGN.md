# The container is a VM with a volume, not an image with a personality

## The problem this replaces

Changing one sentence of a prompt currently costs a full container image build and a `wrangler deploy`:
`AGENTS.md`, `rules/`, the prompts and the tool configuration are all `COPY`ed into the image. Measured
today, that cycle is ~4 minutes, and it has a second cost that is worse than the wait — **a deploy
resets the Durable Object that holds the container, which kills any turn in flight.** One turn was lost
exactly that way, after designing a whole step, with nothing pushed.

So the image is doing two jobs, and only one of them needs to be an image:

| Job | Changes | Belongs in |
|---|---|---|
| The runtime: node, dsh, the profiles, the toolchain, the sandbox base | rarely, deliberately | **the image** |
| The personality: rules, prompts, skills, tool config, the working repos | constantly, by anyone | **a volume, or a repo pulled at start** |

## The design

**One volume, restored on start and snapshotted on stop.**

- The volume covers `/root/.dsh` (settings, profiles' patch layers, rules, skills) and `/workspace`
  (the working repositories).
- On container start: restore the volume from R2 if a snapshot exists.
- On stop: snapshot it back.
- The image then contains only the runtime. Nothing about how the agent thinks is baked into it.

**Configuration is a repo, not a layer.** The rules, prompts and skills live in git — they already do,
in this repository's `.dsh/`. The container pulls them at start. Changing a prompt is then `git push`,
and the next turn picks it up: **no image build, no deploy, no reset, no interrupted turn.**

**Repos are pulled once, not every boot.** Today `dsh-prime` re-clones each repository at depth 1 on
every start, because the disk is ephemeral. On a volume, they are already there; priming becomes
`git fetch` (or nothing), and the whole `[priming the workspace: fetching the repositories it works on]`
pass disappears from the boot path.

## What this deletes

Each of these exists only because the disk is transient and the image is the only durable thing:

- the `COPY .dsh/...` layers, and the build-time assertions that they landed;
- the R2 mount at `/mnt/state` for the session store, and the `link(2)`/FUSE workaround that made the
  store a plain directory with a copy-out;
- `captureUncommittedWork` on `onStop` — the safety net for work that should simply still be there;
- re-cloning every repo on every boot;
- the rule that "anything that must survive belongs in git, not here", which is only true because the
  filesystem is not durable. On a volume, durable local state is legitimate.

## Platform notes

- Cloudflare Containers have **no persistent volume primitive**; the disk is ephemeral by design and a
  stopped instance returns with a fresh image. The volume is therefore *implemented* as
  start-restore / stop-snapshot against R2, not as a mounted disk.
- The SDK already exposes the primitives: `createBackup`/`restoreBackup` (`DirectoryBackup`, restricted
  to `/workspace`, `/home`, `/tmp`, `/var/tmp`, `/app`) and `createArchive`/`restoreArchive`.
- The snapshot must NOT be a naive full-disk copy: the image itself is ~2.2 GB, and `lite`'s 2000 MB
  disk is exactly why the container would not start at all. The volume is `/root/.dsh` + `/workspace`
  only, and it should be sized and measured rather than assumed.
- `instance_type` is `basic` (1/4 vCPU, 1 GiB, 4000 MB) today. A volume plus a full toolchain is an
  argument for `standard-1` (1/2 vCPU, 4 GiB) — decide it on a measurement of the volume's size and the
  boot time, not on the price list.
- Snapshot on stop is not a guarantee: `onStop` can be missed. The volume therefore needs the same
  discipline the repo already learned — a snapshot on a schedule, and a push for anything that must not
  be lost.

## Order of work

1. Size the volume first: measure `/root/.dsh` + `/workspace` on a primed container. Everything else
   depends on whether that fits, and the answer decides the instance type.
2. Restore-on-start and snapshot-on-stop for that volume, verified across a real cold start.
3. Move the agent config out of the image and into a start-time pull from git.
4. Only then delete the mechanisms above — one at a time, each after the replacement is proven, because
   the failure mode of deleting early is exactly the silent one this repository keeps re-learning.
