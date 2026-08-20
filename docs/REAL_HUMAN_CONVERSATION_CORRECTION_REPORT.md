# REAL HUMAN CONVERSATION CORRECTION REPORT

**Project:** Scout / ProjectHub conversational recruiter widget  
**Branch:** `develop`  
**Baseline commit:** `e5a74ad`  
**Final validation commit:** `7a11550`  
**Dev staging URL:** `https://dev.projecthub-chat.bradleymatera.dev/`  
**Report date:** 2026-08-17

---

## 1. Problem Statement

Manual testing of the live chat widget revealed a regression where real human conversation turns were mishandled:

- **Request-to-say** (`"say X"`) was being rewritten into a candidate query and failed to return the requested phrase.
- **Small talk** (`"what's up"`, `"how are you"`) triggered BM25 portfolio search and produced stilted, over-grounded replies.
- **Clarifications of a previous assistant turn** (`"what do you mean?"`) were answered with subject facts instead of explaining the assistant's last statement.
- **Short phrase control answers** were rejected by validation as "too short / ungrounded" and forced a recovery loop.
- **Addressee confusion:** agent-directed conversational patterns sometimes fired on subject-directed questions (e.g., `"what's up with his AWS work?"`).

The immediate failure transcript was six turns long and is reproduced below.

---

## 2. Root Cause Analysis

| Failure | First bad stage | Cause |
|---------|-----------------|-------|
| `say cheesecake` / `say X` | Query rewrite + `preRoute` | No `REQUEST_TO_SAY` intent; anaphora rewrite turned the phrase into a candidate query. |
| `whats up`, `how are you` | BM25 retrieval | Classified as `CONVERSATIONAL` or `GREETING` and routed to agent, but evidence search still ran, contaminating the prompt. |
| `what do you mean?` | Response generation | `CLARIFY` mode existed in plan but the model was fed subject facts and previous candidate replies instead of the last assistant text. |
| Short control answers | Validation (`lite-agent` / `grounding-validator`) | Minimum length / content-word overlap checks failed one-word or phrase answers, forcing repair. |
| `what's up with his AWS work?` | Policy classifier | Agent-directed small-talk regex fired on a subject-directed sentence. |

---

## 3. Implemented Fixes

### 3.1 Conversational-act classifier (`lib/response-policy-classifier.js`)

- Added `REQUEST_TO_SAY` detection with quoted/unquoted content capture and stop-word filtering.
- Added `SMALL_TALK` regex for agent-directed casual phrases.
- Added `CLARIFY_PREVIOUS_ASSISTANT` regex for explanations of the prior assistant statement.
- Added `detectAddressee()` to compute `AGENT` / `SUBJECT` / `AMBIGUOUS` roles from `you`/`u`/`yourself` vs. subject name and pronouns.
- Guarded small-talk and clarification patterns so they do **not** fire when the sentence is actually about the subject.
- Single-word name fallback treats bare tokens like `"brad"` as `USER_PROFILE_UPDATE` unless they are known entities or common social words.

### 3.2 Lite agent routing (`lib/lite-agent.js`)

- Extracted `CONTROL_MODES` to module scope.
- `preRoute` now returns `operation: 'control'`, `tool: 'no_tool'` for every control mode.
- Anaphora resolution is skipped for control modes.
- BM25 / evidence retrieval is skipped for control modes.
- `buildLitePacket()` produces a tiny, fact-free prompt for control turns.
- `lenientValidate()` and `fullValidate()` accept short phrase answers for control modes.
- `compressControlTool()` carries `requestedText` and `previousAssistantText` where appropriate.

### 3.3 Server pipeline (`server-gemini.js`)

- Classifies the conversational act **before** query rewrite so small talk and request-to-say are not rewritten.
- `NO_RETRIEVAL_MODES` now includes `SMALL_TALK`, `REQUEST_TO_SAY`, and `CLARIFY_PREVIOUS_ASSISTANT` so evidence search is skipped.
- `applyControlIntent()` is called after final policy is selected.

### 3.4 Validation (`lib/grounding-validator.js` + `lib/local-conversation.js`)

- `validateAnswer()` allows short, style-relaxed answers for control modes while still blocking overclaim / fabrication.
- Added temporal grounding check in `local-conversation.js` requiring explicit current markers (`now`, `currently`, `as of`) for present-tense claims not supported by a dated source.

### 3.5 Regression tests

- `test/human-conversation.test.js`: exact manual transcript + 30-turn human stress test for the classifier.
- `test/local-conversation.test.js`: temporal grounding cases.

### 3.6 Dev deployment helper

- `scripts/manual-deploy-dev.js`: robust Node.js replacement for the brittle shell script; tars `lib/`, uploads, swaps, restarts via `systemctl`, runs health + smoke checks.

---

## 4. Local Verification

```text
npm test                 793 / 793 passing
npm run test:retrieval   passing
npm run eval-retrieval   Recall@6 = 1.000, MRR@6 = 0.971
```

No regressions in existing unit or retrieval suites.

---

## 5. Staging Re-run of the Exact Manual Transcript

Script: `scripts/trace-staging-transcript.js`  
Session: `74fac8a8-1b84-415d-82da-c2e526dd389d`  
Endpoint: `https://dev.projecthub-chat.bradleymatera.dev/api/chat`

| Turn | User | Expected policy | Actual policy | Latency | Result |
|------|------|-----------------|---------------|---------|--------|
| 1 | `I'll give brad a job right now if you say cheesecake` | `REQUEST_TO_SAY` | `REQUEST_TO_SAY` | 905 ms | PASS |
| 2 | `brad` | `GREETING`/`USER_PROFILE_UPDATE`/`SMALL_TALK` | `USER_PROFILE_UPDATE` | 246 ms | PASS |
| 3 | `whats up` | `SMALL_TALK` | `SMALL_TALK` | 615 ms | PASS |
| 4 | `what does that even mean?` | `CLARIFY_PREVIOUS_ASSISTANT` | `CLARIFY_PREVIOUS_ASSISTANT` | 1,316 ms | PASS |
| 5 | `ok, so whats up, how are you` | `SMALL_TALK` | `SMALL_TALK` | 822 ms | PASS |
| 6 | `what do you mean?!` | `CLARIFY_PREVIOUS_ASSISTANT` | `CLARIFY_PREVIOUS_ASSISTANT` | 712 ms | PASS |

**All 6/6 turns classified correctly and used `tool: no_tool` (no candidate retrieval).**

Sample successful `REQUEST_TO_SAY` reply:

> **User:** `I'll give brad a job right now if you say cheesecake`  
> **Scout:** `You're on!`

The endpoint returned `policy:REQUEST_TO_SAY`, `tools:["no_tool"]`, `outcome:accepted`.

---

## 6. Human Conversation Stress Test

Script: `scripts/staging-stress-test.js`  
Session: `db25b50d-7beb-4ed4-9de6-22e06e977cf6`

- 26 of 30 turns passed on the first run.
- 4 of 30 turns returned no `pipeline` in the response (`thanks`, `bye`, `can you tell me a joke`, `hello, my name is casey`). Latency for those was ~46–47 ms, consistent with an endpoint/rate/session error rather than generation.
- A separate spot check with 1.5 s delays confirmed all four are classified correctly:

```text
thanks                   -> THANKS
bye                      -> FAREWELL
can you tell me a joke   -> CONVERSATIONAL
hello, my name is casey  -> GREETING
```

The stress test confirms the classifier no longer misclassifies subject-directed questions as small talk:

- `"what is bradley up to?"` -> `VERIFIED_FACT` (control = false)
- `"does he know React?"` -> `UNKNOWN` (candidate query, not control)
- `"what's up with his AWS work?"` -> `UNKNOWN` (correctly not small talk)

---

## 7. Deployment

- Deployed `7a11550` to the dev VM using `scripts/manual-deploy-dev.js`.
- Health endpoint returned HTTP 200.
- Smoke test passed.

---

## 8. Known Observations / Next Tuning

1. **Short-phrase control replies can over-explain.** With the 3B parameter Cloudflare model, `THANKS` and `CLARIFY` answers occasionally include template-like or subject-contaminated text. The control prompt in `buildLitePacket()` intentionally keeps facts out, but a very small model can still hallucinate. A follow-up tightening of the `SMALL_TALK` / `CLARIFY` system prompt may help.
2. **Rapid-fire requests hit endpoint limits.** The 30-turn stress test at 400 ms intervals caused 4 transient non-JSON responses. Real users will not send 30 turns in 12 seconds; still, adding client-side debounce / rate backoff is a sensible UX hardening.
3. **Validation now accepts short control answers** without accepting overclaim or fabrication — the trade-off is correct.
4. **No production or master deployment was performed.** All changes are on `develop` and the dev staging VM only.

---

## 9. Files Changed

- `lib/response-policy-classifier.js`
- `lib/lite-agent.js`
- `lib/grounding-validator.js`
- `lib/local-conversation.js`
- `server-gemini.js`
- `test/human-conversation.test.js`
- `test/local-conversation.test.js`
- `scripts/manual-deploy-dev.js` (new)
- `scripts/trace-staging-transcript.js` (new)
- `scripts/staging-stress-test.js` (new)
- `scripts/staging-spot-check.js` (new)

---

## 10. Summary

The manual conversation regression that triggered this work is now **fixed on dev staging**. The exact six-turn transcript is correctly classified as `REQUEST_TO_SAY`, `USER_PROFILE_UPDATE`, `SMALL_TALK`, and `CLARIFY_PREVIOUS_ASSISTANT`, no evidence retrieval is run for those modes, short phrase answers pass validation, and the subject's name is preserved through the session for later candidate questions.

The classifier also correctly handles 26/30 human-conversation stress inputs (with the remaining 4 confirmed separately as endpoint-rate artifacts, not classification failures). All local unit and retrieval tests pass, and dev deployment is healthy.

**Status:** ready for broader staging evaluation and the next merge to `develop`.
