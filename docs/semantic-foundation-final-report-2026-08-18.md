# Semantic Foundation + Acceptance Harness Rebuild — Final Report

Date: 2026-08-18
Branch: `develop`
Source: `BradleyMatera/ProjectHub`
Staging: `BradleyMatera/ProjectHub-dev/main`
Dev Backend: `https://dev.projecthub-chat.bradleymatera.dev`
Deployed SHA: `953c4f2`

## Summary

Completed the requested semantic-foundation refactor, rebuilt the `eval-local-api.js` acceptance harness, and deployed the `develop` branch to the dev backend. Deterministic tests pass. Live evaluation reached **60.9% (14/23)** on the first semantic-harness run. This is a measurable improvement over the previous stale regex harness, but the 3B model and a few remaining contract/prompt issues still prevent a clean 100% live qualification.

**No promotion to `master` or production was performed, as explicitly forbidden.**

## What Was Done

### 1. Semantic Foundation (`lib/response-contract.js`, `lib/response-policy-classifier.js`, `lib/claim-validator.js`, `lib/completeness-check.js`)
- Removed career-stage inference from `determineBoundary`, `getIntentKeywords`, `extractRequestedTopic`, `determineForbiddenClaims`, `determineFactState`, and `determineDirectAnswer`.
- Allowed unknown technologies to be first-class requested entities with `UNKNOWN`/`NO` answers rather than false denials.
- Fixed negative-assessment fact state to `UNKNOWN` unless explicit negative evidence is present.
- Broadened future-capability detection in `completeness-check.js`.
- Rewrote `validateClaims` in `lib/claim-validator.js` with typed relationship checks, claim-ceiling enforcement, and unknown-tech handling.
- Updated `response-policy-classifier.js` to return `UNKNOWN` for open-world missing evidence instead of `CONTRADICTED`/`UNSUPPORTED`.

### 2. Test Regressions (`test/`, `data/`)
- Updated stale test expectations in `test/agent-engine.test.js`, `test/response-policy-generic.test.js`, and `test/semantic-polarity.test.js` to match the new open-world semantics.
- Added `test/semantic-foundation.test.js` with six focused regression tests:
  - unknown technology is not treated as a documented skill
  - future capability is classified and requested topic is extracted
  - negative assessment fact state is `UNKNOWN`
  - job fit does not infer career stage
  - claim ceiling rejects over-claim
  - open-world seniority is not denied as false

### 3. Acceptance Harness (`scripts/eval-local-api.js`)
- Replaced the regex-based historical harness with a semantic contract harness.
- Added resumability (`PROJECTHUB_EVAL_RESUME`), rate-limit/backoff, pacing, and a quality taxonomy (`GOOD`, `TECHNICAL_ERROR`, `RATE_LIMIT`, `FACT_WRONG`, `OVERCLAIM`, `POLICY_FAILURE`, etc.).
- Preserved the old harness as `scripts/eval-local-api.historical.js`.

### 4. Contract Telemetry (`server-gemini.js`, `lib/lite-agent.js`)
- Added `ok: true` to successful chat payloads and `ok: false` to error paths.
- Added a client-safe `contract` object to the chat response exposing `intent`, `subIntent`, `policyMode`, `directAnswer`, `factState`, `evidenceStrength`, `claimCeiling`, `requestedRole`, `requestedTopic`, `boundary`, and `forbiddenClaims`.
- Fixed telemetry bugs discovered during live qualification:
  - `evidence` variable was block-scoped and unavailable for contract building.
  - `buildResponseContract` was called with `agentResult.rewritten` (boolean) instead of `agentResult.rewrittenQuery` (string).
  - Direct-KB short-circuit responses were missing `ok` and `contract`.

## Test and Evaluation Results

### Deterministic Tests
```
Tests:  812
Suites: 16
Pass:   812
Fail:   0
```
Command: `npm test`

### Live Targeted Evaluation
```
Base URL: https://dev.projecthub-chat.bradleymatera.dev
Cases:    23
Good:     14 (60.9%)
Failed:   9
```
- **3 `TECHNICAL_ERROR`** — model returned `INFERENCE_UNAVAILABLE` (likely 3B capacity/transient). Affected: `identity`, `unknown-skill`, and one other request.
- **5 `GENERIC`** — reply did not include the exact required phrase(s) the harness checks for. Indicates either harness expectation is too strict or the model is not following the contract.
- **1 `POLICY_FAILURE`** — contract/policy expectation not met.

#### Passing cases (14)
profile, known-skill, future-skill, role-fit, contact, greeting, thanks, memory-follow-up-a, unknown-tech-1, unknown-tech-2, skill-frame, and several others.

#### Failing cases (9)
identity, unknown-skill, future-role, negative-assessment, oos, false-employer, meta-capabilities, memory-follow-up-b, injection

## Remaining Blockers (not release-ready)

1. **Live pass rate < 100%** — the 3B model (`@cf/meta/llama-3.2-3b-instruct`) still produces over-claims, misses required phrases, or falls back to `INFERENCE_UNAVAILABLE` on some turns.
2. **`INFERENCE_UNAVAILABLE` is treated as a failure** for normal acceptance cases, as requested. These occurrences need further root-cause analysis (model timeout, token budget, or provider rate limiting).
3. **Harness expectations need fine-tuning** for `GENERIC` failures. Some may be due to overly strict phrase matching rather than real quality regressions.
4. **Future-capability classification** still occasionally returns `YES_NO` instead of `FUTURE_CAPABILITY` for "Could he learn X?" forms, causing the response to deny rather than discuss potential.

## Deployment and Staging Status

- Pushed `develop` to `BradleyMatera/ProjectHub` at SHA `953c4f2`.
- Rebuilt and force-pushed the `ProjectHub-dev/main` staging wrapper via `scripts/stage-projecthub-dev.js`.
- Deployed the dev backend from pushed SHA via `scripts/manual-deploy-dev.js`.
- Health and smoke checks passed.

## No Promotion to Production

As instructed, no merge to `master` and no production deploy was performed. The `master` branch remains frozen. The staging repo (`ProjectHub-dev`) is the only deploy target used.

## Recommended Next Steps

1. Investigate and fix the remaining `INFERENCE_UNAVAILABLE` occurrences on the dev backend.
2. Tune the prompt/contract for future-capability and negative-assessment turns so the 3B model follows the contract more reliably.
3. Adjust `scripts/eval-local-api.js` expectations to be less brittle on phrase-level matches while keeping semantic correctness.
4. Re-run `scripts/eval-local-api.js` until pass rate is at or above the agreed release gate.
5. Only after live qualification is clean, open a `develop -> master` PR and follow the documented release process.

## Files Changed (primary)

- `lib/response-contract.js`
- `lib/response-policy-classifier.js`
- `lib/claim-validator.js`
- `lib/completeness-check.js`
- `lib/lite-agent.js`
- `server-gemini.js`
- `scripts/eval-local-api.js` (rebuilt)
- `scripts/eval-local-api.historical.js` (archived)
- `test/agent-engine.test.js`
- `test/response-policy-generic.test.js`
- `test/semantic-polarity.test.js`
- `test/semantic-foundation.test.js` (new)
- `docs/semantic-foundation-final-report-2026-08-18.md` (this file)
