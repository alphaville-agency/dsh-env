# LLM routing through AI Gateway

Two AI Gateway instances sit in front of the same upstream provider so that spend and usage are
attributable per consumer. Design and names below are verified against the official docs; the
provisioning calls have **not** been executed — see [Why this is not provisioned yet](#why-this-is-not-provisioned-yet).

## The upstream is a custom provider

cheapinference is not a natively supported provider, so it is registered as a **Custom Provider**.
From the [Custom Providers guide](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/):

| field | value |
|---|---|
| `name` | `cheapinference` |
| `slug` | `cheapinference` — requests reference it as **`custom-cheapinference`** |
| `base_url` | `https://api.cheaperinference.com` — **root domain only**; `/v1/chat/completions` is part of the request path, not of `base_url` |
| `enable` | `true` — it defaults to `false` |

```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai-gateway/custom-providers" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "cheapinference",
    "slug": "cheapinference",
    "base_url": "https://api.cheaperinference.com",
    "enable": true
  }'
```

`name`, `slug` and `base_url` are required; `base_url` must start with `https://`, and the slug must
be unique in the account (a duplicate returns `409`, code 1003).

## The two gateways

**Both exist now, and both names are derived from the registry rather than chosen here.** The gateway
id is the `cloudflare_ai_gateway` serialisation of the logical id — run
`python3 ontology/validate.py render <logical_id>` in the capability repository before adding a third.

| logical id | gateway id (used in URLs) | consumer | created |
|---|---|---|---|
| `dev.tooling.dsh.gateway` | `dev-tooling-dsh-gateway` | the dsh developer environment (this repository) | 2026-09-22 |
| `dev.agency.inference.gateway` | `dev-agency-inference-gateway` | the agency | 2026-09-22 |

An earlier name, `dev-agency-gateway`, was created and then deleted: it was three levels, not four,
so it had no legal logical id. It is recorded here because a name that quietly changed is worse than
one that is explained.

Both use the same custom provider and therefore the same models. They are separate gateways so that
billing attribution, analytics, logging, rate limiting and caching are per consumer.

Created with the API method documented at
<https://developers.cloudflare.com/api/resources/ai_gateway/methods/create/>. The working request
body was determined by trying it: `cache_invalidate_on_update` is **required**, and omitting it fails
with `7001 Required body cache_invalidate_on_update`. The body used was:

```json
{
  "id": "<the gateway id from the table above>",
  "name": "<the logical id>",
  "collect_logs": true,
  "cache_ttl": 0,
  "cache_invalidate_on_update": true,
  "rate_limiting_interval": 0,
  "rate_limiting_limit": 0,
  "authentication": false
}
```

Note that the platform does not return or persist `name`: a read-back shows it as null, and the **id
is the identity**. That is another reason the id must come from the registry rather than be typed.

## Calling each gateway

The account id is `ed5246df839f2f05c5ac88597e0f2177`.

```
Gateway URL:  https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/custom-{slug}/{provider-path}
Upstream URL: {base_url}/{provider-path}
```

**Unified API** — provider-independent; only the model id changes:

```sh
curl "https://gateway.ai.cloudflare.com/v1/ed5246df839f2f05c5ac88597e0f2177/dev-tooling-dsh-gateway/compat/chat/completions" \
  -H "Authorization: Bearer $CHEAPINFERENCE_API_KEY" \
  -H "cf-aig-authorization: Bearer $CF_AIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "custom-cheapinference/<model-name>",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

**Provider-specific endpoint** — full control of the upstream path, same auth headers:

```sh
curl "https://gateway.ai.cloudflare.com/v1/ed5246df839f2f05c5ac88597e0f2177/dev-agency-gateway/custom-cheapinference/v1/chat/completions" \
  -H "Authorization: Bearer $CHEAPINFERENCE_API_KEY" \
  -H "cf-aig-authorization: Bearer $CF_AIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "<model-name>", "messages": [{"role": "user", "content": "Hello!"}]}'
```

For an OpenAI-compatible SDK, set its base URL to
`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/custom-cheapinference/v1` and pass
`cf-aig-authorization` as a default header; the SDK appends `/chat/completions`.

**The Unified API is marked "Deprecated for single-model calls"** in the official docs, which now
point single-model traffic at the REST API,
`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions`. The
`/compat/chat/completions` endpoint still works, is what the Custom Providers guide documents, and
remains required for dynamic routing. Use it, but know it is on a deprecation path.

**BYOK is the preferred way to hold the provider key** (store it in the gateway rather than sending
it on every request). Not implemented here.

## Billing: what this does and does not do

- AI Gateway sits **in front of** the provider. It gives attribution, analytics, cost visibility,
  caching, rate limits and fallback. It does **not** replace the upstream provider's billing.
- Both gateways currently send requests under the **same provider key**, so the money still goes to
  the cheapinference account that owns it. Two gateways give two views of one bill — not two bills.
- "Unified billing" becomes literal only when the models are served by a provider Cloudflare bills
  directly (Workers AI, a natively-billed provider, or prepaid AI Gateway credits).
- **Open decision for the operator:** (a) accept the shared upstream account, (b) issue a second
  cheapinference account and key for the agency, or (c) move to a provider Cloudflare bills. Nothing
  in this repository assumes an answer.

## Credentials

Never committed, never in the image, never printed. `CHEAPINFERENCE_API_KEY` and `CF_AIG_TOKEN` are
runtime secrets: read from the environment locally, or from Worker secrets when deployed.

## Why this is not provisioned yet

The account-side calls could not be made from the session that wrote this file, and the failure is a
missing credential rather than a permissions gap. Verbatim:

```
$ npx wrangler whoami
 ⛅️ wrangler 4.136.1
────────────────────
Getting User settings...

✘ [ERROR] Not logged in. Your auth token has expired and could not be refreshed, and the
  environment is non-interactive. Run `wrangler login` in an interactive terminal or set a
  CLOUDFLARE_API_TOKEN.
```

No `CF_*`, `CLOUDFLARE_*` or `cfat_*` variable exists in the process environment either. To finish
the plumbing: run `wrangler login` (or export a token with `AI Gateway - Edit`), then execute the
custom-provider call above and create the two gateways.