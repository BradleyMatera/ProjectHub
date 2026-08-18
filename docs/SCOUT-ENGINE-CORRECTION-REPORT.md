# SCOUT Engine Correction Report

**Branch:** `feat/agent-systems-network`  
**Date:** Generated during current session  
**Status:** Local engine fixes verified; full staging qualification pending deployment.

---

## Executive Summary

The deterministic Scout engine was producing non-conversational, over-fitted, and internally inconsistent replies because several control paths were running in the wrong order, referents were being resolved from hallucinated assistant text, the direct-answer table had grown beyond stable semantic answers, and the release mode default was not aligned with the validated target runtime. This pass fixes those root-cause engine bugs without adding new direct answers, deterministic refusal wrappers, or blaming the model.

---

## Root Causes Fixed

| # | Symptom | Root Cause | Fix |
|---|---------|------------|-----|
| 1 | Greetings/name intros did not commit `userName` before generation | `session-state` was updated after the reply was produced | `applyControlIntent` is called before generation; `userName`, `currentTopic`, `currentProjects`, and `activeComparison` are committed first |
| 2 | Pronouns like "it" resolved to nonsense or stale referents | `extractEntitiesFromText` extracted new technology terms from assistant text, so hallucinated capitalized words became active referents | New technology terms are now extracted from **user** turns only; assistant text cannot create new referents |
| 3 | Multi-pronoun follow-ups ("Could he become good at it?") resolved only `he` or only `it` | Tech-context pattern missed `good at` / `learn` phrases, so `Rust` was never extracted as a user-introduced skill | Added `good\s+at` and `learn(ing\|s)?` to the tech-context regex |
| 4 | Generic summary questions got canned replies | `directAnswers` had grown broad/summary-style entries (e.g., `tell-me-about-bradley`, `rust-future-leader`, `helm-accepted-offer`) | Audited and removed 5 over-fitted/broad entries; merged duplicate certification patterns; table frozen at 19 semantic answers |
| 5 | Conversational control intents routed through factual tools | `lite-agent` had no `no_tool` path for `GREETING`/`THANKS`/`HELP`/etc. | Added `CONTROL_MODES` bypass in `lite-agent`, plus `compressControlTool`, policy contracts, and response shapes |
| 6 | `server-gemini.js` defaulted to FULL mode | Default `SCOUT_AGENT_MODE` was `full`, contradicting `config/scout-release-candidate.json` and `docker-compose.yml` | Default changed to `lite` when the engine is enabled; documented justification below |

---

## Files Changed

- `server-gemini.js`
  - Default `SCOUT_AGENT_MODE` is `lite` for release.
  - Applies control intent before generation.
  - Resolves referents before `findDirectAnswer`.
  - Final reply is always the validated generative result; no deterministic prose wrapper.

- `lib/session-state.js`
  - Added `applyControlIntent`.
  - Ensures `userName` is committed before the model is called and preserved across turns.

- `lib/conversation-resolver.js`
  - Only extracts unknown technology terms from user text.
  - Added `good at` / `learn` contexts so user-introduced skills like "Rust" become active referents.
  - Improved `he`/`him`/`his` and `it`/`there` resolution ordering.

- `lib/lite-agent.js`
  - Added `compressControlTool`.
  - `CONTROL_MODES` bypass factual tool execution.
  - `buildLitePacket` injects the response contract/plan constraints into the prompt.

- `lib/response-policy-classifier.js`
  - Added response shapes for `USER_PROFILE_UPDATE`, `USER_PROFILE_QUERY`, `THANKS`, `FAREWELL`, `HELP`.
  - `GREETING` now correctly handles "Hi, my name is X" vs bare name intros.

- `lib/completeness-check.js`
  - Conversational control modes skip evidence completeness checks while still enforcing policy/filler checks.

- `data/recruiter-knowledge.json`
  - Removed `masters-degree-education`, `tell-me-about-bradley`, `helm-accepted-offer`, `rust-future-leader`.
  - Merged `kubernetes-cert` into `kubernetes-certification`.
  - Fixed JSON formatting.
  - Direct-answer count frozen at 19.

- `scripts/break-it.js`
  - Added multi-turn referent, session memory, CIRIS, and identity guard cases.

- `test/agent-mode.test.js` (new)
  - Verifies release candidate declares `lite-agent`.
  - Verifies server defaults to `lite` and selects `runLiteAgent`.
  - Verifies FULL module still exists for development but is not the default.

- `test/manual-gate-regression.test.js` (new)
  - Locks the manual 68-answer audit artifact: totals match, confusion matrix adds up, metrics are consistent, and gate thresholds cannot regress.

- `docs/local-ai-runtime.md`
  - Updated fallback behavior to list LITE as the default release mode.

---

## Verification

### Local Unit Tests

```powershell
npm test
```

- **Result:** 785 tests pass, 0 fail.
- New coverage: `test/agent-mode.test.js`, `test/manual-gate-regression.test.js`.

### Retrieval Evaluation

```powershell
npm run eval-retrieval
```

- **Result:** pass (Recall@6 = 1.000 on the golden 40-query set).

### Adversarial / Break-It Harness

```powershell
node scripts/break-it.js
```

- **Result:** `All break-it checks passed.`
- Covers direct answers, closed-world skill checks, company checks, and the new multi-turn referent/memory/CIRIS cases.

### Staging Sanity Probe

A single `POST /api/chat` to `https://dev.projecthub-chat.bradleymatera.dev/api/chat` was sent.

- The staging server responded (`HTTP 200`).
- The response was `INFERENCE_UNAVAILABLE` and the reported `agentMode` was still `full`.
- **Conclusion:** staging is currently running a build from before these fixes, and the generative backend is not reachable from the local probe environment. A full normal/qualification run against staging must wait until the updated `server-gemini.js` is deployed to the staging VM.

---

## SCOUT_AGENT_MODE: LITE vs FULL Justification

| Criterion | LITE | FULL |
|-----------|------|------|
| Production target | GCP `e2-micro` (958 MB RAM) | M2 Pro / 8 GB+ RAM |
| Packet size | ~90–120 tokens | 700–900 tokens |
| Generations per turn | 1 + optional repair | Multiple-step bounded loop |
| Routing | Deterministic Scout pre-router | Model decides tools |
| Validation | Same `grounding-validator` | Same |
| Latency target | < 15 s end-to-end on e2-micro | Higher per-turn cost |

The release candidate (`config/scout-release-candidate.json`) and `docker-compose.yml` both select `lite-agent`. `server-gemini.js` now defaults to `lite` when `SCOUT_AGENT_ENGINE_ENABLED=true`, matching the production configuration. `lib/agent-engine.js` (FULL) remains in the repo for development and future higher-resource deployments, but it is **not** the production release default.

---

## Forbidden Actions Checklist

- [x] No new direct answers added.
- [x] No deterministic refusal wrapper added.
- [x] No blame shifted to the Cloudflare 3B model for deterministic bugs.
- [x] No production deployment performed.
- [x] No hardcoded names or greetings added.

---

## Remaining Work

| ID | Task | Status | Blocker |
|----|------|--------|---------|
| e12 | Run normal vs generator-qualification modes on staging | Pending | Staging server is running old build and reports `INFERENCE_UNAVAILABLE` / `agentMode=full` |
| e13 | Run core manual gate flows through staging | Pending | Same as e12; requires updated `server-gemini.js` deployed to staging |

### Recommended Next Commands (after staging deploy)

```powershell
# Normal local-API style gate against staging
$env:PROJECTHUB_API_URL='https://dev.projecthub-chat.bradleymatera.dev'
node scripts/eval-local-api.js

# Cloudflare generator qualification (requires credentials)
$env:CLOUDFLARE_ACCOUNT_ID='...'
$env:CLOUDFLARE_API_TOKEN='...'
$env:PROJECTHUB_API_URL='https://dev.projecthub-chat.bradleymatera.dev'
node scripts/eval-cloudflare-qualification.js

# Manual gate audit against staging
node scripts/do-manual-audit.js
```

---

## Summary

The Scout deterministic engine now:

1. Commits conversational control state before generation.
2. Resolves multi-pronoun referents from user-introduced entities only.
3. Routes greetings/thanks/farewell/help/name queries through a lightweight control path.
4. Uses a frozen, semantically stable direct-answer table (19 entries).
5. Defaults to the validated LITE release mode.
6. Passes the full local test suite and break-it harness.

Staging qualification is the only remaining gate; it is blocked by the staging VM still running the pre-fix build.
