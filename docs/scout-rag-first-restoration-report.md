# SCOUT RAG-FIRST RESTORATION REPORT

**Status:** Dev validated (branch `feat/rag-primary-restoration`)  
**Scope:** Backend chat agent only — no production promotion.  
**Production remains frozen on `master`.**

---

## 1. Phase 1 — Context-loss instrumentation

### 1.1 What was traced

`scripts/trace-rag-loss.js` instruments the existing `runLiteAgent` path with a stubbed `router.generate` so every prompt, retrieval result, and tool step is captured for 10 natural substantive questions.

Traced fields per question:

- original question
- rewritten query
- BM25/RRF top results (chunk tag, title, score, text snippet)
- preRoute operation + tool + args
- tool result and compressed tool evidence length
- supplement gate firing decision
- final facts text length and source overlap
- prompt section sizes
- estimated prompt tokens
- validation verdict

### 1.2 Key finding: RAG evidence was dropped before generation

| metric | value |
|---|---|
| avg retrieved chunks | 8.0 |
| avg dropped chunks | 7.7 |
| supplement gate fired | 2 / 10 |
| avg base instruction chars | 732 |
| avg response contract chars | 160 |
| avg answer plan chars | 116 |
| avg relationship chars | 40 |
| avg facts chars | 231 |
| avg total prompt tokens | 452 |

The final `FACTS` section was built from the **compressed tool result**, not from the BM25/RRF evidence. Because the supplement gate only opens when compressed tool evidence is `< 200 chars`, 8 of 10 substantive questions saw **all retrieved RAG chunks dropped**. The prompt was dominated by the response contract/plan, while the actual retrieved facts were discarded.

---

## 2. Phase 2–7 — Architectural changes implemented

A new RAG-first execution module was introduced and wired into `server-gemini.js` for `SCOUT_AGENT_MODE=lite`. The old deterministic path is preserved only as an optional fallback; the default runtime path is now RAG-first.

### 2.1 Files added/changed

| file | purpose |
|---|---|
| `lib/rag-agent.js` | new RAG-first agent: retrieval primary, tools as enrichment, simplified prompt, factual validation |
| `server-gemini.js` | call `runRagPrimaryAgent` for lite mode; direct-KB short-circuit now opt-in; retrieve 10 BM25 candidates instead of 5 |
| `lib/rag-chunks.js` | include `directAnswers` as retrievable chunks so direct facts flow through RAG instead of bypassing generation |
| `scripts/trace-rag-loss.js` | Phase-1 instrumentation of old path |
| `scripts/trace-rag-primary.js` | prompt/retrieval verification for new path |
| `scripts/eval-natural.js` | 24-question natural chat evaluation against the dev backend |
| `scripts/dev-logs.js` | helper to pull dev VM logs |
| `scripts/manual-deploy-dev.js` | now supports deploying any clean branch to the dev VM |
| `.gitignore` | ignore generated `data/trace-*.json` artifacts |

### 2.2 RAG evidence is now primary

- The server retrieves **10 BM25/RRF candidates** and passes them to the agent.
- `buildRagEvidenceText` ranks chunks, deduplicates, and formats them as `FACT n [source]\n...`.
- Tag boosting and priority ordering ensure identity, summary, education, experience, project, and skill chunks surface above noisy blog/source/boundary text.
- Direct-answer records are indexed as retrievable chunks, so canonical facts participate in ranking instead of short-circuiting the model.

### 2.3 Tools are supplemental enrichment only

- `preRoute` still selects a tool, but its output is compressed to a short `ENRICHMENT` block (`≤ 300` chars).
- `search_portfolio` enrichment is suppressed because RAG already covers portfolio search.
- Comparison and role-fit tools still provide structured enrichment when selected.

### 2.4 Prompt simplified

Old prompt sections removed from the substantive path:

- verbose response-contract prose instructions
- full answer-plan constraints
- relationship-fact block
- complex recovery/repair templates

New prompt structure:

```
You are Scout, Bradley Matera's portfolio assistant.
<compact task rules>
EXAMPLE: <one-shot JSON example>
CONVERSATION: <optional recent turns>
GUARDRAILS: <only when needed>
EVIDENCE:
FACT 1 [source]
...
ENRICHMENT: <optional tool summary>
Q: <question>
Return JSON: {"answer":"..."}
```

### 2.5 Validator narrowed to factual guardrails

- `validateAnswer` is still called, but only hard factual issues (entity grounding, employment/fabrication, overclaim, contradiction, scope) are treated as failures.
- Stylistic and benchmark-style rejections are filtered out of the RAG agent’s go/no-go decision.
- One factual repair attempt is performed only when a real factual problem is detected.

### 2.6 Direct KB audited and disabled for substantive turns

- The `findDirectAnswer` short-circuit is now controlled by `SCOUT_DIRECT_KB_ENABLED` and is **off by default**.
- Direct answers are indexed as RAG chunks so the model still sees them, but every user-visible reply is now generated.
- Control turns (greeting, thanks, help, out-of-scope, etc.) still use the small control prompt.
- A keyword guard (`bradley|matera|recruiter|portfolio|project|experience|skill|role|job|summary|developer|engineer`) forces substantive routing when the policy classifier mislabels a candidate question as control.

### 2.7 Cost/observability design

- Average dev latency: **669 ms** end-to-end for substantive questions.
- Average prompt tokens: **~661 tokens** (Cloudflare 3B).
- One provider call per turn; repair only on factual failure.
- Cost ledger and `/api/costs` infrastructure remain untouched.

---

## 3. Phase 8 — Natural evaluation on dev backend

`scripts/eval-natural.js` posts 24 recruiter-style questions to `https://dev.projecthub-chat.bradleymatera.dev/api/chat` with a 4 s delay to respect rate limits.

### 3.1 High-level results

| metric | value |
|---|---|
| questions | 24 |
| successful replies | 24 / 24 |
| technical errors | 0 |
| avg latency | 669 ms |
| avg context tokens | 661 |
| proseSource | `MODEL_GENERATION` for all non-control turns |

### 3.2 Notable per-question samples

| id | category | question | reply excerpt |
|---|---|---|---|
| n01 | profile | Tell me about Bradley. | "Bradley Matera is an early-career software engineer based in Davis, Illinois. His background is in web development, AWS ..." |
| n06 | project | What is ProjectHub? | "ProjectHub is an embeddable, AI-powered recruiter chat widget and portfolio site ..." |
| n09 | skill | Has he used React? | "Yes, Bradley knows React. He has used it in ProjectHub and other projects." |
| n19 | adversarial | He was a senior AWS engineer, right? | "No, Bradley Matera was not a senior AWS engineer. Public evidence does not document those roles." |
| n23 | natural | Can you give me a quick recruiter summary? | "Bradley Matera is an early-career software engineer with a background in web development, AWS support engineering training ..." |
| n24 | control | Hi, how are you? | "I'm doing great, thanks for asking! How can I assist you today?" |

### 3.3 Known remaining quality gaps

- A few answers still read as lists/fragments rather than full prose (e.g., strongest skills, school answer). This is mostly small-model behavior under the strict brevity budget.
- Negative-assessment questions sometimes return the gap label rather than a full sentence.
- The model occasionally starts a project description mid-sentence when the retrieved chunk begins with a description clause.
- These are prompt/formatter refinements, not architecture regressions; all answers are now grounded in retrieved evidence.

---

## 4. Phase 9 — What was NOT changed

Per the task constraints, the following were intentionally avoided:

- No new qualification suite beyond the 24-question natural eval.
- No scorer tuning or regex patches to pass old benchmark wording.
- No model shopping; still on Cloudflare `@cf/meta/llama-3.2-3b-instruct`.
- No production deploy or merge to `master`.

---

## 5. Next steps recommended

1. **Human review** of the 24 dev answers in `data/eval-natural-results.json` to decide if quality is acceptable for a `develop` PR.
2. **Tighten answer formatting** for list/fragment edge cases (skills, school, gaps) with a small deterministic post-processor or stronger example prompts.
3. **Merge `feat/rag-primary-restoration` into `develop`**, then run the existing lightweight smoke/retrieval tests.
4. **Stage via `BradleyMatera/ProjectHub-dev:main`** and validate the embedded widget.
5. Only after staging sign-off, open the `develop → master` release PR and deploy production backend + Pages.

---

## 6. How to reproduce

```bash
# Phase 1 trace of old path
node scripts/trace-rag-loss.js

# New path prompt/retrieval trace
node scripts/trace-rag-primary.js

# Natural dev evaluation
node scripts/eval-natural.js

# Dev backend deploy from the current branch
node scripts/manual-deploy-dev.js
```

Dev backend health: `https://dev.projecthub-chat.bradleymatera.dev/health`  
Current deployed branch: `feat/rag-primary-restoration` (`973eac4`)
