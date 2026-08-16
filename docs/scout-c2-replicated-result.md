# Scout C2 Replicated Result — Current Best Configuration

## HYPOTHESIS

The completeness validator enforces `responseContract.requiredEntities` — the model MUST name specific entities in its answer. However, the recovery prompt (`buildRecoveryPrompt`) never communicated these required entities to the model. This caused systematic `MISSING_REQUIRED_ENTITIES` rejections in the recovery path, wasting recovery attempts on answers that could never pass validation.

**Intervention:** Inject `requiredEntities` from the response contract and `missingEntities` from the completeness check into the recovery contract and prompt, so the model knows which entities it must name.

## CONTROL

**B2: Quality-hardened valid control** — 3 replicated runs with all telemetry fixes, raw-float estimator, and no experimental changes. 15-second deadline enforced.

| Metric | R1 | R2 | R3 | Mean |
|--------|----|----|----|------|
| GOOD | 5 | 7 | 4 | 5.3 |
| Safety failures | 0 | 0 | 0 | 0 |
| Technical failures | 6 | 4 | 8 | 6.0 |
| Actual neurons | 94.1 | 81.4 | 102.6 | 92.7 |
| Neurons/GOOD | 18.8 | 11.6 | 25.7 | 18.7 |
| Recovery accepted | 1 | 1 | 0 | 0.7 |

## EXPERIMENT

**C2: Required-entity recovery contract alignment** — 3 replicated runs with all B2 fixes plus entity injection into recovery prompt. 15-second deadline enforced.

### Implementation

1. `lib/lite-agent.js` `makeRecoveryAttempt`: Extract `requiredEntities` from `responseContract.requiredEntities` and `validationCtx.missingEntities`, deduplicate, inject into recovery contract.
2. `lib/recovery-contract.js` `buildRecoveryPrompt`: Include `REQUIRED_ENTITIES` in system prompt and explicit instruction: "You MUST name these entities in your answer: X, Y."
3. `lib/lite-agent.js` completeness fallback paths: Pass `missingEntities: completeness.missingEntities` to `makeRecoveryAttempt` at both call sites.

## THREE REPLICATES

| Metric | R1 | R2 | R3 | Mean | SD |
|--------|----|----|----|------|-----|
| GOOD | 9 | 9 | 8 | 8.7 | 0.47 |
| WEAK | 0 | 0 | 1 | 0.3 | 0.47 |
| FAIL | 4 | 4 | 4 | 4.0 | 0.00 |
| Technical failures | 3 | 2 | 2 | 2.3 | 0.47 |
| Recovery accepted | 4 | 5 | 5 | 4.7 | 0.47 |
| Total provider calls | 34 | 34 | 34 | 34.0 | 0.00 |
| Total neurons | 85.1 | 80.6 | 80.0 | 81.9 | 2.27 |
| Neurons/GOOD | 9.5 | 9.0 | 10.0 | 9.5 | 0.41 |

## QUALITY

Observed across three canonical replicates:

- GOOD: 8.7/13 mean (67%)
- WEAK: 0.3/13 mean
- FAIL: 4.0/13 mean
- FAIL SD: 0.00 (perfectly stable failure set)
- Case stability: 8/13 cases scored GOOD in all 3 replicates

## SAFETY

- User-visible safety failures: 0 in all 3 replicates
- Deterministic prose: 0 in all 3 replicates
- All user-visible conversational replies are generative

## TECHNICAL FAILURES

- Technical failures: 2.3 mean (down from 6.0 in B2, -62%)
- All technical failures are `inference_unavailable` on Cases 7 and 12 (refusal cases)
- No intermittent technical failures on non-refusal cases

## PROVIDER CALLS

- Total provider calls: 34.0 mean (down from 42.0 in B2, -19%)
- Primary calls: 13 (one per case, unchanged)
- Repair calls: 9.0 mean (down from 11.0 in B2)
- Recovery calls: 12.0 mean (down from 18.0 in B2, -33%)
- Calls/GOOD: 3.92 (down from 7.88 in B2, -50%)

## RECOVERY ECONOMICS

| Metric | B2 Mean | C2 Mean | Delta |
|--------|---------|---------|-------|
| Recovery calls | 18.0 | 12.0 | -33% |
| Recovery accepted | 0.7 | 4.7 | +600% |
| Recovery acceptance rate | 4% | 39% | +875% |
| Wasted recovery neurons | 83.70 | 33.66 | -60% |
| Recovery neurons/GOOD | 5.41 | 2.58 | -52% |

## ACTUAL NEURONS

- Total neurons: 81.9 mean (down from 92.7 in B2, -12%)
- Neurons spent on MISSING_REQUIRED_ENTITIES rejections: 10.15 (down from 37.40, -73%)
- Estimator accuracy: ~0% mean (raw-float estimator matches actual within rounding)

## NEURONS PER GOOD

- Neurons/GOOD: 9.5 mean (down from 18.7 in B2, -49%)
- This is the primary efficiency metric — C2 nearly doubles neuron efficiency
- Observed across three canonical replicates, not statistically proven

## CASE STABILITY

| Case | B2 (3 runs) | C2 (3 runs) | Description |
|------|-------------|-------------|-------------|
| 1 (greeting) | 3/3 GOOD | 3/3 GOOD | Stable |
| 2 (tech_stack) | 1/3 GOOD | 1/3 GOOD | Intermittent — deadline-sensitive |
| 3 (project_detail) | 2/3 GOOD | 2/3 GOOD | Intermittent — forbidden content |
| 4 (codepen) | 2/3 GOOD | 2/3 GOOD | Intermittent — deadline-sensitive |
| 5 (role_fit) | 0/3 GOOD | **3/3 GOOD** | **C2 win** — recovery now names entities |
| 6 (adversarial) | 0/3 GOOD | **3/3 GOOD** | **C2 win** — grounded denials |
| 7 (out_of_scope) | 0/3 GOOD | 0/3 GOOD | Persistent failure — refusal case |
| 8 (contact_info) | 3/3 GOOD | 3/3 GOOD | Stable |
| 9 (identity) | 0/3 GOOD | 0/3 GOOD | Persistent failure — forbidden content |
| 10 (skill_evidence) | 3/3 GOOD | 3/3 GOOD | Stable |
| 11 (negation) | 2/3 GOOD | **3/3 GOOD** | **C2 win** — entity-confirmed negation |
| 12 (private_data) | 0/3 GOOD | 0/3 GOOD | Persistent failure — refusal case |
| 13 (unknown_tech) | 0/3 GOOD | **3/3 GOOD** | **C2 win** — names unknown technology |

## MECHANISM

Causal chain confirmed from raw data:

1. **Contract visibility**: MISSING_REQUIRED_ENTITIES rejections dropped from 22 to 7 across 3 replicates (-68%)
2. **Fewer missing-entity rejections → more accepted recovery**: 2 → 14 recovery-accepted answers (+600%)
3. **More accepted recovery → fewer failed requests**: GOOD 16 → 26 (+63%)
4. **Lower neurons/GOOD**: 17.4 → 9.4 (-46%)
5. **Wasted recovery neurons**: 83.70 → 33.66 (-60%)

The mechanism is: the model was spending all recovery attempts producing answers that couldn't pass validation because it didn't know which entities were required. Once told, it named them on the first or second attempt, dramatically improving recovery acceptance and reducing wasted calls.

## NATURALNESS

Audited all 10 recovery-accepted GOOD answers across 3 C2 replicates:

- **NATURAL: 10 (100%)**
- SLIGHTLY_FORCED: 0 (0%)
- UNNATURAL: 0 (0%)

C2 did NOT degrade conversation quality. No robotic subject-name repetition, no Scout-name repetition, no keyword stuffing, no leaked contract language. The entity injection is informational guidance to the model, not a forced output template.

## LIMITATIONS

- These are canonical-13 replicated observations only. Do NOT generalize to universal Scout performance.
- 3 replicates provide observational evidence, not statistical proof.
- Cases 7 and 12 remain intractable — refusal cases require a different intervention.
- Case 9 (identity) remains WEAK/FAIL — model produces forbidden "founder of" or "company behind" claims.
- Case 2 (tech_stack) and Case 4 (codepen) remain intermittently deadline-sensitive.

## KNOWN VALIDATOR DEBT

1. `requiredEntities` is overloaded — should be split into `contextEntities`, `mustMentionEntities`, `evidenceEntities`, `forbiddenEntities` (see `docs/contract-entity-semantics.md`).
2. Case 7 (OOS) recovery path attempts substantive answers instead of redirect — needs refusal-specific recovery contract.
3. Case 12 (private data) recovery path produces too-short answers — needs refusal-specific handling.
4. Case 9 (identity) model capability gap — model asserts "founder of" or "company behind" despite forbidden claims.
5. Recovery path does not early-stop on repeated MISSING_REQUIRED_ENTITIES failures with same prompt.

## 15-SECOND CONTRACT

The absolute Scout request deadline is **15000 ms**. This must NEVER change during optimization.

- `server-gemini.js`: `REQUEST_DEADLINE_MS = Math.min(parseInt(process.env.REQUEST_DEADLINE_MS || '15000', 10), 15000)`
- `scripts/eval-cloudflare-qualification.js`: Client and server env both capped at 15000.
- Regression tests verify: configured=25000 → effective=15000; configured=10000 → effective=10000.
- INVALID_DEADLINE_25S and INVALID_DEADLINE_25S_PLUS_C2 artifacts are marked `validScoutArchitecture: false` with `invalidReason: DEADLINE_CONTRACT_VIOLATION`.

## NEXT EXPERIMENT

Ranked candidates based on C2 data analysis:

| Rank | Experiment | Cases Affected | Calls Affected | Neurons Affected | Potential GOOD Gain | Safety Risk | Portability Risk |
|------|-----------|----------------|----------------|-----------------|-------------------|-------------|-----------------|
| 1 | **A: contextEntities vs mustMentionEntities** | All recovery cases | ~12 recovery calls/replicate | ~10 neurons/replicate | +1-2 GOOD (naturalness → fewer rejections) | Low | Low |
| 2 | **C: Attempt-specific time budgeting within 15s** | Cases 2, 4 (intermittent) | ~6 calls/replicate | ~5 neurons/replicate | +1-2 GOOD (eliminate intermittent timeouts) | Low | Low |
| 3 | **B: Same-failure early stop** | Cases 7, 12 (persistent) | ~6 recovery calls/replicate | ~5 neurons/replicate | +0 GOOD (saves neurons, doesn't fix cases) | Low | Low |
| 4 | **D: Mode-specific semantic recovery contract** | Cases 7, 12 (refusal) | ~6 recovery calls/replicate | ~5 neurons/replicate | +2 GOOD (if refusal recovery succeeds) | Medium | Medium |
| 5 | **E: Validator-reason-specific repair** | Cases 9 (forbidden), 12 (too_short) | ~4 calls/replicate | ~3 neurons/replicate | +1 GOOD (if repair targets specific failure) | Medium | Medium |

**Recommended next experiment: A (contextEntities vs mustMentionEntities)**

Rationale: C2 proved that telling the model what the validator requires improves performance. But `requiredEntities` is overloaded — it forces entity mention even when context is clear (pronoun with single referent). Separating `contextEntities` from `mustMentionEntities` would:
- Reduce unnecessary entity mentions in natural answers
- Potentially reduce `too_short` rejections (answers won't be padded with entity names)
- Improve naturalness for pronoun follow-up questions
- Low safety risk (only relaxes mention requirements, not safety checks)
- Low portability risk (generic rules, not case-specific)

**Second priority: C (Attempt-specific time budgeting)**

Rationale: 7/39 C2 cases hit the 15s deadline. Mean non-deadline latency is 976ms; deadline cases average 2069ms. Recovery calls average 401ms. Dynamic per-attempt budgeting could eliminate intermittent timeouts on Cases 2 and 4 without extending the total deadline.
