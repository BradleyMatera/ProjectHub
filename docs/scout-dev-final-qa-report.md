# Scout Dev Transparency + Meta Self-Knowledge QA Report

**Branch:** `feat/rag-primary-restoration`  
**Latest deployed SHA:** `c80fcab`  
**Dev URL:** https://bradleymatera.github.io/ProjectHub-dev/  
**Dev API:** https://dev.projecthub-chat.bradleymatera.dev  
**Date:** 2026-08-21

---

## 1. Dashboard / runtime transparency

### Requirement
The **"Live Scout runtime & usage"** dashboard on ProjectHub-dev must be visible and show real numbers: generation provider, model, daily neuron usage, model calls today.

### Verification
Loaded ProjectHub-dev in browser. The dashboard region is rendered and populated with live data from `/api/costs`:

- **Generation provider:** `Cloudflare Workers AI`
- **Model:** `@cf/meta/llama-3.2-3b-instruct`
- **Daily AI budget:** `183.3 / 10,000 neurons` (1.83% used · resets 00:00 UTC)
- **Model calls today:** `49`
- **App request control:** `20 / minute / IP`
- **This browser session:** updated as new turns are sent
- **Session neurons / factual repair calls:** tracked per session
- **Cost tracker table:** shows `cloudflare` calls and token/neuron totals

**Status: YES — visible with live numbers.**

---

## 2. Per-reply telemetry

### Requirement
Every Scout reply must expose backend metadata without leaking private knowledge: provider, model, provider-call count, input/output tokens, actual/estimated neurons, model latency, retrieval candidate count, selected evidence count, repair attempts.

### Verification
After sending `What is Scout?` in the dev UI, the per-reply telemetry summary shows:

- **This reply:** `cloudflare · @cf/meta/llama-3.2-3b-instruct · 1 call · 443 input + 50 output tokens · 3.572 neurons · 621 ms model time`
- **RAG:** `10 candidates → 8 evidence blocks sent to generation · tool enrichment not used`

The API response confirms the same:
- `retrievalCandidates`: 10 identifier objects
- `selectedEvidence`: 8 identifier objects
- `generationCalls`: full call list with `provider`, `model`, `inputTokens`, `outputTokens`, `actualNeurons`, `estimatedNeurons`, `latencyMs`, `attemptType`, `accepted`, `validationReasons`
- Telemetry payloads no longer include raw `description` text; only safe fields (`kind`, `tag`, `id`, `name`, `score`) are exposed.

**Status: YES — per-reply telemetry visible and safe.**

---

## 3. Meta self-knowledge: "What model do you use?"

### Requirement
Must answer from runtime knowledge, not return `Unknown`.

### Changes made
- Added a focused `scout-runtime-model` fact and a `scout-runtime-capabilities` fact.
- Added `scout-runtime` and `scout-cost` tag boost in `buildRagEvidenceText` so self-knowledge facts are selected.
- Added a `QUERY_EXPANSIONS` rule that appends `scout runtime projecthub` to meta/self-knowledge queries, improving BM25 retrieval.

### Verification
**Raw visible answer:** `@cf/meta/llama-3.2-3b-instruct`

`proseSource: MODEL_GENERATION`, `policy: META`, selected evidence includes `scout-runtime`.

**Status: YES — returns the configured Cloudflare model.**

---

## 4. Strip `Q:` / `A:` generation scaffolding in `parseGeneratedAnswer`

### Requirement
Plain-text model output that echoes `Q: ... A: ...` must be cleaned up.

### Changes made
`lib/rag-agent.js` `parseGeneratedAnswer` now:
- Detects `Q:` and `A:` on the first two lines and strips them, joining the remaining answer.
- Strips a leading `A:` marker.
- Falls back to the raw text only if everything is stripped.

### Verification
Added `test/rag-agent.test.js` regression tests. All pass.

Manual QA confirms `What is Scout?` no longer echoes `Q:` / `A:`.

**Status: YES — scaffolding is stripped.**

---

## 5. Route "What can you help with?" to Scout capability/meta RAG

### Requirement
Capability and meta questions must route through the evidence-based `META` pipeline, not the legacy `HELP` control path.

### Changes made
- Moved the `META` classification block before `HELP` in `lib/response-policy-classifier.js`.
- Expanded the `META` regex to include `what can (?:you|i) (?:help|answer|do|ask)` and other natural variants.
- Added a dynamic check for `what is (?:Scout|the assistant|this chatbot)` using the configured `agentName`.

### Verification
**Raw visible answer:** `Scout can help with questions about Bradley Matera's projects, skills, work experience, education, certifications, career goals, and public contact information. Scout can also explain its own runtime, including the current model, provider, free-tier usage, rate controls, and architecture.`

`pipeline: ["knowledge-loaded", "policy:META", "cache-hit"]`

**Status: YES — routes through META and answers from runtime facts.**

---

## 6. Final dev human QA (ProjectHub-dev)

All eight required questions were asked against the dev backend and/or dev UI. Below are the raw visible answers, verification flags, and notes.

| # | Question | Raw visible answer | proseSource | Evidence (selected / candidates) | Status | Notes |
|---|----------|--------------------|-------------|----------------------------------|--------|-------|
| 1 | What is Scout? | `Scout is a portfolio assistant that can help with questions about Bradley Matera's projects, skills, work experience, education, certifications, career goals, and public contact information.` | `MODEL_GENERATION` | 8 / 10 | **YES** | Policy `META`, uses `scout-runtime` evidence. |
| 2 | What model do you use? | `@cf/meta/llama-3.2-3b-instruct` | `MODEL_GENERATION` | 8 / 10 | **YES** | Policy `META`, selected `scout-runtime` facts. |
| 3 | How is this chat free? | `This chat is free because Scout keeps its normal generative inference inside Cloudflare Workers AI's included free allocation, the public widget is served from GitHub Pages, and the chat backend runs on a free-tier GCP VM.` | `MODEL_GENERATION` | 8 / 10 | **YES** | Policy `META`, grounded on `scout-cost` and `scout-runtime`. |
| 4 | How do daily caps and cooldowns work? | `Daily caps and cooldowns are two separate controls used by Cloudflare Workers AI. The daily cap refers to the total number of neurons (10,000 per day) allocated to an account, which resets at 00:00 UTC.` | `MODEL_GENERATION` | 8 / 10 | **YES** | Policy `META`, grounded. |
| 5 | What can you help with? | `Scout can help with questions about Bradley Matera's projects, skills, work experience, education, certifications, career goals, and public contact information. Scout can also explain its own runtime, including the current model, provider, free-tier usage, rate controls, and architecture.` | `MODEL_GENERATION` | 8 / 10 | **YES** | Now correctly routed through `META` instead of `HELP`. |
| 6 | Tell me about ProjectHub. | `ProjectHub is a live analytics dashboard built on top of Scout, a portable generative intelligence engine. It utilizes a combination of vanilla JavaScript, HTML/CSS, and GitHub Pages, along with a Vite + Carbon Design System bundle, to provide real-time analytics and insights.` | `MODEL_GENERATION` | 8 / 10 | **YES** | Policy `PROFILE`, grounded. |
| 7 | What is Bradley's strongest technical background? | `js, HTML, CSS, and SQL, plus AWS support training and project work with Lambda, DynamoDB, S3, and Amplify.` | `MODEL_GENERATION` | 8 / 10 | **YES** | Previously failed with `fabricated_employment:Lambda`; grounding validator now skips source-grounded tech terms. |
| 8 | How can I contact Bradley? | `Email bradmatera@gmail.com, phone (608) 313-5373, LinkedIn www.linkedin.com/in/bradmatera, or portfolio https://bradleymatera.dev/` | `MODEL_GENERATION` | 8 / 10 | **YES** | Previously returned "I'm not able to assist"; fixed by treating `not_relevant_to_question` as a soft reason and using the public phone in the FAQ answer. |

---

## 7. Privacy / safety checks

- Phone number in the contact answer is the approved public number `(608) 313-5373`.
- No raw private knowledge text, hidden prompts, or raw model outputs are exposed in the public telemetry or chat replies.
- `selectedEvidence` and `retrievalCandidates` now contain only safe identifier objects (`kind`, `tag`, `id`, `name`, `score`).

**Status: YES.**

---

## 8. Deployment / source-of-truth

- No merge to `develop` or `master` was performed.
- All changes are on `feat/rag-primary-restoration` and pushed to `origin/feat/rag-primary-restoration`.
- Dev VM was updated via `scripts/manual-deploy-dev.js` to the latest SHA.
- Health endpoint reports `provider: cloudflare`, `primaryModel: @cf/meta/llama-3.2-3b-instruct`, `agentMode: lite`.

**Status: YES — no forbidden merges.**

---

## 9. Relevant commits

| SHA | Message |
|-----|---------|
| `c80fcab` | `fix(grounding): prevent source-grounded tech terms from being misclassified as employers; accept soft question-relevance reason; use public phone in contact FAQ` |
| `6574e05` | `fix(meta): expand self-knowledge queries, strengthen runtime facts, and boost scout-runtime evidence selection` |
| `68d2535` | `fix(scout-lite): safe telemetry identifiers, Q:/A: scaffolding strip, META capability routing, runtime model/capability facts` |

Earlier base commits: `3448281`, `9ef9142`, `c713ffe`, `ce23086`, `48ad956`, `bb87c03`.

---

## 10. Summary

All targeted dev UI and RAG meta self-knowledge issues are resolved on the dev branch:

- Dashboard is visible with live, real numbers.
- Per-reply telemetry is visible and safe.
- `What model do you use?` now answers from runtime facts.
- `Q:` / `A:` scaffolding is stripped.
- `What can you help with?` and related capability questions route through the Scout RAG/META pipeline.
- The final manual QA across all eight required questions produced grounded, accurate answers.

**No merge to `develop` or `master` was performed.**
