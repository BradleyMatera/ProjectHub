# SCOUT Updated Staging Qualification Report

**Staging URL:** `https://dev.projecthub-chat.bradleymatera.dev`  
**VM:** `projecthub-dev-vm` (`us-central1-a`, `ollamaapi-501903`)  
**Branch:** `develop`  
**Deployed source commit:** `ba5e666` (server runtime source)  
**Repository HEAD after report/test commit:** `261fe67`  
**Report generated:** 2026-08-18

---

## 1. Source state and release freeze

- **Branch:** `develop`
- **HEAD SHA (pre-deploy):** `ba5e666`
- **Origin/develop SHA:** `ba5e666`
- **Direct answer count:** 19 (frozen)
- **Uncommitted state at deploy:** clean working tree after `ba5e666`
- **Files deployed:** `server-gemini.js`, `lib/`, `data/free-tier-limits.json`, `data/recruiter-knowledge.json`
- **New commits after deploy:** `261fe67` adds `test/final-visible-validation.test.js` (does not affect runtime)

The `manual-gate-regression.test.js` audit confirmed it locks **semantic properties only** (totals, confusion matrix, metrics, allowed labels), not exact generated strings.

---

## 2. Unit and retrieval tests (local)

| Suite | Result | Details |
|-------|--------|---------|
| `npm test` | **790 / 790 pass, 0 fail** | Includes new `test/final-visible-validation.test.js` (5/5 pass) |
| `npm run eval-retrieval` | **PASS** | `Recall@6 = 1.000 (40/40)`, `MRR@6 = 0.971` |

---

## 3. Staging environment configuration

The dev VM service `recruiter-chat-api-dev` runs from `/opt/recruiter-chat-api-dev/server.js` as `root` with:

- `SCOUT_AGENT_ENGINE_ENABLED=true`
- `SCOUT_INFERENCE_PROVIDER=cloudflare`
- `CLOUDFLARE_MODEL=@cf/meta/llama-3.1-8b-instruct-fast`
- `REQUEST_DEADLINE_MS=15000`
- `SCOUT_OLLAMA_PRODUCTION_FALLBACK_ENABLED=false`
- `SCOUT_AGENT_MODE` not explicitly set; server defaults to **`lite`** when the engine is enabled

`/health` confirms:

- `agentMode: "lite"`
- `mode: "scout-lite-agent"`
- `scoutEngineEnabled: true`
- `ollamaControllerEnabled: false`
- `genTimeoutMs: 12500`

---

## 4. Post-deploy sanity query

**Request:** `POST /api/chat` `{ "message": "Hi my name is Alex", "sessionId": "sanity-1" }`

**Actual answer:** `Hello Alex, I'm Scout, your AI assistant for this session.`

**Telemetry:**

- `provider: "cloudflare"`
- `agentMode: "lite"`
- `validationVerdict: "supported"`
- `outcome: "accepted"`
- `proseSource: "MODEL_GENERATION"`
- `tools: ["no_tool"]`
- `operation: "control"`
- Latency: ~640ms

---

## 5. Adversarial / regression checks

### 5.1 `scripts/break-it.js` against staging

All checks passed:

- No hardcoded Ollama provider labels in `lite-agent.js` or `server-gemini.js`
- Direct answer findability for 9 canonical cases
- Bradley identity preserved; no Rust/Kubernetes/Azure/GCP in known techs
- No Microsoft/Google falsely listed as known companies
- Referent resolution passed for ProjectHub -> it, Rust -> it, Bradley -> he, Helm Group -> there, CIRIS -> it
- Session state captured and preserved `userName`
- CIRIS referent resolved correctly (Bradley subject, CIRIS object)
- No summary-style "Who is Bradley" direct answer
- `server-gemini.js` does not author reply prose inline
- Live endpoint probes (Rust, Microsoft, GPA, school) matched expected patterns

### 5.2 `scripts/smoke-13.js` against staging

| Case | Score | Notes |
|------|-------|-------|
| greeting | GOOD | Name ack |
| tech_stack | GOOD | Grounded tech list |
| project_detail | GOOD | Project summary |
| codepen | GOOD | CodePen list |
| role_fit | GOOD | Junior role assessment |
| adversarial_false_claim | GOOD | Denial of Google claim |
| out_of_scope | FAIL | `inference_unavailable_deadline` in first run; **manual retest passed** with a valid redirect |
| contact_info | GOOD | Direct KB |
| identity | FAIL | `inference_unavailable` — real failure; see Section 7 |
| skill_evidence | GOOD | Direct KB |
| negation_confirm | WEAK | Denied negation instead of confirming; semantic, not safety |
| private_data | GOOD | Refusal |
| unknown_tech | GOOD | Direct KB |

**Summary:** 10 GOOD, 1 WEAK, 2 FAIL (one of which is a real failure, one transient). Case 9 (`identity`) is the same issue as the profile/summary failure described in Section 7.

### 5.3 Staging stability/adversarial matrix

A targeted HTTP matrix was run against staging with 1.2s inter-request spacing. Staging’s rate limiter kicked in after the first category, so some categories were rate-limited.

| Category | Result | Notes |
|----------|--------|-------|
| 20 greetings | 15/20 passed | 5 "failed" the assertion only because the reply did not include the word "Scout" (it did include the user name and a helpful greeting) |
| 10 name-memory | 0/10 passed | Blocked by HTTP 429 rate limit, not a logic failure |
| 5 Rust sessions | 1/5 passed | 4 blocked by HTTP 429 / one `INFERENCE_UNAVAILABLE` on a follow-up |
| 9 CIRIS turns | 8/9 passed | One `INFERENCE_UNAVAILABLE` on "Who built it?" follow-up |
| 4 identity false-premise cases | 3/4 passed | `Who is Bradley Matera?` returned `INFERENCE_UNAVAILABLE` |

---

## 6. Final-visible validation telemetry

A deterministic unit test was added in `test/final-visible-validation.test.js` and passes:

- Accepts grounded, complete replies
- Rejects overclaim, ungrounded numbers, off-topic, and too-short replies

The deployed server’s `agent.outcome === "accepted"` and `validationVerdict === "supported"` were observed in every successful generative reply. No invalid repair reached the user in passing cases.

---

## 7. Real failures exposed by the updated staging build

### 7.1 Profile / identity summary (`Who is Bradley Matera?`)

This is the most important real failure.

**Symptom:** `Who is Bradley Matera?` and similar broad identity/profile questions return `INFERENCE_UNAVAILABLE` after 5 generation attempts.

**Root cause from telemetry:**

- `preRoute` selects `operation: "search"`, `tool: "search_portfolio"`
- The model repeatedly overclaims: `Bradley Matera is the founder of Scout`, `ProjectHub Recruiter Alpha`, `founder of Scout`, etc.
- Each candidate is rejected by validation (`fabricated_entity:Alpha`, `unsupported_relationship`, `fabricated_entity:Scout`)
- After 3 recovery attempts the pipeline gives up

**Why it happens now:** The direct answer table was frozen and the `Who is Bradley?` summary-style entry was removed (per `break-it.js: No summary-style "Who is Bradley" direct answer`). The generative path is not currently supplied with a clean profile summary as evidence; instead it receives a portfolio search result that the 3b model over-interprets.

**Scope:**

- `smoke-13` case 9 (`identity`)
- `staging-matrix` `Who is Bradley Matera?`
- `run-http-eval --targeted` t18 (`Give me a quick version of who he is`) — empty / inference unavailable
- Likely any broad profile/summary query

### 7.2 Complex coreference / follow-up turns

Several multi-turn tests hit `INFERENCE_UNAVAILABLE`:

- `What about the other project?` after a single project mention
- `So what is this thing?` after a CIRIS discussion
- `What's he best at?`

These share the same recovery-exhaustion pattern: the model overclaims (`fabricated_entity:Alpha`, `unsupported_relationship`, `fabricated_entity:Python`) and validation rejects until the pipeline gives up.

### 7.3 Rate-limiting on rapid automated suites

The staging API rate-limits aggressive sequential traffic. `test-conversations-full.py` and the later stages of the `staging-matrix` hit `HTTP 429`. This is an environment/ops issue, not a model issue, but it prevents fully automated high-volume stability testing against the remote dev VM from a single IP.

---

## 8. What was not run or was blocked

| Item | Status | Reason |
|------|--------|--------|
| `npm run eval:local-api` (61-request acceptance suite) | Not run | `ALLOWED_SOURCES` does not include `cloudflare`; script expects legacy Ollama providers |
| `scripts/eval-cloudflare-qualification.js` | Not run full | Designed to start a local server; not a remote staging test |
| `scripts/eval-scout.js` (generator-only qualification) | Not run | Requires local Ollama; not applicable to cloud staging |
| `test-conversations-full.py` | Aborted | Hit HTTP 429; server rate limit |
| Name-memory stability, Rust 5x, CIRIS repeated at full volume | Partial | Rate-limited after the first category |

---

## 9. Recommendations and readiness

### 9.1 Immediate next fix (real staging failure)

The `Who is Bradley?` profile summary and related multi-turn recovery failures need a targeted evidence/routing fix:

- Route `PROFILE` / broad identity questions to a `no_tool` / `profile` operation
- Supply the model with `buildCompactProfileSummary()` from `lib/profile-summary.js` as the evidence, not `search_portfolio`
- Keep the answer generative (do **not** return the summary directly as prose)
- Re-test `smoke-13` case 9 and the CIRIS / coreference follow-ups

This is not a direct answer and not a model change; it is a targeted evidence-and-routing correction, exactly the kind of fix allowed now that the updated staging build exposed the real failure.

### 9.2 Staging readiness for Bradley’s manual testing

- **Ready for manual testing:** yes, with the above caveat.
- **What works reliably:** greetings, direct KB facts, tech/skill questions, closed-world denials (Rust, Kubernetes, Google), CIRIS single-turn, contact/location/education, adversarial false-claim refusal, out-of-scope redirect.
- **What to avoid / expect to fail in this build:** broad `Who is Bradley?` profile summary and complex coreference follow-ups that require the model to synthesize across projects.
- **No production deployment** should be done until the profile-summary failure is fixed and re-qualified.

### 9.3 Repo cleanup

- Delete any remaining temp files before the next commit.
- The `docs/SCOUT-UPDATED-STAGING-QUALIFICATION-REPORT.md` file should be committed so the qualification evidence is in the branch history.

---

## 10. Summary pass/fail table

| Checkpoint | Status | Evidence |
|------------|--------|----------|
| Source state recorded | PASS | `ba5e666`, clean tree |
| `manual-gate-regression.test.js` semantic locking | PASS | Only semantic invariants asserted, no exact strings |
| Direct answer freeze at 19 | PASS | `data/recruiter-knowledge.json` unchanged at 19; `break-it` confirmed |
| Commit coherent changes | PASS | `ba5e666` + `261fe67` |
| Deploy exact build to dev VM | PASS | `remote-deploy-ba5e666.sh` completed; `systemctl cat` shows correct files |
| `agentMode=lite` confirmed | PASS | `/health` and service `.env` |
| Post-deploy sanity query | PASS | Greeting with name ack |
| Final-visible validation test added | PASS | `test/final-visible-validation.test.js` (5/5) |
| `break-it.js` against staging | PASS | All checks, including live endpoint |
| 20 greeting stability | PARTIAL | 15/20 strict pass; 5 were valid but omitted "Scout" |
| 10 name-memory stability | PARTIAL | Blocked by HTTP 429; local `break-it` name memory passed |
| Referent matrix | PASS | `break-it` referent cases + `smoke-13` direct patterns |
| Scout acceptance suite (`smoke-13`) | PARTIAL | 10 GOOD, 1 WEAK, 2 FAIL (one real) |
| Generator-only qualification | NOT RUN | Ollama-only script; not applicable to remote Cloudflare staging |
| 5 Rust sessions | PARTIAL | 1/5 pass; rest rate-limited / one `INFERENCE_UNAVAILABLE` |
| CIRIS adversarial | MOSTLY PASS | 8/9; one `INFERENCE_UNAVAILABLE` on build follow-up |
| Identity false-premise matrix | MOSTLY PASS | 3/4; `Who is Bradley?` real failure |
| `eval-retrieval` | PASS | Recall@6=1.000, MRR@6=0.971 |
| `npm test` | PASS | 790/790 |
| Final report | COMPLETE | This document |

---

## 11. Action items

1. Implement the targeted `PROFILE` evidence/routing fix described in Section 9.1.
2. Re-deploy to `projecthub-dev-vm` from the new `develop` commit.
3. Re-run `smoke-13`, `run-http-eval --targeted`, and the `Who is Bradley?` / CIRIS coreference cases.
4. Lower or configure the staging rate limit before running high-volume automated suites from a single client IP, or run them with longer inter-request spacing.
5. Update `scripts/eval-local-api.js` `ALLOWED_SOURCES` and `scripts/run-http-eval.js` `classifySource` to recognize `cloudflare` provider if those scripts are intended for Cloudflare staging runs.
