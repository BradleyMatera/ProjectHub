# Cloudflare Neuron Accounting Correction — Final Report

**Date:** 2026-08-23
**Task:** Isolated Cloudflare model / neuron accounting correctness
**Branch:** `develop`

## Finding

**WAS SCOUT ACCOUNTING WRONG:** **YES**

Scout's provider adapter and free-tier data associated the published neuron rates `4119 / 34868` with `@cf/meta/llama-3.1-8b-instruct-fast`. Cloudflare's official Workers AI pricing page does **not** publish those rates for that exact identifier; it publishes them for `@cf/meta/llama-3.1-8b-instruct-fp8-fast`. Scout was therefore presenting unverified pricing as verified.

## Git state

- **DEVELOP BEFORE:** `57927afef24dbe6a3564f0f1db5686da432c6a66`
- **DEVELOP AFTER:** `26b6fa0` (this commit)
- **MASTER SHA:** `4a1eee70821ed83f50be1fe2ff6286abfaa4a15c`
- **PROJECTHUB-DEV SHA:** `ef125fe217b3338795d027e4fd468451c646e157`
- **PRODUCTION CHANGED:** NO

## Official Cloudflare evidence

- **`-fast` exists:** YES — active Cloudflare-hosted model in the catalog.
- **`-fp8` exists:** YES — active Cloudflare-hosted model in the catalog.
- **`-fp8-fast` exists as documented pricing identifier:** YES — listed in the pricing table, but **not** in the model catalog.
- **`-fast` exact pricing published:** NO — the pricing page does not list `@cf/meta/llama-3.1-8b-instruct-fast`.
- **`-fp8` exact pricing:** `13778 neurons / M input tokens`, `26128 neurons / M output tokens`.
- **`-fp8-fast` exact pricing:** `4119 neurons / M input tokens`, `34868 neurons / M output tokens`.
- **Cloudflare explicitly says `-fast` == `-fp8-fast` billing alias:** NO.
- **Official source URLs:**
  - https://developers.cloudflare.com/workers-ai/platform/pricing/
  - https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fast/
  - https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/
  - https://developers.cloudflare.com/workers-ai/models/

## Root cause

`MODEL_NEURON_PRICING` in `lib/cloudflare-provider.js` contained an entry for `@cf/meta/llama-3.1-8b-instruct-fast` with the rates `4119 / 34868`. Those rates belong to `@cf/meta/llama-3.1-8b-instruct-fp8-fast`. The same incorrect association was copied into `data/free-tier-limits.json` and the widget's hardcoded `CLOUDFLARE_INPUT_NEURONS_PER_MILLION` / `CLOUDFLARE_OUTPUT_NEURONS_PER_MILLION` constants in `logic.js` / `ProjectHub.js`. The `free-tier-limits.json` also carried derived `shadowRates` that were computed from the wrong neuron rates.

## Code changes

**Files:**
- `lib/cloudflare-provider.js`
- `data/free-tier-limits.json`
- `logic.js`
- `ProjectHub.js` (rebuilt)
- `test/cloudflare-provider.test.js`
- `test/public-telemetry.test.js`

**Functions:**
- `MODEL_NEURON_PRICING` — removed the bad `-fast` entry; added exact published entries for `-fp8-fast` and `-fp8`.
- `neuronPricing` — unchanged exact-key lookup; now returns `null` for `-fast`.
- `estimateNeurons` — returns `null` when the exact model has no published rate.
- `estimateDailyCapacity` — returns `null` when the exact model has no published rate.
- `estimateCloudflareNeurons` — now model-aware; returns `null` for unknown models.
- `estimatedCloudflareMeteredUsd` — null-safe.
- `summarizeGenerationCalls` — only estimates when the exact model has published pricing.
- `cloudflareDayFromCosts` — returns `null` neurons/pct/remaining when exact pricing is unknown.
- `refreshScoutRuntimeDashboard` / `buildScoutTelemetryHtml` — display `unknown` / `unverified` instead of `0` when pricing is unverified.

## Exact pricing behavior after fix

- `neuronPricing('-fast')` → `null`
- `neuronPricing('-fp8')` → `{ input: 13778, output: 26128 }`
- `neuronPricing('-fp8-fast')` → `{ input: 4119, output: 34868 }`
- `estimateNeurons('-fast', …)` → `null`
- `estimateDailyCapacity('-fast', …)` → `null`

## Provider usage

- **`usage.neurons` documented:** The model pages document a `usage` object for output, but the docs do not explicitly guarantee a `neurons` field on every response.
- **`usage.neurons` observed in live response:** NOT TESTED (no live request was made to preserve free allocation).
- **`actualNeurons` behavior:** When the provider response includes `result.usage.neurons`, the adapter preserves it as `actualNeurons`.
- **`estimatedNeurons` behavior:** When exact published pricing exists, the adapter computes `estimatedNeurons`; when pricing is unknown, `estimatedNeurons` remains `null`.

## Downstream accounting

- **DAILY NEURON DISPLAY:** `unknown` when the exact model's rates are not published; otherwise the computed estimate.
- **CAPACITY DISPLAY:** `unverified` when pricing is unknown.
- **SHADOW COST:** The `free-tier-limits.json` no longer publishes fake neuron rates or derived shadow rates for the `-fast` model; cost-ledger shadow cost for Cloudflare events will be `0` until Cloudflare publishes exact rates.
- **PUBLIC TELEMETRY:** The widget now shows `unknown` / `unverified` instead of a fabricated `0` or the old wrong estimate.

## Tests

- **cloudflare-provider:** 26/26 passed (`node --test test/cloudflare-provider.test.js`)
- **full npm test:** 934/934 passed
- **build:** PASS (`npm run build`)
- **syntax:** PASS (`node --check`)
- **git diff:** PASS (`git diff --check`)

## Documentation

- **ProjectHub:** `data/free-tier-limits.json` corrected; `docs/cloudflare-neuron-accounting-report.md` added.
- **Scout-product-page:** `learn.html` contains the same bad mapping in the "Provider usage math" section. A direct GitHub update failed with a `401 Unauthorized` response, so the fix was not pushed to that repo in this session. The section must be updated to attribute the `4119 / 34868` rates to the exact `-fp8-fast` identifier and mark the current `-fast` model's rates as unverified.
- **Learn:** see above.
- **Docs:** no other docs in ProjectHub publish the bad mapping.
- **API:** no API docs publish the bad mapping.
- **Changelog:** no changelog entry was added in this session; the `changelog.html` on Scout-product-page already notes that "Model-specific neuron rates updated" for the August 21 model change and does not need a correction.

## Production impact

- **Does production still contain the old mapping:** YES — `master` (`4a1eee7`) still contains the incorrect association.
- **Was production changed:** NO.

## Remaining uncertainty

- Cloudflare does not explicitly document whether `@cf/meta/llama-3.1-8b-instruct-fast` and `@cf/meta/llama-3.1-8b-instruct-fp8-fast` are billing aliases. They are treated as distinct identifiers.
- Cloudflare does not explicitly guarantee a `result.usage.neurons` field on every response; the adapter treats it as optional and uses it only when present.
- The exact neuron rates for `@cf/meta/llama-3.1-8b-instruct-fast` remain unpublished.

## Recommended next action

**A. Leave the fix on develop until normal Scout release.**

The unrelated Phase 7/8 conversation gate remains parked and unresolved. Do **not** perform a production hotfix (option B) without explicit approval.

## Release state

**SCOUT GENERAL RELEASE READY:** NO

**Reason:** The unrelated Phase 7/8 conversation gate remains parked and unresolved. This commit fixes only Cloudflare neuron accounting; it does not clear the conversation release gate.
