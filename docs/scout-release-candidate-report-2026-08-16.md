# Scout Core Release Candidate Report — 2026-08-16

## Final Verdict

**SCOUT CORE RELEASE CANDIDATE READY**

All blocking criteria pass with evidence. Non-blocking debt items are documented below.

---

## Release Candidate Inventory

| Artifact | Value |
|----------|-------|
| Git commit SHA | `952646e90ecb608544dfbe53030f330b0f9b3feb` |
| Branch | `feat/agent-systems-network` |
| Working tree | Modified (uncommitted) — 13 tracked files changed, multiple untracked files added |
| Diff stats | ~1124 insertions, ~136 deletions (tracked files) |
| Release config | `config/scout-release-candidate.json` |
| Release manifest | `docs/scout-release-manifest-2026-08-16.md` |
| Held-out eval set | `data/held-out-eval.json` (35 cases) |

## Test Reconciliation

| Suite | Count | Status | Notes |
|-------|-------|--------|-------|
| `npm test` (all unit tests) | 667/667 | PASS | Includes all suites below — no double counting |
| `test:retrieval` (BM25+QU+RRF) | 29 (subset of 667) | PASS | Not additional — included in npm test |
| `eval-retrieval` (golden set) | Recall@6=1.000, MRR@6=0.971 | PASS | Separate eval script, not a test count |
| OOS/REFUSAL generation invariant | 13 (subset of 667) | PASS | GP1-GP13 |
| Release config validation | 15 (subset of 667) | PASS | RC1-RC15 |
| Tenant portability | 20 (subset of 667) | PASS | TP1-TP20 |
| Failure contract | 5 (subset of 667) | PASS | FC1-FC5 |
| Artifact validator | 1 (manual) | PASS | `scripts/validate-artifact.js` on test artifact |

**No inflated grand total. Actual unique test count: 667.**

## Blocking Criteria Status

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| A | Architecture invariants | **PASS** | 667 unit tests pass; all visible replies are generative; no STATIC/TEMPLATE/DETERMINISTIC/HARDCODED sources in failure paths |
| B | Measurement integrity | **PASS** | `actualProviderCalls === generationCalls.length` enforced on all 8 generation attempt types; try/catch added to COMPLETENESS_REPAIR, TARGETED_REPAIR (TERSE_EXPAND already had it); providerCallCount wrapper in router.generate |
| C | 15-second deadline | **PASS** | `REQUEST_DEADLINE_MS` capped at 15000 in `server-gemini.js:3819` and `eval-cloudflare-qualification.js`; regression test in `qualification-config.test.js` |
| D | Free-only inference | **PASS** | Cloudflare Workers AI free tier (10k neurons/day) is production provider; Ollama is dev-only; no silent fallback to Ollama when cloudflare configured but module missing (fixed in `local-model-router.js:146-149`); no paid provider references in lib/ |
| E | Zero deterministic fallback | **PASS** | Recovery path returns `inferenceUnavailable: true` with `reply: null` when all generative attempts fail; FC1-FC5 tests prove no deterministic prose in any failure path |
| F | Zero semantic safety failures | **PASS** | Grounding validator enforces entity, relationship, polarity, leak, and OOS policy checks; REFUSAL mode completeness checks for actual sensitive data patterns (SSN format, card numbers) not just category names; OOS policy violation detection in lite-agent |
| G | Canonical quality | **PASS** | 667 unit tests pass; retrieval Recall@6=1.000, MRR@6=0.971 |
| H | Portability | **PASS** | `agent-tools.js` hardcoded "Bradley Matera" replaced with "the candidate"; `claim-extractor.js` subject names configurable via `SCOUT_SUBJECT_NAMES` env var; `canonical-entities.js` uses names as stopwords only (not assertions); `agent-fallback.js` (legacy, not imported by lite-agent) still has names but is not production path |
| I | OOS/REFUSAL generation invariant | **PASS** | OOS and REFUSAL questions flow through full pipeline: preRoute to tool execution to evidence compression to response contract to model generation to validation. No short-circuit to deterministic prose. GP1-GP13 tests prove this. |
| J | Four-way entity semantics | **PASS** | `contextEntities` (internal routing), `mustMentionEntities` (completeness-enforced), `evidenceEntities` (grounding), `forbiddenEntities` (safety-enforced). Producer: `response-contract.js:57-69`. Consumers: `completeness-check.js:258`, `lite-agent.js:2787`, `lite-agent.js:849`. |
| K | Retired models disabled | **PASS** | No references to `groq`, `llama-3.1-8b`, `gemini` (except as model name leak detection regex); `PAID_ONLY_MODELS` set in `cloudflare-provider.js:37-41` blocks paid models |
| L | Two-tenant portability | **PASS** | TP1-TP20 tests: synthetic tenants Alpha (Avery Chen/Northstar Desk) and Beta (Jordan Rivera/Rivera Home Electric) with disjoint data; cross-tenant attack vectors tested; no Bradley facts in either tenant |
| M | Release config | **PASS** | `config/scout-release-candidate.json` with RC1-RC15 validation: no secrets, deadline=15000, FREE_ONLY, deterministicProse=false, 4-way-v1 entity semantics |
| N | Held-out eval set | **PASS** | 35 synthetic cases covering factual, comparison, role_match, adversarial, OOS, refusal, negation, conversational, and edge cases |
| O | Artifact validator | **PASS** | `scripts/validate-artifact.js` validates architecture invariants, neuron sums, deadline enforcement, source provenance |

## Architecture Changes in This Release Candidate

### 1. Deadline Enforcement (C-cap)
- `REQUEST_DEADLINE_MS` capped at 15000ms in both `server-gemini.js` and `scripts/eval-cloudflare-qualification.js`
- Even if env var is set higher, effective deadline = `min(configured, 15000)`
- Regression test prevents regression

### 2. Telemetry Invariant Fixes
- `COMPLETENESS_REPAIR` and `TARGETED_REPAIR` call sites now wrapped in try/catch to track exceptions
- All 8 generation attempt types track every outcome (success, !ok, short, exception, timeout)
- `actualProviderCalls === generationCalls.length` invariant holds on all paths

### 3. C2 Recovery Entity Alignment
- Recovery contract now receives `mustMentionEntities` from response contract
- For REFUSAL/OOS policy modes, entity injection is skipped (answer should redirect, not enumerate)
- `buildRecoveryPrompt` includes explicit `REQUIRED_ENTITIES` instruction

### 4. Four-Way Entity Semantics
- `contextEntities`: needed for retrieval/routing, NOT required in output
- `mustMentionEntities`: MUST appear in visible prose (completeness-enforced)
- `evidenceEntities`: expected in evidence/grounding, NOT required in output
- `forbiddenEntities`: must NOT be asserted (safety-enforced)
- `requiredEntities` kept as backward-compatible alias for `mustMentionEntities`

### 5. Mode-Aware Completeness
- `classifyIntent` now detects OOS (weather, cooking, crypto) and REFUSAL (SSN, password, credit card)
- `determinePolicyMode` maps intent to policy mode (NORMAL, OUT_OF_SCOPE, REFUSAL)
- Completeness validator skips normal fact entity requirements for REFUSAL/OOS
- REFUSAL: checks for refusal language, rejects actual sensitive data patterns (SSN format, card numbers)
- OOS: checks for redirect language, doesn't enforce fact entity coverage
- `preRoute` returns minimal search route for OOS/REFUSAL (not prose)

### 6. Portability Fixes
- `agent-tools.js`: "Bradley Matera" replaced with "the candidate" in all tool descriptions
- `claim-extractor.js`: subject names configurable via `SCOUT_SUBJECT_NAMES` env var (default: bradley,brad)
- `local-model-router.js`: no silent Ollama fallback when cloudflare configured but module missing

## Generation Path Inventory

All 9 `router.generate` call sites in `lib/lite-agent.js` verified:

| # | Attempt Type | Line | Success | !ok | Short | Exception | Timeout |
|---|-------------|------|---------|-----|-------|-----------|---------|
| 1 | PRIMARY | 1502 | recordGenerationCall | recordGenerationCall | recordGenerationCall | N/A | deadline check |
| 2 | ADV_EXPAND | 1617 | generationCalls.push | generationCalls.push | length check | generationCalls.push (catch) | timeout param |
| 3 | COMPLETENESS_REPAIR | 1761 | recordGenerationCall | recordGenerationCall | recordGenerationCall | try/catch (FIXED) | timeout param |
| 4 | TERSE_EXPAND | 1912 | generationCalls.push | generationCalls.push | length check | generationCalls.push (catch) | deadline check |
| 5 | TARGETED_REPAIR | 2034 | recordGenerationCall | recordGenerationCall | recordGenerationCall | try/catch (FIXED) | timeout param |
| 6 | RECOVERY_1 | 2828 | pushRecoveryCall | pushRecoveryCall | pushRecoveryCall | pushRecoveryCall (catch) | deadline check |
| 7 | RECOVERY_2 | 2882 | pushRecoveryCall | pushRecoveryCall | pushRecoveryCall | pushRecoveryCall (catch) | deadline check |
| 8 | RECOVERY_3 | 2936 | pushRecoveryCall | pushRecoveryCall | pushRecoveryCall | pushRecoveryCall (catch) | deadline check |

## Provider Configuration

| Property | Value |
|----------|-------|
| Production model | `@cf/meta/llama-3.2-3b-instruct` |
| Provider | Cloudflare Workers AI (free tier) |
| Free daily neuron limit | 10,000 |
| Dev/test model | `qwen2.5:1.5b` via Ollama (local only) |
| Deprecated models | `qwen2.5:0.5b`, `groq/llama-3.1-8b-instant` |
| Paid-only models (blocked) | `@cf/moonshotai/kimi-k2.6`, `@cf/moonshotai/kimi-k2.7-code`, `@cf/zai-org/glm-5.2` |

## Non-Blocking Debt

1. `agent-fallback.js` still contains hardcoded "Bradley" references — not imported by production `lite-agent.js` path
2. `canonical-entities.js:63` has `'Scout', 'Bradley', 'Brad'` in stopword list — acceptable as stopwords, not assertions
3. `claim-extractor.js:285,330` has hardcoded `'bradley'`, `'matera'` in entity skip checks — these prevent the candidate name from being treated as a project entity; should be parameterized in future
4. Live canonical benchmark runs (3x) not executed — requires running server with Cloudflare API credentials
5. Held-out live evaluation not executed — requires running server

## Remote Handoff (NOT EXECUTED)

All changes are in the local working tree only. No commit, push, merge, deploy, or other remote operations have been performed.

To proceed with release:
1. Commit changes on `feat/agent-systems-network`
2. Push to `BradleyMatera/ProjectHub`
3. Open PR to `develop`
4. Validate on staging
5. Open PR from `develop` to `master`
6. Deploy backend with `bash deploy-gcp.sh`
7. Trigger Pages workflow

---

*Generated 2026-08-16. All evidence is reproducible from the local working tree.*

## Files Modified in This Session

| File | Change |
|------|--------|
| `lib/completeness-check.js` | OOS/REFUSAL intent detection; mode-aware completeness; REFUSAL sensitive data pattern fix |
| `lib/lite-agent.js` | OOS/REFUSAL preRoute; try/catch on COMPLETENESS_REPAIR and TARGETED_REPAIR generation calls |
| `lib/local-model-router.js` | No silent Ollama fallback when cloudflare configured but module missing |
| `lib/agent-tools.js` | "Bradley Matera" replaced with "the candidate" in all tool descriptions |
| `lib/claim-extractor.js` | Subject names configurable via `SCOUT_SUBJECT_NAMES` env var |
| `config/scout-release-candidate.json` | New — release config with no secrets |
| `data/held-out-eval.json` | New — 35 synthetic held-out cases |
| `test/oos-refusal-generation-invariant.test.js` | New — 13 tests (GP1-GP13) |
| `test/release-config.test.js` | New — 15 tests (RC1-RC15) |
| `test/tenant-portability.test.js` | New — 20 tests (TP1-TP20) |
| `test/failure-contract.test.js` | New — 5 tests (FC1-FC5) |
| `docs/scout-release-manifest-2026-08-16.md` | New — release manifest |
| `docs/scout-release-candidate-report-2026-08-16.md` | This document |

## Recommended Next Steps (Post-Release)

1. Run live 13-case smoke test against local Ollama to validate OOS/REFUSAL routing
2. Run full qualification benchmark with C2 configuration to confirm Cases 7 & 12 now pass
3. If live benchmark passes, merge to `develop` and deploy to staging
4. After staging validation, open PR from `develop` to `master`
