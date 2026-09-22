# What the workspace costs

A `lite` Cloudflare Container: 1/16 vCPU, 256 MiB memory, 2 GB disk. Figures below are from the
[Cloudflare Containers pricing page](https://developers.cloudflare.com/containers/platform/pricing/)
(last updated 2026-08-28), with the arithmetic shown so it can be checked.

Workers Paid is **$5/month**, and it includes:

| Resource | Included | Then |
|---|---|---|
| Memory | 25 GiB-hours | $0.0000025 per additional GiB-second |
| CPU | 375 vCPU-minutes | $0.000020 per additional vCPU-second |
| Disk | 200 GB-hours | $0.00000007 per additional GB-second |
| Network egress | 1 TB/month | $0.025/GB in North America and Europe |

Memory and disk are billed on the **provisioned** resources for the instance type. CPU is billed on
**active** usage only. Billing granularity is every 10 ms while the instance is running; charges
start when a request reaches the container (or it is started by hand) and **stop when it sleeps**.

## The allowance, expressed as awake hours

Because memory and disk are provisioned, all three allowances land on the same wall-clock figure for
a `lite` instance:

- memory: 25 GiB-h ÷ 0.25 GiB = **100 hours**
- disk: 200 GB-h ÷ 2 GB = **100 hours**
- CPU: 375 vCPU-min ÷ (1/16 vCPU) = 6000 minutes = **100 hours** — the worst case, at 100% saturation

So **a `lite` sandbox can be awake for about 100 hours per month inside the $5 plan**, which is
roughly 3.3 hours of awake container every day.

## After the allowance, per awake hour

- memory: 0.25 GiB × 3600 s × $0.0000025 = **$0.00225**
- disk: 2 GB × 3600 s × $0.00000007 = **$0.000504**
- CPU, at a realistic light interactive load of ~5% of the 1/16 vCPU share (an interactive shell is
  mostly idle, and this is an assumption with that basis):
  0.05 × 0.0625 vCPU × 3600 s × $0.000020 ≈ **$0.000225**
- total ≈ **$0.003 per awake hour** — about 0.3 cents

## What follows for design

- **Awake time is the only lever that matters.** Image size affects cold-start seconds only; it is
  not the cost driver.
- **Scale to zero is the cost control, and `sleepAfter` is the dial.** It is set to 5 minutes here.
- **No process inside the container may ever heartbeat, poll or ping to stay awake.** Any such loop
  turns "cost while I work" into "cost while I live". This is why `keepalive.sh` was deleted, and why
  the Worker's `/healthz` deliberately never touches the sandbox.
- **A `scratch` or statically-linked-binary image does not reduce this bill.** Memory and disk are
  billed on provisioned resources for the chosen instance type, so shrinking the image does not lower
  the rate. It must not be reintroduced on cost grounds.
- **The workspace's durable state lives in R2 via a binding mount**, which costs nothing while the
  container sleeps.