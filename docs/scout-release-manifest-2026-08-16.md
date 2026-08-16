# Scout Release Candidate Manifest
**Date:** 2026-08-16
**Release ID:** scout-rc-2026-08-16
**Branch:** feat/agent-systems-network

## Artifact Inventory

### Core Runtime
| File | Purpose | Lines |
|------|---------|-------|
| `lib/lite-agent.js` | Agent pipeline: routing, generation, validation, recovery | ~3053 |
| `lib/response-contract.js` | Four-way entity semantics, policy mode, evidence requirements | ~1062 |
| `lib/completeness-check.js` | Mode-aware completeness validation (NORMAL/REFUSAL/OOS) | ~260 |
| `lib/recovery-contract.js` | Recovery prompt builder with requiredEntities injection | ~200 |
| `lib/local-model-router.js` | Provider abstraction (Cloudflare/Ollama), free-only enforcement | ~382 |
| `lib/cloudflare-provider.js` | Cloudflare Workers AI free-tier inference adapter | ~271 |
| `lib/grounding-validator.js` | Grounding validation, relationship graph checks | ~500 |
| `lib/claim-extractor.js` | Deterministic claim extraction with configurable subject names | ~920 |
| `lib/agent-tools.js` | Read-only tool definitions (portable, no hardcoded names) | ~460 |
| `lib/canonical-entities.js` | Entity normalization and stopword management | ~200 |
| `lib/bm25.js` | Okapi BM25 retrieval index | ~200 |
| `lib/rrf.js` | Reciprocal Rank Fusion for multi-view retrieval | ~80 |
| `lib/query-understanding.js` | Query normalization, typo correction, intent classification | ~300 |
| `server-gemini.js` | Backend server with 15s deadline cap | ~4000 |

### Configuration
| File | Purpose |
|------|---------|
| `config/scout-release-candidate.json` | Release config: model, deadline, policy, spending |

### Test Suites
| Suite | Tests | Status |
|-------|-------|--------|
| `npm test` (all unit tests) | 662 | PASS |
| `test:retrieval` (BM25 + QU + RRF) | 29 (subset) | PASS |
| `eval-retrieval` (golden set) | Recall@6=1.000, MRR@6=0.971 | PASS |
| OOS/REFUSAL generation invariant | 13 | PASS |
| Release config validation | 15 | PASS |
| Tenant portability | 20 | PASS |
| Failure contract | 5 | PASS |

### Held-Out Data
| File | Purpose |
|------|---------|
| `data/held-out-eval.json` | 35 synthetic multi-tenant cases (not used in unit tests) |

### Scripts
| File | Purpose |
|------|---------|
| `scripts/validate-artifact.js` | Benchmark artifact validator |
| `scripts/eval-cloudflare-qualification.js` | Canonical 13-case qualification runner |
| `scripts/smoke-13.js` | Smoke tests including OOS and REFUSAL cases |

## Architecture Invariants

1. **No deterministic conversational prose** — all user-visible replies are generative
2. **Telemetry invariant** — `actualProviderCalls === generationCalls.length` on all paths
3. **Free-only inference** — Cloudflare Workers AI free tier only; no paid providers
4. **15s deadline cap** — enforced in server-gemini.js and eval scripts
5. **Four-way entity semantics** — contextEntities, mustMentionEntities, evidenceEntities, forbiddenEntities
6. **Three policy modes** — NORMAL, REFUSAL, OUT_OF_SCOPE
7. **Portability** — no hardcoded candidate names in lib/ (configurable via SCOUT_SUBJECT_NAMES)
8. **Eight generation attempt types** — PRIMARY, ADV_EXPAND, COMPLETENESS_REPAIR, TERSE_EXPAND, TARGETED_REPAIR, RECOVERY_1/2/3
9. **All generation paths tracked** — try/catch on every router.generate call site
10. **Failure returns typed technical failure** — null reply + inferenceUnavailable, never prose

## Provider Configuration

- **Production:** `@cf/meta/llama-3.2-3b-instruct` on Cloudflare Workers AI
- **Free tier:** 10,000 neurons/day
- **Dev/test:** Ollama `qwen2.5:1.5b` (local only, not production)
- **Deprecated:** `qwen2.5:0.5b`, `groq/llama-3.1-8b-instant`

## Remote Handoff (DO NOT EXECUTE)

1. Commit all changes on `feat/agent-systems-network`
2. Push to `BradleyMatera/ProjectHub`
3. Open PR to `develop`
4. After merge, sync-staging workflow mirrors to `ProjectHub-dev`
5. Validate on staging backend
6. Open PR from `develop` to `master`
7. After merge, run `bash deploy-gcp.sh` for production backend
8. Manually trigger Pages workflow
9. Verify live widget

**No remote operations have been performed.**
