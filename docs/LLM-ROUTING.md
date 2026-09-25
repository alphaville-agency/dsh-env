# LLM routing

Every environment — this machine, the remote dsh container, and the agency — reaches models through
**one provider**: the router at `https://aig.drksci.com/<environment>/v1`.

| environment | URL | gateway it reaches |
|---|---|---|
| this machine | `https://aig.drksci.com/operator/v1` | `operator-inference-gateway` |
| remote dsh | `https://aig.drksci.com/dsh/v1` | `dsh-inference-gateway` |
| agency | `https://aig.drksci.com/alphaville/v1` | `alphaville-inference-gateway` |

The settings file holds a URL and a credential reference, and nothing else. It does not name an
account, a provider key, a model mapping or a time window, because all of that is decided behind the
URL. The built and deployed configuration lives in the private repository
[`drksci/cf-ai-gateway`](https://github.com/drksci/cf-ai-gateway); this file records what this
repository depends on, not how to build it.

## The rule

Two accounts, and the decision between them is **"which one is already paid for at this instant"**:

| instant | account | billing | models |
|---|---|---|---|
| inside a reserved block | CheapestInference | flat monthly, uncapped | the `core` pool: `deepseek-v4.1-flash`, `mimo-v2.6-flash` |
| outside every block | CheaperInference | per token, from the wallet | 72 models, including the whole ladder |

The hours are not a policy written down here: they are the account's own reserved blocks, read from
the vendor's management API (`GET /api/billing/status` → `hours: [8…15]` UTC, the `europe` block,
which is 18:00–02:00 Brisbane) and cached by the router. Adding, moving or cancelling a block changes
the routing without an edit anywhere.

When the client asks for a model the reserved pool does not carry, the router answers with the
**closest match in the pool** rather than silently moving the request to the wallet. `gpt-5.6-luna` is
the one model this affects today: inside the reserved block it is served as `mimo-v2.6-flash`.

## What this repository holds

| name | where it lives | what it is |
|---|---|---|
| `CF_AI_GATEWAY_TOKEN` | Worker secret in the container; credential-store ref on a laptop | what a caller presents to the router |
| the provider keys | stored in the AI Gateways (BYOK) | never in this repository and never in the container |

The profile declares `apiKeyEnv: CF_AI_GATEWAY_TOKEN` and `baseURL: https://aig.drksci.com/dsh/v1`,
and `src/names.ts` exports that variable name so the Worker injects exactly it
(`MODEL_KEY_ENV`). A request carries **no provider authorization header**: AI Gateway substitutes the
stored key only when that header is absent, and a placeholder would be forwarded and rejected.

## Two measured facts to know before touching this

- **`gpt-5.6-sol` answers HTTP 402 `insufficient_balance`.** The wallet is unfunded, so the final
  authority and Sprint reviewer roles cannot run at all. That is funding, not routing.
- **Nested AI Gateways do not work.** A custom provider whose `base_url` points at another
  `gateway.ai.cloudflare.com` endpoint fails with an immediate 522 (measured repeatedly, while direct
  calls to the same gateway succeed). Per-account visibility therefore comes from each environment
  gateway's own analytics, which already break down by provider and model, rather than from an
  upstream gateway hop. The two account gateways exist and answer direct calls; nothing routes
  through them.

## Deploying the container's copy

The container reads this configuration from `dsh-profile/settings.yaml`, baked into the image, and the
model credential from the `CF_AI_GATEWAY_TOKEN` Worker secret. Both land in one deploy: the secret is
set from the repository's own `CF_AI_GATEWAY_TOKEN` secret by a step in `.github/workflows/deploy.yml`,
immediately before the deploy that needs it, so the config and the credential cannot drift apart.

That workflow is the only thing that can reach the account, and it does not run from a laptop.
