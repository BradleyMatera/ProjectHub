# Scout Productization V1 — Hardening Report

Scope: PR #33 branch `feat/scout-action-runtime`. Hardening pass over the V1
domain-package contract and action runtime before develop integration.

## Blocker resolutions

### 1. Capability contract — fail closed

`isCapabilityAllowed` previously returned `true` when `capabilities` was
absent or non-restrictive (fail-open). Now:

- A capability executes only when explicitly present in `capabilities.allow`.
- `deny` always wins; checked before `allow`.
- Missing `capabilities`, missing `allow`, or `allow: []` enables nothing.
- Allow-listed ids unknown to the registry are validation **errors**, not
  warnings — an id that can never execute is a broken contract.
- General Scout allows `calculator` only.
- Legacy bare-knowledge files load with the explicit
  `LEGACY_CAPABILITY_POLICY` (the four read-only capabilities, notification
  denied) — not an implicit global allow.
- Side effects additionally require permission scope + confirmation token +
  registered handler; package data can never grant scopes or register code.

### 2. Package reload / cross-tenant stale cache

Old behavior: invalid package load returned `knowledgeCache` and called it
fail closed — the previous tenant kept serving across a config switch.

New behavior (`transitionPackageState` + `fetchKnowledge` rewrite):

- Identity tracked per load: `sourceKey`, `manifestId`, resolved
  `knowledgePath`, `knowledgeHash` (sha256-16), status, staleness, load time.
- `publish` — validated package swaps knowledge, rebuilds BM25/RAG, clears
  response cache, reconfigures tool runtime + all knowledge-bound modules.
- `retain-stale` — allowed only when requested `sourceKey` AND resolved
  `knowledgePath` are provably unchanged; health reports `status: "stale"`.
- `drop` — source change + invalid (or first-load failure) clears ALL tenant
  state: knowledge snapshot, ragChunks, bm25Index, responseCache, readiness,
  capability manifest → deny-all `package-error`; knowledge-bound modules are
  reconfigured with empty knowledge so prior tenant names/aliases are
  dropped.
- Catastrophic load errors follow the same rule: retain only on identical
  source, otherwise drop.

### 3. Public /health action surface

`buildEnv.recentActions` (last 5 audit entries — chronology, args, results)
removed. `publicActionRuntimeSummary` exposes only:

`{ enabled, registeredCapabilities, enabledCapabilities, auditBuffered }`

`buildEnv.package` additionally reports `status`, `stale`, `knowledgeHash` —
truthful load-state reporting required by the transition contract. No new
unauthenticated endpoint for audit detail; ActionAudit stays internal
(bounded, in-memory, operator-local).

### 4. `runtime` key — removed from V1 contract

`runtime` is a hard validation error. Packages can never raise the global
deadline (≤15000 ms), disable validation, pick providers, grant scopes, or
move security boundaries. If a bounded runtime-config contract is needed
later it will be a separate schema — unknown keys are already warned.

## Additional hardening

- `knowledge.source` confined to approved roots (package dir + `<base>/data`
  default); absolute paths, `..` escapes, and symlink escapes rejected.
- Runtime-fact split: `data/scout-runtime-knowledge.json` neutralized;
  recruiter scope claims moved to `recruiter-knowledge.json` `systemFacts`.
  `buildRagChunks` supports `knowledge.systemFacts` and no longer emits a
  filler "the candidate" identity chunk for empty knowledge.
- `publications` added to `COLLECTION_TYPES`/`ENTITY_SECTIONS` — a generic
  entity collection, required by the schema-quality goal (non-recruiter
  packages are not bound to recruiter knowledge shapes).
- Custom knowledge sections are free-form; only known sections are
  type-pinned.
- Unknown top-level manifest keys warn (typo surface, not a fail).

## Action-runtime audit (items 1–22)

Verified structurally and via `test/package-hardening.test.js` +
`test/action-runtime.test.js`: unknown tool refused; not-allowed refused;
tenant-unavailable refused; missing scope refused; side effect without
confirmation refused; confirmation requires `canConfirm` (no static bypass);
args validated pre-handler; deadline uses remaining budget within the 15 s
product cap; timeouts typed `EXECUTION_ERROR`; provenance stays typed
(`COMPUTED_FACT`, `TENANT_EVIDENCE`, `TOOL_RESULT`); ToolResult.forModel
hides internals; no deterministic prose fallback on tool failure; package
data cannot register handlers or grant scopes; workflows declarative only;
no eval/dynamic-require/shell interpolation from package data.

## Evidence

- `npm test`: 1565/1565 pass (floor was 1513; +52 package/hardening tests)
- `npm run eval-retrieval`: Recall@6 = 1.000 (40/40), MRR@6 = 0.942
- `node --check server-gemini.js`: clean; `git diff --check`: clean
- `npm run workspace:check`: READY
- Package CLIs: all shipped packages VALID; `general` VALID

## Review state

Copilot review request submitted via API on head `b6979e4`; no reviewer
attached (previous review 5205522750 was quota-exhausted, not a code
review). All changed files independently inspected in-session; findings
above are the result.
