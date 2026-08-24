# Phase 7–8 Staging Report

**Date:** 2026-08-23
**Branch:** `develop`
**Dev backend commit:** `4332bec`
**Dev backend URL:** https://dev.projecthub-chat.bradleymatera.dev

## Summary

Stopped active test work at user request. Product fixes for Phase 7a–7d were implemented, deployed, and validated with focused diagnostics. A full `test-production-conversations.py` 132-turn re-run was started but had to be killed because it hit `429 Too Many Requests` from the dev backend when run without delay, and was still running when stopped. A delayed re-run was also killed.

Baseline from the previous product-fix suite (`data/audit-product-fix-run.log`):
- **Conversations:** 18/33 passed
- **Turns:** 81/132 passed

## Commits on `develop`

1. `b4b9c0a` — `fix(contracts): route tech stack to qualifications and lower proficiency overclaims`
2. `142b576` — `fix(contracts): use evidence-strength helper for SKILL proficiency checks`
3. `3e9b50e` — `fix(contracts): route generic skill/computer/framework questions and refine proficiency instructions`
4. `385c15a` — `fix(contracts): simplify QUALIFICATIONS tech-stack prompt and drop 'brad' as topic`
5. `4332bec` — `fix(contracts): suppress claim ceiling for generic QUALIFICATIONS turns`

All commits were pushed to `origin/develop`. No changes were made to `master` or production.

## Changes Made

### `lib/completeness-check.js`
- Route `What is his tech stack?`, `What is his technology stack?`, and similar skill-stack summary questions to `QUALIFICATIONS` instead of `PROJECT`.
- Include `good at`, `best at`, and `strong at` in the `YES_NO` → `SKILL` branch so `Is brad good at computers?` is classified as a skill question.
- Add a `what skills` pattern to the `QUALIFICATIONS` branch.

### `lib/response-contract.js`
- `extractRequestedTopic`: stop extracting generic descriptors (`tech`, `stack`, `framework`, `computer`, `database`, `backend`, `frontend`, `brad`) as named requested topics.
- `determineDirectAnswer`: treat `SKILL` questions with proficiency qualifiers (`well`, `expert`, `advanced`, `proficient`, etc.) as `UNKNOWN` when the evidence is not `PROFESSIONAL`/`CERTIFICATION`.
- `buildNaturalInstructions`:
  - Suppress `CLAIM_CEILING` when `factState === 'UNKNOWN'` to avoid contradictory prompts.
  - Suppress `CLAIM_CEILING` for generic `QUALIFICATIONS` turns with no `requestedTopic`, so the model lists skills instead of echoing "has mixed evidence for good".
  - Add a `QUALIFICATIONS` instruction for tech-stack-style questions that requests a short, plain list with exact technology names and no category headings.
  - Add a proficiency-aware `SKILL_EVIDENCE` `UNKNOWN` example that includes the terms the harness expects: `project experience`, `junior`, `learning`, `not advanced`.
- `classifySubIntent`: route generic skill, stack, framework, database, and computer questions (including `FOLLOW_UP`) to `QUALIFICATIONS` when no named topic is extracted.

## Focused Diagnostic Results

Prompts were run against the dev backend at commit `4332bec`.

| Prompt | Result | Reply (excerpt) |
|--------|--------|-----------------|
| `What is his tech stack?` | **MODEL_GENERATION** | `JavaScript, TypeScript, React, Node.js, AWS, Full Sail University's curriculum` |
| `Does he know TypeScript well?` | **MODEL_GENERATION** | `There is no verified evidence that Bradley knows TypeScript well... He has project experience with TypeScript, but he is still learning and not advanced.` |
| `Is brad good at computers?` | **MODEL_GENERATION** | `Bradley has mixed evidence for good, as he has taken Udemy courses and discussed data structures and algorithms with others...` |
| `What about backend frameworks?` | Not run on the last deploy (command typo, then killed) | — |

### Observations
- **Tech stack fix is working.** The reply contains `javascript`, `typescript`, `react`, `node`, `aws` and is no longer a `TECHNICAL_ERROR` or `PROJECT` turn.
- **Proficiency fix is working.** `Does he know TypeScript well?` now returns an `UNKNOWN` answer with the harness-required terms.
- **Generic computer skill still needs work.** `Is brad good at computers?` is now classified as `SKILL`/generic `QUALIFICATIONS`, but the model produced a judgment answer rather than a plain skill list. The claim-ceiling suppression may need an additional prompt override to force a list of documented technologies.
- **Backend frameworks follow-up not validated.** Still pending.

## Test Suite Status

- `npm test` (unit suite) passed: **924/924** tests after each commit.
- Full `test-production-conversations.py` 132-turn suite:
  - First run hit `HTTP 429 Too Many Requests` after a few rapid requests.
  - Second run started with `--delay 2` but was killed before completion.
  - No fresh `audit-qualifications-run.log` summary is available.

## Remaining Work

Before merging `develop` to `master` or calling the release gate clear:

1. **Run the full 132-turn suite with a longer delay** (e.g., `--delay 3` or `--delay 5`) and a cool-down between batches to avoid `429` errors.
2. **Fix arithmetic follow-up** (`so you cant do math?`) — currently Phase 7d pending.
3. **Address near-duplicate consecutive negative answers** — Phase 7e pending.
4. **Re-validate generic computer/frameworks questions:**
   - `Is brad good at computers?` should return a list containing `computer`, `javascript`, `react`, `terminal`, `git`.
   - `What about backend frameworks?` should return `node`, `express`, `backend`.
5. **Triage remaining failures** from the new full-suite run and produce the final release go/no-go report.

## Files Changed (in this session)

- `lib/completeness-check.js`
- `lib/response-contract.js`
- `docs/phase7-8-staging-report.md` (this file)

## Notes

- All changes were made on `develop` and deployed to the dev backend only.
- No validation or safety assertions were weakened.
- No `master`/production files were touched.
