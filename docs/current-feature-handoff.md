# Scout Local-Only Feature Handoff

**Updated:** 2026-08-13

**Working branch:** `feat/agent-systems-network`

**Code baseline:** Conversation engineering phase (post-`3f6b5be`)

**Conversation resolver:** `lib/conversation-resolver.js` provides generic
coreference resolution. It builds conversation state from history and
knowledge entities, then resolves referents like "there", "it", "this thing",
"the other project", and "that" to specific entities. The harness resolves
references BEFORE retrieval so the model doesn't have to. Domain-neutral —
uses knowledge entities, not hardcoded names.

**Intent precedence fix:** `lib/completeness-check.js` classifyIntent() now
checks specialized intents (RECRUITER, JOB_FIT, COMPARISON, OPINION, gaps)
BEFORE generic YES_NO. This fixes q68 ("Is he someone worth interviewing?")
being classified as YES_NO instead of RECRUITER. FOLLOW_UP is checked after
specialized intents and YES_NO.

**Response Contract V2:** `lib/response-contract.js` now produces:
- `requiredEntities` — entities that MUST be named in the answer
- `evidenceStrength` — INTERNSHIP, PROJECT, CERTIFICATION, or PROFESSIONAL
- `boundary` — important limitation to mention (e.g., entry-level)
- `directAnswer` — deterministic polarity (YES/NO/MIXED/FIT/PARTIAL_FIT/NOT_FIT)
- `keyFacts` — top 3 evidence facts scored by entity relevance (generic, no hardcoded tech names)

**Required fact coverage:** `lib/completeness-check.js` evaluateCompleteness()
now accepts a responseContract parameter and checks:
- MISSING_REQUIRED_ENTITIES — answer must name required entities
- MISSING_REQUIRED_FACTS — very short answers (< 12 words) must cover at least 20% of key fact words
- POLARITY_MISMATCH — answer must match contract directAnswer polarity

**Targeted repair:** `lib/lite-agent.js` buildCompletenessRepairPacket() now
includes missing entities, polarity, and boundary instructions. A new
`meaningPreserved()` function checks that repair doesn't reverse negation
or polarity.

**Targeted quality suite:** `scripts/run-targeted-quality-suite.js` tests
intent classification, coreference resolution, response contract, completeness,
and meaning preservation with 49 synthetic + benchmark tests. All pass.

**Full 68-eval (v2b):** 41 GOOD, 7 BORDERLINE, 8 NOT_GOOD, 12 FALLBACK,
0 safety errors. Fallback within threshold (12 ≤ 13). Generated GOOD
(41-48) below 55 threshold. Verdict: NOT YET.

**Remaining issues:** q31 context error (first in c7, no history for "there"),
q20 generic Node.js definition, q25 doesn't answer "why", q43 overclaim,
q65 factual error (ProjectHub vs CIRIS confusion), several terse answers.
Many fallbacks are from pre-existing grounding validator failures.

**Release state:** committed locally, not promoted to `develop` or `master`, not deployed. Production is unchanged.

This is the continuation source of truth for the local-only Scout work. Read `AGENTS.md` first, then this file before changing or deploying the feature.

## Goal and non-negotiable constraints

Scout must be useful, natural, coherent, and honest while remaining free and local-only. Runtime model inference uses the Ollama model `qwen2.5:0.5b` on the existing GCP e2-micro VM. Do not add Groq, OpenAI, Gemini, Cloudflare AI, hosted embeddings, provider switches, or cloud-model fallbacks. The public agent has read-only evidence tools and no arbitrary web, shell, message, or write capability.

No model can guarantee a correct answer to every possible question. The production contract is instead: always return a relevant, useful response; distinguish verified skill from learnability; preserve the user's subject; never invent evidence; and fall back deterministically if Ollama is slow or invalid.

## Current request path

```text
visitor message + session history
  -> safety and false-claim checks
  -> normalization, protected-term typo handling, intent classification
  -> direct BM25 for standalone questions
  -> contextual BM25 views + local RRF (k=60) for follow-ups
  -> deterministic grounded answer and optional read-only agent tool
  -> bounded Ollama phrasing for eligible open-ended conversation
  -> entity, number, source, safety, length, and overclaim validation
  -> validated local answer or ready grounded answer
  -> five-turn memory and topic stance update
```

Important implementation details:

- `lib/query-understanding.js` protects unfamiliar technology names such as COBOL from typo correction, detects frustration, and expands learning/debugging questions.
- `lib/rrf.js` fuses literal, expanded, and contextual BM25 rankings only when history makes those views useful. Standalone retrieval remains BM25.
- `server-gemini.js` gives a direct, technology-specific assessment for unverified stacks. It says what is not proven, what transfers, and what learning would require.
- Literal requests such as `say cobol` preserve `COBOL` and are not replaced by a generic recruiter pitch.
- Frustration repair acknowledges the conversational failure and answers the actual subject retained in the five-turn context.

## Why RRF is contextual only

The supplied BM25/RRF article and the paper *From BM25 to Corrective RAG: Benchmarking Retrieval Strategies for Text-and-Table Documents* informed this design. The useful local result was reciprocal-rank fusion over complementary lexical query views. An offline experiment applying correlated RRF views to every standalone query lowered MRR from `0.971` to about `0.942`, so global RRF was rejected. No dense service, cross-encoder, HyDE generator, or cloud embedding dependency was added.

## Production-derived regression corpus

A read-only production audit retrieved `stats.json` and seven backups from VM `ollama-api-gate` in project `ollamaapi-501903`, zone `us-central1-a`.

- The all-time request counter was 195, but retained logs are capped; all 195 original conversations are not recoverable.
- Recoverable material contained 81 complete input/reply turns across 26 sessions, 40 older prompt-only records in reconstructable order, and five meaningful older complete request records.
- One duplicate and one truncated mirror were excluded.
- The checked-in suite therefore replays 126 meaningful production-retained inputs, plus six reported COBOL/frustration turns: 132 inputs across 33 scenarios.
- Historical replies are not treated as golden output. Assertions require improved semantic behavior, local-only sources, privacy, variety, and latency.
- Production session IDs, timestamps, referrers, contact data, and historical reply text were not committed. The raw temporary export was left outside the repository under `/tmp/projecthub-prod-conversations.O2n36o` and must not be committed.

## COBOL regression contract

The six-turn scenario must remain direct and topic-specific:

1. `YOUR MAKING ME MAD!` — apologize for repeating a generic pitch and invite a specific concern.
2. `Can he debug cobol?` — do not claim day-one COBOL ability; explain transferable debugging and the learning gap.
3. `Can he learn cobol?` — answer yes, supported by verified learning behavior, without claiming current COBOL skill.
4. `yeah but he CAN learn cobol right?` — confirm directly with varied wording.
5. `say cobol` — answer with correctly capitalized `COBOL`.
6. The final misspelled request for real feedback — retain COBOL and give a candid specific assessment, not the generic bio.

Do not add COBOL to `data/recruiter-knowledge.json` as a verified skill. This regression tests reasoning about an unfamiliar technology, not a new resume claim.

## Verified results at the code baseline

The following passed locally on commit `0e0c606`:

| Check | Result |
|---|---|
| `node --check server-gemini.js` | passed |
| `npm test` | 63/63 |
| `npm run test:retrieval` | passed |
| `npm run eval-retrieval` | Recall@6 `1.000` (40/40), MRR@6 `0.971` |
| `PROJECTHUB_API_URL=http://127.0.0.1:3199 npm run eval:local-api` | 61/61; p50 1 ms, p95 2 ms, max 24 ms |
| `python3 test-production-conversations.py --url http://127.0.0.1:3199/api/chat` | 33/33 scenarios, 132/132 inputs |
| `npm run build` | passed |

An earlier private-preview deployment at commit `a4c8bd4` passed the then-current 126-input live replay: p50 `0.12s`, p95 `10.488s`, max `13.265s`, and no request over 15 seconds. Every observed response source was grounded/local. This proves the end-to-end fallback system, not that every prompt was successfully phrased by Ollama: the small model still often times out or fails validation.

## Exact next-agent checklist

1. Confirm the branch and preserve unrelated work:

   ```bash
   git status --short --branch
   git log -5 --oneline
   ```

2. Re-run the fast local acceptance checks:

   ```bash
   node --check server-gemini.js
   npm test
   npm run eval-retrieval
   npm run build
   ```

3. Deploy the current feature commit only to the private loopback preview:

   ```bash
   bash deploy-agent-preview.sh
   ```

4. In a second terminal, open an SSH tunnel:

   ```bash
   AGENT_PREVIEW_LOCAL_PORT=3320 bash scripts/open-agent-preview.sh
   ```

5. Run the full live acceptance through the tunnel:

   ```bash
   PROJECTHUB_API_URL=http://127.0.0.1:3320 npm run eval:local-api
   python3 test-production-conversations.py \
     --url http://127.0.0.1:3320/api/chat \
     --delay 2.5 \
     --verbose
   ```

6. Manually replay the six COBOL turns in the preview UI and confirm the route display does not replace the answer with generic boilerplate.
7. Stop the tunnel. Do not run `deploy-gcp.sh` and do not merge to `master` from this feature branch.
8. Open a PR from this feature branch to `develop`. Validate the development backend and `ProjectHub-dev` frontend before any `develop` to `master` release PR.

## Known limitations and unfinished acceptance

- The relationship-aware grounding phase added `lib/relationship-graph.js`, `lib/claim-extractor.js`, and `lib/relationship-validator.js`. These provide generic, domain-neutral relationship validation that prevents the model from recombining unrelated true facts into false claims.
- The conversational quality phase fixed the "js" truncation bug (sentence splitter was breaking on periods in tech names like Node.js), fixed validator false rejections (education context, possessives, negated overclaims, yes/no questions), added entity-scoped structured facts to context packets, and upgraded the repair packet to include specific unsupported relationships with supported alternatives.
- LITE mode (`lib/lite-agent.js`) has been updated to pass knowledge to the validator for relationship-aware grounding, build structured facts from the relationship graph, and provide relationship-aware repair context.
- 1.5B evaluation results (3 stability runs, 28 questions each):
  - Generative rate: 68–71% (average ~69%)
  - Forbidden claims: 0 across all runs
  - Manual audit of accepted answers: 100% factually correct
  - "js" truncation bug: FIXED
- Full parity suite (68 questions):
  - Generative: 47/68 (69%)
  - Fallback: 21/68 (31%)
  - Unsafe blocked: 0
  - Factually correct AND good: 36/68 (53%)
  - Factually correct but terse: 11/68 (16%)
  - Safe fallback: 21/68 (31%)
- Remaining fallbacks are primarily:
  - Model too short ("No.", "Internship") — model capacity
  - Model overclaim ("proficiency in", "extensive experience") — correctly rejected
  - Model confirms false claim (adversarial) — correctly rejected
  - Model hallucinates entity (MIT, Computer Science) — correctly rejected
- WebGPU browser-local testing remains NOT MEASURED.
- Local Ollama on an e2-micro is useful but inconsistent; validators and deterministic grounding are part of the product, not temporary scaffolding.
- Production retained only a capped subset of all-time requests, so the suite cannot reproduce missing conversations.
- The public frontend and production backend have not been changed by this feature branch.
- The canonical `PROJECTHUB-DEVELOPMENT-AND-RELEASE-SPEC.md` has been restored with the required feature, development staging, and production gates.

## LITE mode files

- `lib/lite-agent.js` — compact agent pipeline (rewrite → pre-route → tool → compress → generate → validate → fallback)
- `lib/relationship-graph.js` — generic relationship graph builder (subject-relation-object triples with provenance)
- `lib/claim-extractor.js` — deterministic claim extraction from generated text (no LLM, relation class normalization)
- `lib/relationship-validator.js` — relationship-aware validation (checks specific relationships, not just entity existence)
- `scripts/eval-lite.js` — LITE evaluation harness (28 questions across 9 categories)
- `data/lite-eval-results.json` — latest LITE eval results
- `data/accepted-answer-audit.md` — manual audit of previously accepted answers
- `docs/local-ai-runtime.md` — FULL vs LITE comparison, configuration, and measured results

## Files central to continuation

- `server-gemini.js` — orchestration, unknown-technology answers, memory, validation, endpoints, mode selection.
- `lib/lite-agent.js` — LITE agent pipeline.
- `lib/query-understanding.js` — protected terms, intent, contextual rewrite.
- `lib/rrf.js` — local reciprocal-rank fusion.
- `lib/grounding-validator.js` — shared validation (FULL and LITE).
- `test/rrf.test.js` and `test/query-understanding.test.js` — retrieval regressions.
- `scripts/eval-local-api.js` — 61-case local API acceptance.
- `scripts/eval-lite.js` — 28-case LITE evaluation.
- `test-production-conversations.py` — sanitized 132-input replay.
- `deploy-agent-preview.sh`, `scripts/open-agent-preview.sh`, and `deploy/projecthub-agent-preview.service` — private preview path.
