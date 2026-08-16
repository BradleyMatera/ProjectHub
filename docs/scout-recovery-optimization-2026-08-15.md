# Scout Recovery Optimization Session Report
**Date:** 2026-08-15
**Branch:** `feat/agent-systems-network`
**Remote SHA:** `952646e90ecb608544dfbe53030f330b0f9b3feb`
**Model:** `@cf/meta/llama-3.2-3b-instruct` (Cloudflare Workers AI, free tier)

---

## 1. Mission Summary

Benchmarked and optimized Scout's recovery pipeline against Cloudflare Workers AI's `@cf/meta/llama-3.2-3b-instruct` model. Ran 9 live benchmark sessions (13 canonical cases each) consuming ~650 neurons of the 2,000-neuron session budget.

## 2. Experiments

### EXP_C1: Same-Failure Early Stop
**File:** `lib/lite-agent.js`
**Change:** Track rejection reason signatures across recovery attempts. Skip attempt 3 if attempts 1 and 2 failed with the same rejection reason.
**Rationale:** Recovery thrash — repeated attempts with identical failure reasons waste neurons without improving outcomes.
**Result:** GOOD 5→6, neurons/GOOD 16→13, calls 39→36. **KEEP.**

### EXP_C2: Inject Required Entities into Recovery Prompt
**Files:** `lib/recovery-contract.js`, `lib/lite-agent.js`
**Change:** Pass `responseContract.requiredEntities` into `buildRecoveryPrompt()` and all three recovery attempt prompts. The model is explicitly told which entities it must mention.
**Rationale:** `recovery_MISSING_REQUIRED_ENTITIES` was the most frequent non-safety rejection reason. The model didn't know what entities were required during recovery.
**Result:** GOOD 6→9, neurons/GOOD 13→8, calls 36→30. **KEEP. Best single run.**

### EXP_C3: REFUSAL Mode Completeness Exemption
**File:** `lib/completeness-check.js`
**Change:** Add `REFUSAL` to the list of policy modes that skip required-entity and fact-coverage completeness checks. A polite refusal is complete by definition — safety and scope are already enforced by the grounding validator.
**Rationale:** Case 12 (private_data) was burning 4 calls and 9+ neurons on recovery because the completeness check demanded entity coverage from a refusal answer.
**Result:** Case 12 improved from FAIL (4 calls, 9.13n) to WEAK (1 call, 1.99n). Overall variance high but architecturally correct. **KEEP.**

### EXP_C4: Anti-Fabrication Guardrail in Recovery Prompt (REVERTED)
**File:** `lib/recovery-contract.js`
**Change:** Added "CRITICAL: Use ONLY entities mentioned in KEY_FACTS" to recovery prompt.
**Rationale:** Safety rejections from fabricated entities (e.g., "New York Rangers", "MongoDB") were the top recovery failure cause.
**Result:** No improvement — the 3B model ignores the instruction. Reverted to avoid token overhead. **REVERT.**

## 3. Stability Analysis (C1+C2+C3, 4 runs)

| Metric | Control B | C1+C2+C3 avg | Delta |
|--------|-----------|--------------|-------|
| GOOD | 5 | 7.25 | +45% |
| Neurons/GOOD | 16 | 12.0 | -25% |
| Total calls | 39 | 33 | -15% |
| User-visible safety errors | 0 | 0 | 0 |
| Deterministic prose | 0 | 0 | 0 |
| Over-15s | 0 | 0 | 0 |

**Per-case stability (4 runs):**
- **Always GOOD:** Case 1 (greeting), Case 10 (skill_evidence)
- **Improved:** Case 12 (private_data): FAIL→WEAK, Case 13 (unknown_tech): FAIL→GOOD/WEAK
- **Volatile:** Case 7 (out_of_scope), Case 4 (codepen), Case 6 (adversarial)
- **Declining:** Case 3 (project_detail): GOOD→WEAK (model variance — "not publicly available" phrasing)

## 4. Additional Fixes

### Neuron Estimator Fix (Phase 11)
**File:** `lib/cloudflare-provider.js`
**Change:** `Math.ceil` → `Math.round` in `estimateNeurons()`.
**Impact:** Total estimator error dropped from 20% to 0%. Per-call mean error from 23% to 10%.

### Architecture Invariant Fix (Phase 12)
**File:** `lib/lite-agent.js`
**Change:** Track the terse-yes-no expansion call in `generationCalls`.
**Impact:** Fixes the persistent `UNTRACKED_PROVIDER_CALL` violation on Case 10.

### Efficiency Benchmark Harness (Phase 10)
**File:** `scripts/compare-benchmarks.js`
**Purpose:** Offline comparison of all benchmark artifacts with per-case stability analysis.

## 5. Audit Results (Phases 12-17)

| Audit | Status | Notes |
|-------|--------|-------|
| Validator debt | Clean | No TODO/FIXME/HACK in lib/ or server-gemini.js |
| Portability | Clean | No hardcoded localhost/ollama refs in lite-agent.js |
| Provider abstraction | Clean | Router pattern with swappable providers (ollama, cloudflare) |
| FREE_ONLY policy | Clean | `isPaidOnly()` check in cloudflare-provider.js, enforced in qualification harness |
| Deadline audit | Clean | `requestDeadline` respected at all generation points, no 15s violations |
| Quality contract | Clean | Response contracts flow from policy classifier through generation |

## 6. Remaining Opportunities

1. **Case 7 (out_of_scope):** Most volatile case. The OOS policy violation detection is too aggressive — it rejects valid answers that mention any external topic. Consider relaxing the `answerAddressesExternalTopic` check.
2. **Case 3 (project_detail):** Model sometimes says "not publicly available" which triggers `forbidden_content_detected`. This is a model capability issue, not a code issue.
3. **Case 12 (private_data):** Now WEAK instead of FAIL. The scorer wants specific "refusal language" that the 3B model doesn't produce. Consider adjusting the scorer's `refusalRequired` check to accept "not publicly available" as valid refusal language.
4. **Recovery safety rejections:** The 3B model fabricates entities (NHL teams, MongoDB, etc.) during recovery. A larger model would likely fix this, but within the 3B constraint, the early-stop (C1) is the best mitigation.
5. **Untracked provider call on Case 7:** The OOS policy path may also have an untracked call. The terse-expand fix should address most cases, but Case 7 may have a different path.

## 7. Files Modified

| File | Changes |
|------|---------|
| `lib/lite-agent.js` | EXP_C1: rejection signature tracking + early stop. EXP_C2: pass requiredEntities to all recovery prompts. Phase 12: track terse-expand call. |
| `lib/recovery-contract.js` | EXP_C2: accept and inject `requiredEntities` into `buildRecoveryPrompt()`. |
| `lib/completeness-check.js` | EXP_C3: REFUSAL mode completeness exemption. |
| `lib/cloudflare-provider.js` | Phase 11: `Math.ceil` → `Math.round` in estimator. |
| `test/cloudflare-provider.test.js` | Updated estimator tests for Math.round. |
| `scripts/compare-benchmarks.js` | New: efficiency benchmark comparison harness. |

## 8. Session Neuron Budget

- **Consumed:** ~650 neurons across 9 live runs
- **Remaining:** ~1,350 neurons
- **Daily free limit:** 10,000 neurons
- **No paid models used. No safety regressions. No deadline violations.**
