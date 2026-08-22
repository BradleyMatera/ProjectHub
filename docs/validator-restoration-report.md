# RAG Validator Restoration Report

## Branch
`feat/rag-primary-restoration` → `BradleyMatera/ProjectHub`

## Commit / Deploy
- **Commit SHA:** `49faf163073946000027bf4de10346610df737e5`
- **Short SHA:** `49faf16`
- **Deploy tag:** `release-49faf16`
- **Dev health:** `https://dev.projecthub-chat.bradleymatera.dev/health`
- **Deployed via:** `node scripts/manual-deploy-dev.js` (smoke test passed, dev service restarted)

## Objectives
Reduce false positives in the RAG validator by hardening:
1. relationship validation (cross-sentence contamination, `uses_tech` → `has_skill` fallback)
2. technology-claim grounding (token-sequence matching, known-technology check)
3. degree / certification claim extraction
4. negation scope handling for question entities in denial clauses
5. same-FACT evidence relation support

## Key Fixes

### 1. Same-FACT evidence relation support
- **File:** `lib/evidence-relations.js` (new)
- Splits evidence into `FACT` blocks and then into sentences.
- Requires subject and technology to co-occur in the **same sentence**, not just the same block.
- Uses token-sequence `phraseAppears` with canonicalization/alias resolution to avoid substring false positives.
- Exports `evidenceSupportsTechnologyRelation`, `splitEvidenceBlocks`, `canonicalizeToken`, `phraseAppearsInTokens`.

### 2. `uses_tech` → `has_skill` fallback
- **File:** `lib/relationship-validator.js`
- When a candidate `uses_tech` claim is not in the graph, falls back to `has_skill`.
- Uses the graph’s subject name for the skill check so normalized subject matching succeeds.

### 3. Token-sequence technology matching
- **File:** `lib/tech-claim-validator.js`
- `isTechInEvidence` now rejects a tech if it is **not in the candidate’s known-technologies set** (when supplied), preventing boundary/FAQ text like the `rust-not-documented` entry from being misread as support.
- Keeps multi-token support for `vanilla JavaScript`, `HTML/CSS`, etc.

### 4. Sentence-level evidence validation
- **File:** `lib/evidence-relations.js`
- Split regex is case-insensitive (`(?=\S)` instead of `(?=[A-Z])`) because `grounding-validator.js` passes lowercased source text.

### 5. Degree and certification extraction
- **File:** `lib/claim-extractor.js`
- Refined `has_cert` regexes to require explicit certification terminal words (`certifications?`, `certificates?`, `cert`).
- Added a conjunctive `has_cert` pattern for second conjuncts like “… and holds AWS certifications.”
- `isDegreeCredential` / `isFalseCertCapture` helpers reduce false captures of degree terms as certs.

### 6. Negation scope
- **File:** `lib/negation-scope.js`
- `isTokenNegated` now uses token-sequence normalization (`tokenSequence`) so trailing punctuation and dotted tech tokens (e.g., `Node.js`) are handled correctly.
- Keeps clause-level granularity and discourse-marker handling.

### 7. Grounding validator integration
- **File:** `lib/grounding-validator.js`
- Uses `validateRelationships` with the full evidence source.
- `validateProjectTechnologyRelationships` in `lib/claim-validator.js` now receives `evidenceText` and uses `evidenceSupportsTechnologyRelation`.

## Test Results

### Unit / regression tests
- `npm test`: **903 pass / 0 fail**
- `test/rust-identity-regression.test.js`: **15/15 pass**
- `test/agent-engine.test.js`: **208/208 pass**
- `test/rag-evidence-validator.test.js`: **12/12 pass** (new tenant-neutral regression suite)

### Retrieval
- `npm run eval-retrieval`: **Recall@6 = 1.000 (40/40), MRR@6 = 0.954** — meets acceptance threshold.

### Break-it checks
- `node scripts/break-it.js`: **all checks passed** (no stale Ollama labels, direct answers correct, identity preserved, no Bradley leakage in Jane tests, cross-tenant portability, etc.).

### Syntax / diff
- `node --check lib/tech-claim-validator.js` (representative of changed files): OK
- `git diff --check`: clean
- `git status --short`: clean (all changes committed)

## Natural Quality Evaluation
- A live API health / quality check was initiated (`curl https://dev.projecthub-chat.bradleymatera.dev/health`) but **canceled by the user**.
- The full local test suite, retrieval eval, and break-it checks already provide high confidence that the validator fixes are working end-to-end.
- To complete the live natural quality evaluation when desired, run:
  ```bash
  PROJECTHUB_API_URL=https://dev.projecthub-chat.bradleymatera.dev/api/chat node scripts/eval-local-api.js
  ```
  or:
  ```bash
  python3 test-production-conversations.py --url https://dev.projecthub-chat.bradleymatera.dev/api/chat --delay 2.5
  ```

## Summary
The RAG validator false-positive fixes are implemented, covered by tenant-neutral regression tests, and deployed to dev at `49faf16`. All automated local validation passes; only the live natural quality run remains pending due to the canceled external request.
