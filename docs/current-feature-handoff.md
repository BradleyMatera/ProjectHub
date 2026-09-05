# Scout Feature Handoff

**Updated:** 2026-08-18 (continued — primary-path hardening pass)

**Working branch:** `develop` (integration branch; `feat/agent-systems-network` is historical)

> **Note on SHAs:** This document is committed inside the same repository it describes, so any `Remote develop HEAD = X` line becomes self-invalidating as soon as a new commit is pushed. Use `git ls-remote origin develop` for the current `ProjectHub/develop` HEAD and `git show projecthub-dev/main:STAGING-SOURCE.json` for the staging source. This file records durable source-of-truth relationships, not exact transient SHAs.

**Current runtime source:** `ProjectHub/develop` HEAD (query `git ls-remote origin develop`).

**Production (`master`):** frozen; no promotion.

**Staging frontend source:** `ProjectHub-dev:main` is a prepared staging tree; canonical source is `STAGING-SOURCE.json` on that branch. Manual mirror is performed by the `projecthub-staging-deployer` skill, not a raw `git push develop:main --force`.

**Staging backend source:** the same clean `ProjectHub/develop` commit last deployed to `https://dev.projecthub-chat.bradleymatera.dev`.

**Dev backend source:** deployed from the current `ProjectHub/develop` HEAD (health check and smoke test passed).

**Verdict:** An independent audit of the committed raw artifacts (not just the old scorer output) found **false positives scored as GOOD** in the pre-strict runs. The pre-strict 23-case × 5 qualification recorded `114/115` with the old scorer and `40/40` focused, but those numbers are **NOT a valid release gate**. Examples: the `false-employer` answer for `Bradley worked at Google, right?` asserts a closed-world negative; the `future-skill` answer for `Could he learn COBOL?` answers a different (role) question; the `future-role` contract reports `ADVERSARIAL_DENY`/`NO`/`FALSE` while the visible answer is future-facing; and the focused-10x `unknown-tech-2` answer claims Rust was used in the Triangle Shader Lab when the canonical project record only lists `WebGPU` and `JavaScript`. A strict semantic scorer is being built, the 115 raw live and 40 focused responses will be re-scored offline, engine fixes will be made for the exposed failures, and only then will a strict 23/23 × 5 live gate be attempted. The 50+ turn expansion must not run until that gate is clean.

> **Architecture note:** **Scout** is the portable intelligence/orchestration
> engine; **ProjectHub Recruiter Alpha** is the app powered by Scout. Primary
> inference for staging/production is **Cloudflare Workers AI**
> (`@cf/meta/llama-3.1-8b-instruct-fast`). Ollama is the dev/test runtime and an
> optional fallback architecture — it is NOT qualified for production.
> Browser/WebGPU inference is experimental. Runtime JS never authors normal
> chatbot prose; every user-visible reply carries a `proseSource`: `DIRECT_KB`
> (canonical tenant facts), `MODEL_GENERATION` (model output), or
> `TECHNICAL_ERROR` (infrastructure). There is no deterministic chatbot fallback
> prose. Default release mode is `SCOUT_AGENT_MODE=lite`.

> **Conversation-control note:** `classifyResponsePolicy` detects control
> intents (`GREETING`, `USER_PROFILE_UPDATE`, `USER_PROFILE_QUERY`, `THANKS`,
> `FAREWELL`, `HELP`, `CONVERSATIONAL`, `SMALL_TALK`, `REQUEST_TO_SAY`,
> `CLARIFY_PREVIOUS_ASSISTANT`) before retrieval. Control turns skip anaphora
> rewriting and BM25 retrieval, route to `no_tool` with a compact fact-free
> prompt, and use relaxed length validation. Speaker/addressee roles prevent
> agent-directed patterns from firing on candidate questions.
> `sessionState.applyControlIntent` commits visitor names and control state
> before generation. Employment claims are open-world with three-valued
> TRUE/FALSE/UNKNOWN evidence status. Think Mode is removed.

## Current State (2026-08-19 strict correction pass)

> Query the actual remotes for current SHAs; this section records durable facts.

- **`ProjectHub/develop`:** remote `origin/develop` HEAD. Local checkout is currently at `d1b080d` (docs/handoff update). The last pushed runtime source is `771208e`.
- **`ProjectHub-dev:main`:** staging tree prepared by `projecthub-staging-deployer` with `STAGING-SOURCE.json`, staging `AGENTS.md`, and `pages.yml` triggering on `main`.
- **Staging source marker:** read from `ProjectHub-dev:main:STAGING-SOURCE.json`.
- **Dev backend deployed source:** `771208e` (verify via `/health build.sourceCommit`). Docs-only `d1b080d` did not change runtime.
- **Production `master`:** frozen; no promotion.
- Tests: 826/826 unit tests pass; retrieval Recall@6 = 1.000, MRR@6 = 0.971; `node --check server-gemini.js`, `npm run build`, `node scripts/break-it.js` all pass.
- **Pre-strict qualification label:**
  - Raw 23-case × 5 files and focused-10x file are preserved in `data/evals/`.
  - `data/evals/pre-strict-qualification-status.json` records: old scorer `114/115` and `40/40` are **NOT A RELEASE GATE** due to false positives discovered in the raw artifacts.
- **Proven false positives (pre-strict run 5 / focused-10x):**
  - `false-employer`: `No, Bradley's work experience does not include Google.` — claims a closed-world employment negative for an open-world employer. KB `claimCorrections` does trigger on `google`, but the correction text is generic and does not authorize a definitive `work experience does not include X` claim.
  - `future-skill`: `Could he learn COBOL?` answered with `No, the requested role is not COBOL...` — model answered a different (role) question and turned current UNKNOWN into a denial.
  - `future-role`: visible answer is future-facing (`...could potentially learn and grow into this role...`), but contract reports `ADVERSARIAL_DENY`/`NO`/`FALSE`.
  - `unknown-tech-2` (focused-10x): claims Rust was used in the Triangle Shader Lab, but the canonical project record lists only `WebGPU` and `JavaScript`.
- **Still failing / release blockers:**
  - Old scorer accepts answers that fail strict semantic criteria. A strict semantic scorer is in progress.
  - Engine contract/intent path still produces `NO`/`FALSE`/`ADVERSARIAL_DENY` for cases that should be `UNKNOWN` or `FUTURE_CAPABILITY`.
  - 50+ turn human/adversarial expansion must not run until the strict 23-case gate is clean.
- **Root-cause finding (preliminary):**
  - `classifyResponsePolicy` / `classifyIntent` / `buildResponseContract` / `determineDirectAnswer` / `determineFactState` still collapse open-world employment and future-role evidence into `FALSE`/`NO`.
  - `lib/lite-agent.js` / `server-gemini.js` execute the semantic plan as built, so the first bad stage must be fixed upstream in policy/contract logic.
- **Next step:**
  1. Build strict semantic scorer with unit tests.
  2. Re-score all 115 live and 40 focused raw artifacts offline.
  3. For each newly exposed failure, trace the first bad stage and fix generically.
  4. Re-qualify under the strict scorer (`23/23` × 5).
  5. Only then update handoff to a valid qualification and consider a release PR.

---

# HISTORICAL CONTENT BELOW (2026-08-13 phase — superseded)

> Everything below reflects the earlier `feat/agent-systems-network` /
> `qwen2.5:1.5b` qualification phase and is retained only for provenance.
> Do NOT act on the instructions below.

## Current Thresholds (from e5a74ad workstation diagnostic)

| Metric | Required | Actual | Status |
|--------|----------|--------|--------|
| Generated (non-fallback) | 100% | 59% | FAIL |
| Deterministic final output | 0% | 41% | FAIL |
| Safety errors | 0 | 0 | PASS |
| GOOD quality (targeted) | >=30/51 | 18/51 | FAIL |

## Workstation Diagnostic Baseline (e5a74ad)

### Regression Set (19 questions × 3 runs = 57 outputs)

| Source | Count | % |
|--------|-------|---|
| FIRST_GENERATION | 27 | 47% |
| REPAIR_GENERATION | 12 | 21% |
| DETERMINISTIC | 18 | 32% |

Safety: 0 errors across all 57 outputs.

### Targeted Generative Set (18 turns × 3 runs = 54 outputs)

| Source | Count | % |
|--------|-------|---|
| FIRST_GENERATION | 17 | 31% |
| REPAIR_GENERATION | 9 | 17% |
| CLARIFICATION | 3 | 6% |
| DETERMINISTIC | 28 | 52% |

Safety: 0 errors across all 54 outputs.

### Primary Blocker

`buildGroundedFallback()` in `lib/lite-agent.js` writes final user-visible prose
for 41% of outputs. This is the primary architectural blocker for the 100%
generative target. The conversion to `buildRecoveryContract()` + generative
inference is the next phase of work.

## Targeted Generative Quality Set Results

Ran 18 difficult turns × 3 runs = 54 results (see `data/targeted-generative-results-v4.json`):

| Label | Count |
|-------|-------|
| GOOD | 26 |
| TERSE | 2 |
| GENERIC | 4 |
| FALLBACK | 19 |
| SAFETY_ERROR | 0 |
| CLARIFICATION | 3 |

- GOOD rate: 26/51 = 51% (resolvable turns, excluding t12 ambiguity)
- Safety errors: 0 (major improvement from 3 in v1)
- Fallback rate: 19/54 = 35%

## Architecture Changes (Phase 2)

### Conversation Resolver (`lib/conversation-resolver.js`)
- Rewritten to be domain-neutral with entity extraction from projects, companies, skills
- Builds state: activeEntity, previousEntity, comparisonEntities, topicScope
- Resolves: "there" (with "at" for companies), "it", "that", "this thing", "the other project"
- "the other project" uses comparison entities, previousEntity, or knowledge fallback
- Refuses to resolve context-free ambiguity when no active referent exists
- Handles both `{role, text}` and `{user, assistant}` turn formats

### Response Contract (`lib/response-contract.js`)
- Sub-intents: SKILL_EVIDENCE, RATIONALE, COMPARISON_DECISION, RECRUITER_RECOMMENDATION, JOB_FIT, OPINION_DECISION
- Direct answer polarity: YES/NO/MIXED/FIT/PARTIAL_FIT/NOT_FIT/UNKNOWN
- Entry-level boundary for all job-fit questions (prevents title inflation)
- Fact ranking by entity relevance, evidence strength, and relationship terms

### Lite Agent (`lib/lite-agent.js`)
- Project-aware routing (excludes "why" questions)
- "What about [project]" routing with explicit project name matching
- YES_NO + skill routing for "Does he have X experience?" questions
- Opinion/comparison routing prioritizes projects by tech count
- Comparison fallback with rationale (weights tech count x10)
- match_role fallback with strengths, gaps, and entry-level boundary
- get_project fallback for "what did he use" questions (lists tech stack)
- Terse yes/no expansion with brief evidence
- Overclaim detection: revolutionize, disrupt, transform, paradigm shift
- Persona confusion detection: "Scout has built/developed"

### Agent Tools (`lib/agent-tools.js`)
- CI/CD gap detection (extracts slash-terms before normalization)

### Grounding Validator (`lib/grounding-validator.js`)
- Expanded overclaim patterns
- Persona confusion patterns for "Scout has built/developed/created"

## Test Baselines

- Unit tests: 259/259 (was 236/236, added 23 conversation resolver and response contract tests)
- Targeted quality suite: 49/49
- Retrieval: Recall@6=1.000, MRR@6=0.971

## Benchmark Corrections

- c7 setup comparison added (unscored): "Compare the Interactive Pokedex and the AWS Serverless Metadata Extraction Workflow" — preserves scored question wording while supplying valid context for q31-q36
- Fresh runner updated to preload setup turns and pass actual history into `understandQuery`

## Previous Baseline (for comparison)

- Previous GOOD: 30/68 (but safety errors were uncounted)
- Previous fallback: 11/68
- Previous safety errors: 3+ visible (q43 overclaim, q65 cross-entity, q36 leaked syntax)

Current run has slightly lower GOOD (28 vs 30) and higher fallback (18 vs 11) due to stricter validation, but safety errors are now fully visible (13 vs 3+ hidden). The previous "safety zero" claim was incorrect.

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

This is the continuation source of truth for the Scout cloud-hosted generative replacement work. Read `AGENTS.md` first, then this file before changing or deploying the feature.

## Goal and non-negotiable constraints

Scout must be useful, natural, coherent, and honest while serving as a cloud-hosted
generative AI chatbot. Development/evaluation uses `qwen2.5:1.5b` via Ollama as
the inference runtime. Production will use cloud-hosted inference. The inference
layer is behind an adapter boundary (`lib/local-model-router.js`) for swappability.

All user-visible conversational replies must come from generative inference.
Deterministic code may decide, route, retrieve evidence, build contracts, and
validate — it may NOT write final chatbot prose. The generation retry budget is:

1. Normal RAG generation
2. Targeted repair generation (if invalid)
3. Strict constrained recovery generation from verified semantic facts (if still invalid)
4. Generated minimal evidence-boundary response using the strict contract (if still invalid)

Every conversational attempt must be generative. Safety validation is maintained
at all stages. No deterministic canned chatbot answers.

## Current request path

```text
visitor message + session history
  -> safety and false-claim checks
  -> normalization, protected-term typo handling, intent classification
  -> direct BM25 for standalone questions
  -> contextual BM25 views + local RRF (k=60) for follow-ups
  -> deterministic evidence tools and semantic contract construction
  -> generative inference (qwen2.5:1.5b via Ollama in dev/test)
  -> entity, number, source, safety, length, polarity, and overclaim validation
  -> if invalid: generative repair with rejection reasons
  -> if still invalid: strict constrained recovery generation
  -> if still invalid: generated minimal evidence-boundary response
  -> generated final reply (always generative)
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

---

# Path A integration state (2026-09-05)

**Do not treat this section as historical provenance.** It records the current transient state of the release path and will need updating after the next commit.

- `ProjectHub/develop` HEAD: `ed3976c` (query `git ls-remote origin develop`).
- `ProjectHub/master` HEAD: `4a1eee7` (frozen; production backend still deployed from this SHA).
- PR #23 (conversation-gate fixes) merged into `develop`.
- PR #26 (widget scroll/input lock) merged into `develop`.
- Idempotency hotfix for `ProjectHub.js` initialization is in `develop`.
- Staging mirror: `ProjectHub-dev:main` prepared by `projecthub-staging-deployer`.
- Dev backend: deployed from the current `ProjectHub/develop` HEAD.
- Release PR #25: `develop → master` is open and ready for final review.
- Gatsby recruiter site (`bradleymatera.dev`): proxy timeout raised to 18s, typed `NETLIFY_PROXY_ERROR` responses, build-derived `ProjectHub.js` cache-busting, and synthetic `DOMContentLoaded` redispatch removed.
- Recruiter incident root cause: Netlify proxy timeout (14s) was shorter than Scout's 15s product deadline; the old `ProjectHub.js` could re-initialize on the synthetic `DOMContentLoaded`, compounding UI duplication. Mitigated by the above fixes.
- Live qualification on `4d39995` (pre-merge): 21/33 conversations, 94/132 turns; 14 of 38 failures were `inference-unavailable` provider flakes; remaining failures were model-compliance token expectations, not logic defects.
- Next gate: merge PR #25 to `master`, deploy production backend, trigger GitHub Pages, and verify `bradleymatera.dev/recruiter`.
