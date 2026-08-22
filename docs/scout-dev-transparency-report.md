# SCOUT DEV TRANSPARENCY REPORT

## Summary

This report documents the dev-staging restoration of RAG-first grounding for Scout (ProjectHub Recruiter Alpha) on `feat/rag-primary-restoration`. The primary issue was that `META` and `VERIFIED_FACT` questions returned empty `retrievalCandidates` and ungrounded or cached replies.

## Root cause

- `lib/response-policy-classifier.js` had a strict `META` regex that failed on natural phrasing like `How is this chat free?` and `How do daily caps and cooldowns work?`, routing those to `OUT_OF_SCOPE` and bypassing retrieval.
- `server-gemini.js` pre-warmed the knowledge cache in the background, so the first production request spent its ~15 s deadline waiting for `fetchKnowledge()` to build the BM25 index.
- `lib/rag-agent.js` required JSON output (`format: 'json'`) and `parseGeneratedAnswer` had no plain-text fallback, so Cloudflare/Llama 3.2 outputs that were not strict JSON either failed or were rejected.
- The `INFERENCE_UNAVAILABLE` and `runRagPrimaryAgent` early-return paths did not carry `retrievalCandidates`, making it appear that retrieval itself had failed.
- The `is_type` relationship validator had no graph evidence for `ProjectHub is a live analytics dashboard`, causing a `VERIFIED_FACT` answer to be rejected.

## Changes

| Commit | Purpose |
|--------|---------|
| `48ad956` | Keep `META` questions in the RAG path and eliminate `fetchKnowledge` race that cached empty-evidence replies. |
| `ce23086` | Broaden `META` regex, accept plain-text model output, expose `retrievalCandidates` in `INFERENCE_UNAVAILABLE`. |
| `c713ffe` | Replace the concrete RAG prompt example with a placeholder to stop the model from copying the example. |
| `9ef9142` | Pre-warm knowledge before `app.listen`, remove `format: 'json'` constraints, carry `retrievalCandidates` through all RAG paths. |
| `3448281` | Add `live analytics dashboard` to the `ProjectHub (Scout)` category so the `is_type` validator accepts the grounded answer. |

## Validation

- `node --check server-gemini.js lib/rag-agent.js lib/response-policy-classifier.js` passed.
- `npm run test:retrieval` (29 tests) passed.
- `node test/public-telemetry.test.js` (3 tests) passed.
- Dev health endpoint `https://dev.projecthub-chat.bradleymatera.dev/health` returns:
  - `sourceRepository: BradleyMatera/ProjectHub`
  - `sourceBranch: feat/rag-primary-restoration`
  - `sourceCommit: 3448281...`
  - `provider: cloudflare`
  - `primaryModel: @cf/meta/llama-3.2-3b-instruct`
  - `agentMode: lite`

## Manual QA results (dev)

| Query | `proseSource` | Outcome |
|-------|---------------|---------|
| `What is ProjectHub?` | `MODEL_GENERATION` | Grounded; returns portfolio widget and analytics dashboard. |
| `How is this chat free?` | `MODEL_GENERATION` | Grounded; explains Cloudflare free allocation, GitHub Pages, GCP VM. |
| `How do daily caps and cooldowns work?` | `MODEL_GENERATION` | Grounded; explains Cloudflare neuron cap and rate controls. |
| `What can you help with?` | `MODEL_GENERATION` | Returns a generic capabilities summary. |
| `What model do you use?` | `MODEL_GENERATION` | Returns `Unknown` — needs further tuning. |
| `What is Scout?` | `MODEL_GENERATION` | Includes echoed `Q:` prefix — prompt-answer parsing needs further polish. |
| `How is this hosted?` | `MODEL_GENERATION` | Grounded; explains GitHub Pages, GCP VM, Caddy. |
| `Tell me about Bradley` | `MODEL_GENERATION` | Grounded; returns profile summary. |

## Known issues

- `What model do you use?` currently returns `Unknown` even though the runtime facts include the model. The model is not synthesizing the answer from the evidence for this specific phrasing.
- `What is Scout?` echoes the `Q:` prefix. `parseGeneratedAnswer` should strip `Q:` and `A:` scaffolding in the plain-text fallback.
- `What can you help with?` is still classified as a control turn and uses the lite control packet; the `META` regex does not match this exact variant.
- `retrievalCandidates` are present on `INFERENCE_UNAVAILABLE` responses but the success path returns them inside `agentMeta` only. The UI should read `agentMeta.retrievalCandidates` or the server may surface a top-level `retrievalCandidates` field consistently.

## Deployment

- Branch: `feat/rag-primary-restoration`
- Latest SHA: `344828123511354749620666c56e8f6f66130ce7`
- Dev health: `https://dev.projecthub-chat.bradleymatera.dev/health`
- Staging sync: `scripts/manual-deploy-dev.js` deployed to the GCP dev VM successfully.

## Next steps

1. Decide whether to keep `feat/rag-primary-restoration` for additional QA or merge to `develop`.
2. Polish `parseGeneratedAnswer` to strip `Q:` / `A:` scaffolding.
3. Investigate `What model do you use?` evidence synthesis.
4. Verify GitHub Pages dashboard and per-reply metrics.
