# ProjectHub 8B Release Gate Report — v3

**Date:** 2026-08-23  
**Source branch:** `develop` on `BradleyMatera/ProjectHub`  
**Source SHA:** `e3f1a592c2968711028eb9ca3365bb95c02125fc`  
**Dev backend:** `https://dev.projecthub-chat.bradleymatera.dev`  
**Frontend staging mirror:** `https://bradleymatera.github.io/ProjectHub-dev/`

## Summary of this run

This session continued the root-cause investigation from v2. Two surgical validator patches were applied and deployed to the dev backend. The targeted `TECHNICAL_ERROR` prompts from the v2 report are now stable; the remaining failures are broader precheck-style issues in role-fit, future-skill framing, and conversation-context quality.

## Code changes made in this session

1. `lib/grounding-validator.js`
   - `forbidden_claim` check now uses `isTokenNegated` so explicit refutations like "not live customer ticket work" are no longer false-positive validation rejections.

2. `lib/claim-validator.js`
   - Skill-claim blocks now respect `isTokenNegated` on the requested topic, so unknown-skill refutations ("no information about vibe") are not rejected.
   - Imported `phraseAppears` and rewrote `hasEvidenceForSkill` to require whole-token/phrase presence. This stops "vibe" from being treated as verified because the unrelated word "vibes" appears in a blog chunk.

3. `lib/negation-scope.js`
   - Expanded `NEGATION_WORDS` to include "is unknown", "unknown whether", "no information", "not in evidence", "not documented", "not provided", and "no documentation".

4. `test-production-conversations.py`
   - Already contained `cloudflare` in `LOCAL_SOURCES`; no new changes.

## Gate results

| Gate | Command | Result |
|------|---------|--------|
| Unit tests | `npm test` | **PASS** — 924/924 |
| Retrieval eval | `npm run eval-retrieval` | **PASS** — Recall@6 = 1.000, MRR@6 = 0.954 |
| Build | `npm run build` | **PASS** |
| API scenario runner | `PROJECTHUB_API_URL=https://dev.projecthub-chat.bradleymatera.dev/api/chat node scripts/api-scenario-runner.js` | **Not re-run in this session; v2 showed PASS** |
| Local API eval | `PROJECTHUB_API_URL=https://dev.projecthub-chat.bradleymatera.dev npm run eval:local-api` | **PASS** — 23/23 (100%) |
| Focused TE reliability | 3 prompts × 3 attempts × 3 runs (27 total) against dev | **1/27 TECHNICAL_ERROR** (vibe, run 1, attempt 1) |
| Production conversation regression | `python test-production-conversations.py --url https://dev.projecthub-chat.bradleymatera.dev/api/chat --delay 2.5` | **FAIL** — 70/132 turns passed, 12/33 conversations passed |

## Focused TE reliability detail

Prompts tested: `What did he actually do at AWS?`, `can he vibe code or code code?`, `Why would I interview him?`

| Prompt | TE rate | Notes |
|--------|---------|-------|
| `What did he actually do at AWS?` | 0/9 | Stable `MODEL_GENERATION` with correct AWS description. |
| `can he vibe code or code code?` | 1/9 | One `TECHNICAL_ERROR` caused by `wrong_relationship:project_provenance` when the model conjoined an AWS-internship fact and a CIRIS contribution fact in one sentence. Other attempts correctly answered "I couldn't find any information..." |
| `Why would I interview him?` | 0/9 | Stable `MODEL_GENERATION` with grounded CIRIS + mixed-evidence framing. |

## Root-cause classification of the original `TECHNICAL_ERROR`s

| Symptom prompt | Original validation reason | Root-cause layer | Patch applied |
|----------------|---------------------------|------------------|---------------|
| `What did he actually do at AWS?` | `forbidden_claim:live customer ticket work` | Validator false positive: negated forbidden phrase was flagged | `lib/grounding-validator.js` |
| `can he vibe code or code code?` | `skill:Skill/proficiency claim for unverified topic: vibe` | Validator false positive: unknown-skill refutation flagged by `SKILL_VERB_GENERAL` | `lib/claim-validator.js` + `lib/negation-scope.js` |
| `Why would I interview him?` | `unsupported_tech_claim:Python` | Model output failure: primary answer invented Python | No product fix applied; the prompt is now stable in focused runs (likely model/cache variance), but the underlying over-claim risk remains |

## Production conversation regression findings

The 62 failed turns fall into three buckets:

1. **Validator or repair `TECHNICAL_ERROR` fallbacks**
   - Examples: `Why isn't DevOps a good fit?`, `Is he a good fit for a support role or not?`, `Does he know TypeScript well?`, `Has he worked with databases?`, `What AWS services has he used?`, `does brad know how to use a computer?`, `is he good at costumer serivice?`
   - These return `I couldn't generate a reliable answer right now.` inside multi-turn recruiter sequences.
   - Cause: role-fit / skill-claim / project-provenance validation rejects the model's primary answer, and the repair answer is also rejected or hallucinates cross-project relationships.

2. **Staleness in the transcript harness**
   - Examples: `What is 2 plus 2?` (`4` flagged as too short), `Can he learn cobol?` (harness expects `can learn`/`yes` but model says `could learn`/`future`), `How is this chat free?` (harness expects `local`/`ollama`/`rate limit` but model gives a different valid framing).
   - These are assertion mismatches; the answers are often semantically acceptable.

3. **Product quality drift**
   - Examples: `What is Bradley's strongest technical background?` (`js, Express, and GitHub Pages`), `give me an example of his jobs?` (`Bradley has applied to an internship pipeline on 08/05/2025`), `How is this chat free?` (widget explanation, not the free-tier/Cloudflare framing the harness expects).
   - These are not `TECHNICAL_ERROR`, but the answers are incorrect or off-policy.

## Release decision

**RELEASE READY: NO**

The targeted `TECHNICAL_ERROR`s from the original investigation are fixed and the focused reliability set is clean at 1/27. However, the full production conversation regression still fails (70/132 turns), with multiple `TECHNICAL_ERROR` fallbacks in role-fit and skill-claim turns and additional content-quality drift. A master release PR should not be opened until the full conversation suite is green.

## Recommended next steps

1. **Run the `projecthub-precheck-failure-fix` skill** against the remaining role-fit / future-skill / false-employer / false-senior failures. The skill is designed for exactly this class of problem (F2–F6).
2. **Triage the conversation-context `TECHNICAL_ERROR`s first**: reproduce `Why isn't DevOps a good fit?` and the `support role`/`TypeScript`/`databases` turns with full conversation history and inspect `agentMeta.generationCalls` and `rawPrimary`/`rawRepair`.
3. **Audit `test-production-conversations.py` assertions** and update stale keyword expectations where the model is now giving a valid but differently-worded answer (`2 plus 2`, `Can he learn cobol?`, `How is this chat free?`). Do not weaken factual checks.
4. **After precheck fixes**, re-deploy and re-run the full six-gate suite:
   - `npm test`
   - `npm run eval-retrieval`
   - `npm run build`
   - `node scripts/api-scenario-runner.js`
   - `npx playwright test --config=playwright.config.js`
   - `python test-production-conversations.py --url https://dev.projecthub-chat.bradleymatera.dev/api/chat --delay 2.5`
5. Only when all gates pass should a release PR from `develop` to `master` be opened.
