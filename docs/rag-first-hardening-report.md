# RAG-First Hardening Report

**Branch:** `feat/rag-primary-restoration`  
**Final deployed commit:** `ed88387`  
**Dev endpoint:** `https://dev.projecthub-chat.bradleymatera.dev/api/chat`  
**Report date:** 2026-01-10

---

## 1. Objectives

Harden the RAG-first architecture by fixing four product-level problems:

1. **Never return a factually invalid answer** — only fully validated answers or a typed `TECHNICAL_ERROR` escape the RAG agent.
2. **Fix provider/cost accounting** — every real `generate` call is recorded in a canonical `generationCalls` array with provider, model, token and neuron metadata.
3. **Decouple BM25 retrieval from policy mode** — retrieval always runs for `/api/chat`, using the rewritten query.
4. **Remove absolute priority-tag ranking** — evidence is sorted by retrieval score with tag boosts only as tiebreakers.

---

## 2. Code changes

### 2.1 Factual safety and provider-call accounting (`lib/rag-agent.js`)

* `runRagPrimaryAgent` now enforces a strict acceptance pipeline:
  * Primary answer passes `validateAnswer` → return it.
  * Primary answer fails → **one** `FACTUAL_REPAIR` attempt.
  * Repair passes → return repair.
  * Repair fails/empty/failure → return a typed `inferenceUnavailable` result with `proseSource: 'TECHNICAL_ERROR'`.
  * No deterministic chatbot prose is emitted by the agent.
* `buildCallRecord` is called for both `PRIMARY` and `FACTUAL_REPAIR` generations, producing a `generationCalls` array with `attemptIndex`, `attemptType`, `provider`, `model`, `inputTokens`, `outputTokens`, `actualNeurons`, `estimatedNeurons`, `latencyMs`, `ok`, `accepted`, and `validationReasons`.
* `actualProviderCalls` is now derived from `generationCalls.length` (1 for a valid primary, 2 when repair is attempted).
* Diagnostic fields (`retrievalCandidates`, `selectedEvidence`, `toolEnrichment`, `rawPrimary`, `rawRepair`) are returned in the agent result and exposed via `agentMeta` so the natural-quality evaluator can inspect exactly what was retrieved and what the model produced.

### 2.2 BM25 retrieval decoupled from policy mode (`server-gemini.js`)

* The `NO_RETRIEVAL_MODES` gating was removed. `searchBm25WithRrf` is now invoked for every `/api/chat` request, always using `resolvedMessage` (the contextually rewritten query).
* The `resolvedMessage` is also passed as the `question` argument to `runRagPrimaryAgent`, ensuring both retrieval and generation use the same rewritten query.
* The brittle `forceSubstantive` keyword workaround is no longer needed.

### 2.3 Provider/cost accounting (`server-gemini.js`)

* `meterEvent` is called with the sum of `generationCalls` from `agentResult`, so `actualProviderCalls` exactly equals the number of real `localModelRouter.generate` invocations.
* `/api/costs` and telemetry now read the canonical `generationCalls` array, including repair attempts.

### 2.4 Evidence ranking (`lib/rag-agent.js`, `buildRagEvidenceText`)

* Removed absolute priority-tag sorting.
* `buildRagEvidenceText` now sorts primarily by `evidenceScore` and applies only small tag-based multipliers (`identity` 1.05, `summary` 1.04, `project` 1.03) as tiebreakers.
* Deduplication and source boundaries are preserved; the evidence budget stays small (≤ 1,100 chars, ≤ 6 items).

### 2.5 Focused unit tests (`test/rag-primary-safety.test.js`)

Added `node --test` cases covering the four factual-safety paths:

* A. Invalid primary + valid repair → repaired answer is returned.
* B. Invalid primary + invalid repair → no answer (`inferenceUnavailable`).
* C. Invalid primary + repair with fewer validation reasons → still rejected.
* D. Valid primary → exactly one provider call.

All pass.

---

## 3. Automated test results

| Suite | Result |
|-------|--------|
| `npm run test:retrieval` | 29/29 pass |
| `npm run eval-retrieval` | Recall@6 = 1.000 (40/40), MRR@6 = 0.954 — **PASS** |
| `npm test` (full suite) | 887/887 pass |
| `node --test test/rag-primary-safety.test.js` | 4/4 pass |

The full test suite includes the new portability test (`PROSE-REGRESSION: No Bradley-tenant-specific terms in runtime JS`), which caught a hardcoded Bradley/Davis prompt example in `lib/rag-agent.js`; that was fixed in commit `ed88387`.

---

## 4. Natural quality evaluation

### 4.1 Method

* Script: `scripts/eval-natural-quality.js`
* Target: dev backend `https://dev.projecthub-chat.bradleymatera.dev/api/chat`
* 12 recruiter-style questions, each with a fresh session, 35 s timeout, 4 s spacing.
* For each question the script records:
  * `rewrittenQuery`
  * `promptTokens` (`agentMeta.contextTokens`)
  * top 10 `retrievalCandidates` with `evidenceScore`
  * `selectedEvidence` sent to the model
  * `toolEnrichment`
  * `rawPrimary` and `rawRepair` answers
  * `primaryValidation` / `repairValidation`
  * `generationCalls` (with token/neuron accounting)
  * `latencyMs`, `proseSource`, `provider`, `model`
* Raw output: `data/eval-natural-quality.json`

### 4.2 Aggregate results

| Metric | Value |
|--------|-------|
| Successful replies | 7 / 12 |
| `TECHNICAL_ERROR` (`INFERENCE_UNAVAILABLE`) | 5 / 12 |
| Avg latency | 870 ms |
| Avg prompt tokens | 666 |
| Avg provider calls | 1.57 |
| Provider | `cloudflare` / `@cf/meta/llama-3.2-3b-instruct` |

### 4.3 Manual review per question

Scale: 1–4 (4 = best). Retrieval and grounding are judged from the returned evidence packet; usefulness and naturalness are judged from the final `reply`.

| # | Question | Status | Reply (truncated) | Retrieval | Grounding | Useful | Natural | Notes |
|---|----------|--------|-------------------|-----------|-----------|--------|---------|-------|
| 1 | Tell me about Bradley's AWS experience. | **FAIL** | *technical error* | 4 | 1 | 1 | 1 | Raw primary was a correct, evidence-backed summary but was rejected: `unsupported_relationship:Bradley Matera\|has_degree\|internship` and `...\|has_cert\|AWS experience`. Claim-extractor mis-parsed valid phrasing. |
| 2 | What did he actually do during his AWS internship? | **OK** | "Bradley worked on guided troubleshooting labs and support engineering training during his AWS Cloud Support Engineer internship." | 4 | 4 | 4 | 4 | Grounded in `aws-experience` and `aws-production-tickets` chunks. |
| 3 | What has he built with React? | **OK** | "ProjectHub" | 4 | 4 | 3 | 2 | Correct but extremely terse; repair shortened a longer, more helpful primary. |
| 4 | What did he use TypeScript for? | **FAIL** | *technical error* | 3 | 1 | 1 | 1 | Raw answers (`"...TypeScript for building scalable..."`, `"...TypeScript for coding..."`) were rejected as `unsupported_relationship:Bradley\|uses_tech\|TypeScript`. The graph has `has_skill` for TypeScript, but `uses_tech` is only project→tech. |
| 5 | How does ProjectHub work? | **FAIL** | *technical error* | 3 | 1 | 1 | 1 | Raw repair was a faithful paraphrase of the `[projecthub-tech]` direct answer, but was rejected for `unsupported_tech_claim:vanilla JavaScript` and `project_relationship` on generic HTML/CSS/GitHub. Evidence is in a direct-answer chunk, not the relationship graph. |
| 6 | Compare ProjectHub with the AWS capstone. | **OK** | "ProjectHub is a chat widget that embeds with one script tag, whereas the AWS capstone project is a comprehensive interns..." | 4 | 3 | 4 | 4 | Mostly grounded; one call succeeded this run (stochastic). |
| 7 | What experience does he have that could transfer to ERP support? | **FAIL** | *technical error* | 4 | 1 | 1 | 1 | Evidence includes the Helm ERP role and healthcare-adjacent experience, but the validator rejected the primary for `unsupported_relationship:Bradley Matera\|has_degree\|roles`. |
| 8 | What are his strongest technical areas? | **OK** | "JavaScript,TypeScript,React,Node.js,HTML,CSS,SQL,AWS support training" | 4 | 4 | 3 | 2 | Mirrors the FAQ answer but is a comma-separated list rather than a sentence. |
| 9 | What are some things he still needs to learn? | **OK** | "Bradley still needs to learn about repetition." | 3 | 2 | 2 | 2 | Evidence mentions "depth he still needed to build through repetition"; the model over-simplified this to "repetition" and dropped the other gap areas. |
| 10 | Does he know Rust? | **OK** | "No, that language is not one of Bradley's documented skills." | 4 | 4 | 4 | 4 | Clean yes/no denial grounded in `[rust-not-documented]`. |
| 11 | He worked at Google, right? | **FAIL** | *technical error* | 3 | 1 | 1 | 1 | The model produced a correct denial (`"No, there is no verified record..."`) but the validator flagged `entity_not_grounded:Google` even though the question itself contains "Google". |
| 12 | Based on his actual experience and projects, what kind of role fits him? | **OK** | "Based on Bradley's experience in cloud support training, AWS internship training, and capstone project, as well as his r..." | 4 | 4 | 4 | 4 | Synthesises multiple evidence chunks; well grounded. |

**Average manual scores:**

* Retrieval: 3.58 / 4
* Grounding: 2.25 / 4 (heavily penalised by the 5 technical errors)
* Usefulness: 2.33 / 4
* Naturalness: 2.25 / 4

---

## 5. Findings

### 5.1 What is working

1. **No factually invalid answers escape.** Every rejected answer is replaced by the typed `INFERENCE_UNAVAILABLE` reply. There is no deterministic chatbot fallback and no raw invalid prose in `reply`.
2. **Provider accounting is correct.** `actualProviderCalls` matches the length of `generationCalls` in all observed cases, including the one-call success and two-call repair paths.
3. **BM25 always runs.** The top-10 retrieval candidates are returned for every question, regardless of policy mode.
4. **Evidence is score-sorted.** No absolute tag priority was observed; candidates are returned in BM25/RRF score order with modest tag-based tiebreaking.
5. **Retrieval quality is still excellent.** Offline `Recall@6 = 1.000` and `MRR@6 = 0.954` are unchanged.
6. **All 887 local unit tests pass**, including the new focused safety tests and the portability regression suite.

### 5.2 What is blocking merge

The strict factual-safety gate is **over-rejecting factually correct answers** because the relationship and entity validators are too narrow:

* **Person technology claims** (`Bradley uses TypeScript`) are extracted as `uses_tech` and rejected, even though the graph has `has_skill` for TypeScript.
* **Project technology claims** from `direct-answer`/`faq` chunks (e.g. "ProjectHub uses vanilla JavaScript, HTML/CSS, GitHub Pages") are rejected because the relationship graph is built only from `projects[].tech` and does not include the canonical direct-answer facts.
* **Generic web technologies** (`HTML`, `CSS`, `GitHub`, `GitHub Pages`) trigger `project_relationship` cross-project provenance errors even though they are common to almost every web project.
* **Entities that appear in the user's own question** (e.g. "Google") are flagged as `entity_not_grounded` when the answer repeats them to deny the false premise.
* **Spurious `has_degree` / `has_cert` extractions** mis-parse valid answers such as "Bradley has AWS experience from an internship and holds AWS certifications".

The result is a **7/12 natural-question success rate**, which is below the threshold for a recruiter-facing release. Two runs produced slightly different pass sets (q06 and q01 swapped between runs), indicating the gate is not only strict but also somewhat brittle to model phrasing.

---

## 6. Recommendations

The four requested hardening changes are **complete and tested**. Before merging `feat/rag-primary-restoration` into `develop`, the following validator improvements should be addressed:

1. **Person `uses_tech` → `has_skill` mapping** in `lib/claim-extractor.js` when the subject is the candidate.
2. **Source-text-aware validation** for `uses_tech` and `project_provenance` so that evidence from `direct-answer` and `faq` chunks is considered authoritative.
3. **Generic tech safe list** (`HTML`, `CSS`, `GitHub`, `GitHub Pages`, `vanilla JavaScript`) for project-provenance checks.
4. **Question-aware entity grounding** so that entities the user asks about are not flagged as fabricated when the answer denies the premise.
5. **Tighter `has_degree` / `has_cert` claim extraction** so that phrases like "from an internship" or "holds AWS certifications" are not misclassified.

After those fixes, re-run `scripts/eval-natural-quality.js` until the success rate is consistently ≥ 10/12 with no spurious `TECHNICAL_ERROR` replies.

---

## 7. Overall readiness

| Area | Status |
|------|--------|
| Factual-safety architecture | **Ready** |
| Provider/cost accounting | **Ready** |
| BM25 retrieval always-on | **Ready** |
| Evidence ranking (no absolute tag priority) | **Ready** |
| Unit test coverage | **Ready** (887 pass) |
| Natural-question end-to-end quality | **Not ready** — 7/12 due to validator false positives |
| Merge to `develop` | **Not recommended yet** |

The branch has the correct hardening structure, but the underlying validators need tuning so the stricter safety gate does not routinely reject correct, evidence-backed answers.
