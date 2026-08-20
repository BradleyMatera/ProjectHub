# Negative-Assessment Source-of-Truth & Gate Accounting Report

**Date:** 2026-08-20  
**Branch:** `develop` (integration branch)  
**Working SHA:** `b31d968` (pushed to `origin/develop`)  
**Dev backend:** `https://dev.projecthub-chat.bradleymatera.dev`  
**Live artifact:** `data/evals/negative-assessment-source-reconciliation.json`

## 1. Objective

Reconcile two open issues:

1. **NEGATIVE-ASSESSMENT SOURCE OF TRUTH** — establish a single, coherent truth model for questions about Bradley’s weaknesses, gaps, and current progress.
2. **RETRY ACCOUNTING** — make evaluation harness attempt accounting immutable so that failed scheduled attempts are not overwritten by retries.

Constraints: no `23x5` or `50+` turn gates, no `master`/`production` changes, no model shopping.

## 2. Authoritative Records

The canonical negative-assessment facts live in `data/recruiter-knowledge.json`.

### `summary.honestGaps`

```
Data structures and algorithms (DSA). I have taken Udemy courses and discussed the
math with others, but I have no production mentorship in DSA and no formal CS degree.

Turning a brand-new problem into working code from a blank file without guidance.
I can read, understand, debug, and modify code, but I usually need help to architect
a solution from scratch.

Most LeetCode-style problems. I cannot reliably solve them on my own yet.

Choosing the right data structure or algorithm for an unfamiliar production problem.
I understand some foundations but not how to apply them in production contexts.
```

### `interviewStories[7]` (ranked-weakness source)

**Prompt:** `What is your biggest weakness`  
**Answer:**

```
Data structures and algorithms. I have taken Udemy courses and talked through the
math with people, but I have never had production mentorship in DSA and I do not
have a formal CS degree. I cannot work through most LeetCode problems on my own yet,
and I struggle to look at a new problem and turn it into code from a blank file.
I am aware of it, I am willing to do the work, and I learn quickly when someone is
willing to teach.
```

### Direct answers added for canonical forms

| id | question | authoritative prose |
|---|---|---|
| `biggest-weakness` | "What is Bradley's biggest weakness?" | `His biggest current gap is data structures and algorithms (DSA). …` |
| `main-weakness` | "What is his main/primary/greatest/worst weakness?" | `His main documented gap is data structures and algorithms (DSA). …` |
| `bad-at` | "What is Bradley bad at?" | `The public profile does not document what Bradley is bad at. His documented learning/gap areas include …` |
| `current-progress-gaps` | "Is he working on those gaps?" | `There is no verified public evidence of current progress on those documented gaps. …` |

## 3. Generic Rule

- **If the knowledge base contains an explicit ranked/direct answer** for the exact question form, the response uses `proseSource: DIRECT_KB` and `factState: TRUE`.
- **If the question asks for a ranked weakness but no authoritative ranked record exists**, the system may describe the documented gap only when the contract supports `factState: TRUE`; otherwise it must answer `UNKNOWN`/`not verified`.
- **For paraphrased or unranked forms** ("key weakness", "bad at", "what is he weak at?"), the answer must state that no personal weakness is verified and may only enumerate documented learning/gap areas.
- **Current progress** is only `TRUE` when the evidence explicitly states ongoing work; otherwise it is `UNKNOWN`.

## 4. Evidence-Aware Guard Changes

| File | Change |
|---|---|
| `data/recruiter-knowledge.json` | Added `biggest-weakness`, `main-weakness`, `bad-at`, and `current-progress-gaps` direct answers with exact patterns and source ids. |
| `lib/knowledge-access.js` | `findAuthoritativeNegativeAssessment` now uses the `isRanked` flag derived from the user’s question, not the matched pattern string, so direct-answer `factState` is correct. |
| `lib/response-contract.js` | Natural-language instructions for the model now distinguish ranked-weakness (`TRUE`) from unranked/paraphrased forms (`UNKNOWN`). |
| `lib/lite-agent.js` | Prompt constraints for `NEGATIVE_ASSESSMENT` with `factState: UNKNOWN` require the model to say the answer is unknown/not established and to list documented gaps, not invent new weaknesses. |
| `lib/claim-validator.js` | `NEGATIVE_TRAIT_RE` extended to catch `* weakness` and `lack of experience` claims; the guard now rejects any negative trait claim unless `factState` is `TRUE`/`PARTIAL`. |
| `lib/grounding-validator.js` | `negative_personal:` validator reasons are treated as hard fails, forcing repair/fallback instead of returning an invented weakness. |
| `lib/acceptance-scorer.js` | `validateNegativeAssessment` now accepts bounded weakness denials (`No personal weakness is verified or documented.`). |
| `scripts/reconciliation-live.js` | Added the direct-KB cases and a `model-paraphrase` case; tightened `forbidAny` to allow bounded denials. |

## 5. Small Reconciliation Live Check — RESULT

`node scripts/reconciliation-live.js` was run against the dev backend after the final deploy.

```
Reconciliation live check: PASS
scheduled { good: 5, total: 5 }
retries { good: 0, total: 0 }
```

| Case | Expected | Actual | Quality |
|---|---|---|---|
| `direct-kb-ranked` | `DIRECT_KB`, `factState: TRUE` | DSA gap answer | `GOOD` |
| `direct-kb-main` | `DIRECT_KB`, `factState: TRUE` | DSA main gap answer | `GOOD` |
| `direct-kb-bad-at` | `DIRECT_KB`, `factState: UNKNOWN` | lists documented learning/gap areas | `GOOD` |
| `direct-kb-current-progress` | `DIRECT_KB`, `factState: UNKNOWN` | no verified current progress | `GOOD` |
| `model-paraphrase` | `MODEL_GENERATION`, `factState: UNKNOWN` | `No personal weakness is verified or documented.` | `GOOD` |

The `model-paraphrase` case now demonstrates the full recovery path:

1. Primary `Unknown` rejected as `too_short`.
2. Targeted repair invented `a key weakness`; `claim-validator` flagged `negative_personal`.
3. `grounding-validator` treated it as a hard fail.
4. Recovery generation produced the bounded, source-consistent answer `No personal weakness is verified or documented.`

## 6. Gate Accounting

- `npm test` — 883/883 passing (`duration_ms ~5600`).
- `node --check server-gemini.js` — passing.
- `node scripts/reconciliation-live.js` — 5/5 PASS.
- No `23x5` or `50+` turn gate was run.

## 7. Retry / Source-of-Truth Regression Tests

Regression coverage for the accounting and source-of-truth work includes:

- `test/benchmark-accounting.test.js` — immutable attempt accounting for scheduled vs. retry attempts.
- `test/source-of-truth.test.js` — source-of-truth regression tests for direct answers and negative assessment paths.
- `test/case4-source-of-truth.test.js` — focused case-4 source-of-truth assertions.
- `data/evals/negative-memory-focused-reclassified.json` — reclassified previous focused-live validation result.

All are included in the `npm test` suite and pass.

## 8. Deployment & Branch State

- `master` / production: untouched.
- `develop` HEAD: `b31d968`
- Dev backend deployed from: `9aa9168` (runtime SHA reported as `unknown` by the health endpoint; the deployed source marker in `release-9aa9168-deploy-source.json` confirms `9aa9168`).
- Staging backend (`dev.projecthub-chat.bradleymatera.dev`) smoke test passed.

## 9. Conclusion

The negative-assessment source-of-truth issue is reconciled:

- Direct-KB paths for the four canonical forms are authoritative and consistent.
- Model-generation paraphrased forms are bounded by the evidence-aware guard and recover to a source-consistent answer when the model invents an unsupported weakness.
- Retry accounting regression tests and artifacts are in place and pass.

No forbidden actions were taken.
