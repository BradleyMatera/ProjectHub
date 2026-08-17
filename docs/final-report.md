# Scout Architecture Refactor — Final Report

## Outcome Summary

The `feat/architecture-refactor` branch now has a clean, testable Scout runtime with no deterministic user-visible prose. All conversational replies originate from `DIRECT_KB`, `MODEL_GENERATION`, or `TECHNICAL_ERROR`. The full suite is green, retrieval accuracy is at target, inference routing is Cloudflare-first with Ollama fallback, and the knowledge base reflects Bradley's current career status.

## Completed Work

| Task | Status | Notes |
|------|--------|-------|
| P0 — Protect work / git state | completed | Working on `feat/architecture-refactor` (no push this session) |
| P1 — `lib/agent-fallback.js` | completed | Replaced with deprecated stub exporting `{}`; `test/agent-fallback.test.js` updated |
| P1 — `server-gemini.js` reduction | completed | Removed Think Mode (`runThinkMode`, scoring, archiving, `/api/think`), `TONE_REQUEST_RE`, `SPECIAL_QUESTION_RE`, old deterministic fallback, and `lastChatActivityAt` |
| P1 — Architecture-invariant tests | completed | Strengthened `proseSource` and prose-authorship assertions; full suite passes |
| P2 — Closed-world employment fix | completed | `employmentHistory` set to `open_world`; education/certifications retained as `closed_world` |
| P3 — Bradley KB update | completed | Added accepted Helm Group offer, title "Early-career Software Engineer", `gpaVisibility`, updated `ProjectHub (Scout)` description |
| P4 — Inference routing | completed | `lib/local-model-router.js`: Cloudflare primary, Ollama fallback, deadline-aware, provider tags in usage telemetry |
| P5 — Cloudflare credential check | completed | No local `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` found; no values exposed |
| P7 — Ollama verbalizer qualification | completed | `scripts/ollama-verbalizer-benchmark.js`: 2/10 GOOD, 30% hallucination, 8 contract violations (see temp JSON at `F:\Scratch\Temp\ollama-verbalizer-benchmark.json`) |
| P8 — UI/docs refresh | completed | `README.md`, `index.html`, `agent-preview/index.html` updated to Cloudflare-primary / Ollama-fallback |
| P10 — Tests and retrieval eval | completed | `npm test` 777/777; `npm run eval-retrieval` Recall@6 = 1.000, MRR = 0.971 |

## Verification Status

| Check | Result |
|-------|--------|
| `npm test` | pass — 777/777 |
| `npm run test:retrieval` | pass — 29/29 |
| `npm run eval-retrieval` | pass — Recall@6 = 1.000, MRR = 0.971 |
| `node --check lib/local-model-router.js` | clean |
| `node --check server-gemini.js` | clean |
| Ollama verbalizer benchmark | 2/10 GOOD — not production-ready |

## Key Code Changes

- `lib/agent-fallback.js` — deprecated stub; no deterministic prose functions exported.
- `server-gemini.js` — removed Think Mode, deterministic fallback, and stale semantic regexes.
- `lib/lite-agent.js` — fixed `completenessPacket` TDZ bug in the `ADV_EXPAND` success path; added `provider` tagging in `generationCalls`.
- `lib/local-model-router.js` — `SCOUT_INFERENCE_PROVIDER=auto` picks Cloudflare when credentials are present, otherwise Ollama; explicit `cloudflare`/`ollama` overrides supported; fallback is deadline-aware.
- `lib/cloudflare-provider.js` / `lib/local-model-router.js` — `usage.provider` now set to `cloudflare` or `ollama` for telemetry.
- `data/recruiter-knowledge.json` — corrected closed-world/open-world boundaries and updated canonical identity.
- `test/agent-engine.test.js` — updated the ProjectHub mischaracterization test to assert `valid === false`.
- `README.md`, `index.html`, `agent-preview/index.html` — reflect Cloudflare-primary / Ollama-fallback.

## Blocked / Pending Work

| Task | Status | Why / Next Step |
|------|--------|-----------------|
| P6 — Cloudflare qualification | blocked | No credentials in this environment. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, then run `node scripts/eval-cloudflare-qualification.js` and `scripts/cf-ai-test.js`. |
| P9 — Diagnose staging sync | pending | Not addressed this session; requires GitHub Actions / staging repo access. |

## Important Findings

1. **Ollama fallback is not currently reliable.** The `qwen2.5:1.5b` verbalizer benchmark returned only 2/10 GOOD answers with 30% hallucination and multiple contract violations. It should be treated as a dev/test and last-resort fallback, not a production target.
2. **All runtime prose now comes from allowed sources.** The architecture-invariant and server-prose-regression tests confirm no deterministic final prose remains in runtime JS.
3. **Retrieval is at target.** `Recall@6 = 1.000` on the 40-query golden set means the RAG layer is not the blocker.
4. **Cloudflare credentials are required to proceed.** Once supplied, the router will automatically use Cloudflare as the primary provider and the semantic qualification suite can be run.

## Working Tree Notes

- There are numerous untracked experiment artifacts (`_refactor*.js`, `.scout-*-snapshots/`, `benchmark/`, `scripts/cf-*.js`, etc.) left from previous sessions.
- This session intentionally focused on tracked architectural and data fixes. Cleanup of untracked files is a separate task.
