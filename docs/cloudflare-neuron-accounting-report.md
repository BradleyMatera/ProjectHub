# Cloudflare Neuron Accounting Correction — Final Report

**Date:** 2026-08-23
**Task:** Isolated Cloudflare model / neuron accounting correctness
**Branch:** `develop`

## Finding

**WAS SCOUT ACCOUNTING WRONG:** **YES**

Scout's provider adapter and free-tier data associated the published neuron rates `4119 / 34868` with `@cf/meta/llama-3.1-8b-instruct-fast`. Cloudflare's official Workers AI pricing page does **not** publish those rates for that exact identifier; it publishes them for `@cf/meta/llama-3.1-8b-instruct-fp8-fast`. Scout was therefore presenting unverified pricing as verified.

## Additional finding — null/unknown propagation bugs

After the exact-model pricing fix, two smaller accounting bugs were found:

- **Bug 1 — Unknown neurons became zero:** `logic.js` initialized `actualNeurons` and `estimatedNeurons` at `0` and summed them with `finiteNumber`, which converts `null` into `0`. A `-fast` call with no `usage.neurons` therefore appeared as `0 neurons` instead of `unknown` at request, multi-call, and session level.
- **Bug 2 — Unknown shadow price became $0:** `lib/cost-ledger.js` `priceEventMicroUsd()` returned `0` when a source had no `shadowRates`. For `cloudflare` (exact token rates unknown) this made unpriced inference appear as a known $0 shadow cost.

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
- `lib/cost-ledger.js`
- `lib/cost-insights.js`
- `test/cloudflare-provider.test.js`
- `test/public-telemetry.test.js`
- `test/cost-ledger.test.js`

**Functions:**
- `MODEL_NEURON_PRICING` — removed the bad `-fast` entry; added exact published entries for `-fp8-fast` and `-fp8`.
- `neuronPricing` — unchanged exact-key lookup; now returns `null` for `-fast`.
- `estimateNeurons` — returns `null` when the exact model has no published rate.
- `estimateDailyCapacity` — returns `null` when the exact model has no published rate.
- `estimateCloudflareNeurons` — now model-aware; returns `null` for unknown models.
- `estimatedCloudflareMeteredUsd` — null-safe.
- `toKnownNumber` / `addNullableKnown` — helpers that distinguish `0` (known zero) from `null` (unknown/unavailable).
- `getScoutUsageState` — `actualNeurons`, `estimatedNeurons`, and the combined `neurons` field now initialize to `null`.
- `summarizeGenerationCalls` — aggregates actual, estimated, and combined `neurons` separately; the complete `neurons` total is only set when every call has a known value. Unknown values are `null`, never `0`.
- `recordScoutUsage` — uses `addNullableKnown` so a request with unknown usage nullifies the running session total instead of silently adding `0`.
- `cloudflareDayFromCosts` — returns `null` neurons/pct/remaining when exact pricing is unknown.
- `refreshScoutRuntimeDashboard` / `buildScoutTelemetryHtml` — display `unknown` / `unverified` instead of `0` when pricing is unverified; use the combined `neurons` field for request and session totals.
- `priceEventMicroUsd` — returns `null` for unpriced or missing sources, `0` only for explicitly zero-priced sources.
- `CostLedger.record` / `totalsFor` / `snapshot` — tracks `unpriced` and `unpricedSources`; numeric totals remain valid for known costs and expose `monthComplete` / `dayComplete` flags.
- `buildInsights` — when `shadowCost.monthComplete` is false, describes the known-priced portion and the unpriced sources instead of presenting an incomplete total as complete.

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
- **SHADOW COST:** The `free-tier-limits.json` no longer publishes fake neuron rates or derived shadow rates for the `-fast` model. `lib/cost-ledger.js` now returns `null` for unpriced sources and marks the ledger as `monthComplete: false` with `unpricedSources: ['cloudflare']` when Cloudflare usage is recorded. Known costs from other sources are still summed; the total is clearly flagged incomplete rather than displayed as a complete $0.
- **PUBLIC TELEMETRY:** The widget now shows `unknown` / `unverified` instead of a fabricated `0` or the old wrong estimate.

## Tests

- **cloudflare-provider:** 26/26 passed (`node --test test/cloudflare-provider.test.js`)
- **public-telemetry:** 9/9 passed (`node --test test/public-telemetry.test.js`)
- **cost-ledger:** 13/13 passed (`node --test test/cost-ledger.test.js`)
- **cost-insights:** 6/6 passed (`node --test test/cost-insights.test.js`)
- **full npm test:** 944/944 passed
- **build:** PASS (`npm run build`)
- **syntax:** PASS (`node --check`)
- **git diff:** PASS (`git diff --check`)

## Final verification matrix

| Case | Result |
|---|---|
| CASE 1: `-fast` + no actual neurons | Request `actualNeurons`/`estimatedNeurons`/`neurons`: `null` · Session `neurons`: `null` · Shadow cost: `unpriced/incomplete` |
| CASE 2: `-fast` + actual provider neurons | Request `neurons`: actual value · Session `neurons`: actual value |
| CASE 3: `-fp8-fast` + no actual neurons | Estimated neurons: computed from exact published rates (e.g. 1M input tokens = 4119 neurons) |
| CASE 4: Mixed provider calls, one neuron value unknown | Request `neurons`: `null` (not a partial numeric total) |
| CASE 5: Cloudflare tokens but no verified shadow token rate | Cloudflare shadow value: `unknown/unpriced` · Overall ledger completeness: `partial/incomplete` |

## Documentation

- **ProjectHub:** `data/free-tier-limits.json` corrected; `docs/cloudflare-neuron-accounting-report.md` updated.
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
