# Scout Primary-Path + Staging Correction Report

**Date:** 2026-08-18 (continued)  
**Prepared for:** `ProjectHub/develop` integration branch  
**Status:** `develop` updated, `ProjectHub-dev/main` re-synchronized, dev backend deployed. **No promotion to `master`.**

---

## Summary

This pass completed the staging correction work and landed the first primary-path hardening changes for Scout identity, structured claim validation, and response-contract grounding. All unit tests pass, the staging mirror is correctly packaged, and the dev backend is live. The end-to-end API acceptance harness still fails on a mix of Cloudflare rate limiting and lingering generative overclaims; those are the remaining release blockers and are not promoted to `master`.

---

## What was fixed

### Staging packaging

- Rebuilt `BradleyMatera/ProjectHub-dev:main` from the intended `ProjectHub/develop` HEAD using the `projecthub-staging-deployer` skill.
- Wrapper commit contains the staging-specific `AGENTS.md`, `.github/workflows/pages.yml` triggering on `main`, and `STAGING-SOURCE.json`.
- Verified the staging source marker:

```text
$ git show projecthub-dev/main:STAGING-SOURCE.json
{
  "sourceRepository": "BradleyMatera/ProjectHub",
  "sourceBranch": "develop",
  "sourceCommit": "98fd7be47699081c35ffdc2382a4a5b2d63caf35",
  "generatedBy": "projecthub-staging-deployer"
}
```

### Handoff durability

- Updated `docs/current-feature-handoff.md` to avoid self-invalidating SHA claims; it now instructs readers to query the remotes for current SHAs and uses `STAGING-SOURCE.json` as the durable staging source marker.

### Direct-answer career-stage audit

- Removed unsupported `entry-level` assertions from the `senior-engineer`, `team-management`, and `production-incident` direct answers in `data/recruiter-knowledge.json`. Negative-boundary answers now state that public evidence does not document these roles, without deriving a career stage.

### Scout identity and META-question handling

- `data/scout-identity.json` now includes `productRole`, `capabilities`, and `forbiddenMetaClaims`.
- `lib/scout-identity.js` exposes `getProductRole`, `getCapabilities`, `getForbiddenMetaClaims`, and builds the persona line from these fields.
- `lib/claim-validator.js` centralizes structured claim validation:
  - assistant identity, generic/other-assistant identity, self-learning claims;
  - negative personal traits;
  - fabricated role/employment/skill/proficiency claims;
  - out-of-scope assertions.
- `lib/grounding-validator.js` calls `validateClaims()` and treats `assistant_identity_claim`, `role_title_claim`, `negative_personal_claim`, and `out_of_scope_claim` as hard fails.
- `lib/lite-agent.js` passes the full `responseContract` into `validateAnswer()` and includes the contract's natural instructions in the prompt.

### Response contract / primary path

- `lib/response-contract.js` adds new policy modes and sub-intents: `META`/`META_IDENTITY`, `NEGATIVE_ASSESSMENT`, `FUTURE_CAPABILITY`, `CLARIFICATION_REQUIRED`.
- New contract fields: `factState` (TRUE/FALSE/UNKNOWN/PARTIAL), `claimCeiling`, and `requestedRole`.
- `buildNaturalInstructions()` emits explicit `FACT_STATE`, `CLAIM_CEILING`, and `REQUESTED_ROLE` guidance to the model.
- `lib/completeness-check.js` recognizes `META` and `FUTURE_CAPABILITY` as top-level intents.

### Regression tests

- Added `test/primary-path-regression.test.js` covering:
  - generic assistant identity rejection;
  - Scout identity acceptance;
  - self-learning claim rejection;
  - negative personal trait rejection;
  - fabricated role title rejection;
  - proficiency overclaim from project evidence;
  - unknown skill claim rejection;
  - out-of-scope factual claim rejection;
  - response contract `factState`/`claimCeiling`/`requestedRole` presence.

### Other fixes

- `lib/context-packet.js` uses a minimal persona in `buildRawPacket()` so the raw-vs-assisted token comparison stays under its budget.

---

## Verification

| Check | Command | Result |
|---|---|---|
| Syntax check | `node --check server-gemini.js` | PASS |
| Unit tests | `npm test` | **806/806 PASS** |
| Retrieval eval | `npm run eval-retrieval` | Recall@6 `1.000`, MRR@6 `0.971` — PASS |
| Build | `npm run build` | PASS |
| Local claim validation | `test/primary-path-regression.test.js` | PASS |
| Staging mirror | `git show projecthub-dev/main:STAGING-SOURCE.json` | `sourceCommit` = `98fd7be...` |
| Dev deploy | `node scripts/manual-deploy-dev.js` | health check 200, smoke test PASS |

---

## Integration eval status

`scripts/eval-local-api.js` was run against `https://dev.projecthub-chat.bradleymatera.dev`:

- `passed`: 4
- `failed`: 57
- Sources observed: `cloudflare` (15), `knowledge-base` (4), `undefined` (42)

The failures fall into two buckets:

1. **Harness/source mismatch** — `ALLOWED_SOURCES` in `eval-local-api.js` does not include the current Cloudflare Workers AI provider names (`cloudflare`, `knowledge-base`). Pre-rate-limit requests were rejected as "unexpected source" even when the answer was coherent. This is a test-harness artifact, not a runtime bug.
2. **Cloudflare rate limiting (HTTP 429)** — After the first ~20 requests the free Workers AI tier began returning 429s. Subsequent cases therefore returned `undefined` source and empty replies. This is an infrastructure throttling issue during a rapid 61-request eval burst.
3. **Lingering overclaims (pre-429)** — A subset of the non-429, non-source failures (e.g., `work habits`, `weaknesses`, `role fit`) still show the model inventing unsupported negative traits, seniority-like phrasing, and role titles. These are the same primary-path classes targeted by this pass and require additional prompt/contract tightening.

**Recommendation:** Do not promote to `master`. The dev backend is correctly deployed and unit-test coverage is green, but end-to-end generative quality on the 3B Cloudflare model still needs a follow-up pass before release.

---

## Remaining release blockers

- META/Scout identity prompts need live confirmation; the unit tests and contract enforce the rules but a 3B model may still soften or evade them.
- Open-ended recruiter/role-fit/weakness questions still produce overclaiming and unsupported negative traits.
- Unknown-technology turns need to be verified as `UNKNOWN` rather than empty (the contract path is in place but live behavior is untested due to 429s).
- `scripts/eval-local-api.js` needs to be updated to recognize current provider `source` values and to include request pacing to avoid Cloudflare 429s.

---

## Source-of-truth pointers

- `ProjectHub/develop` HEAD: run `git ls-remote origin develop`
- `ProjectHub-dev/main` staging source: run `git show projecthub-dev/main:STAGING-SOURCE.json`
- Production `master`: frozen; no promotion.
