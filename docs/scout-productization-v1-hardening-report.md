# Scout Productization V1 — Hardening Report (Passes 2 + 3)

Scope: PR #33 branch `feat/scout-action-runtime`. Second hardening pass over
the V1 domain-package contract and action runtime, driven by independent
inspection of the pushed implementation. Supersedes the pass-1 wording;
pass-1 claims that were aspirational at the time (executor-side capability
enforcement, real confirmation grants, positive stale identity proof) are now
implemented and tested.

## Blocker resolutions

### 1. Capability policy enforced at the execution boundary

Pass 1 gated capabilities in `lite-agent` before calling `execute()` — a
caller bypassing the agent could execute a package-denied capability.

Now `ToolExecutor.execute()` itself runs the full gate order:

```
registered? → capabilityPolicy(toolId) → tenant availability →
permission scope → confirmation grant → arg schema → deadline → handler
```

The active package manifest is injected as a tenant-neutral
`capabilityPolicy` function (built from `isCapabilityAllowed` on
`domainPackageManifest`, which is `INVALID_PACKAGE_MANIFEST`/deny-all in
invalid state). lite-agent still pre-checks to avoid pointless calls, but it
is no longer the only gate. A denied attempt returns a typed
`CAPABILITY_NOT_ALLOWED` refusal, is audited, and never runs the handler.

Fail-closed semantics (from pass 1, unchanged): only explicit
`capabilities.allow` membership enables a capability; `deny` always wins;
missing/empty `allow` enables nothing; General Scout = calculator only;
legacy bare-knowledge files get the explicit `LEGACY_CAPABILITY_POLICY`.

### 2. Truthy-string confirmation removed — confirmation grants

Pass-1 `confirmationSatisfied` accepted any truthy `confirmationToken`.
Replaced by `ConfirmationGrantVerifier` (`lib/confirmation-grants.js`):

- `issue({toolId, args, principal})` → grant bound to tool id, normalized
  arg digest (sha256-16 of canonical JSON), principal, issuance, expiry,
  nonce. No raw args are stored in or recoverable from the grant.
- `consume(...)` is one-time: replay returns `GRANT_ALREADY_CONSUMED`.
- Tool A grant cannot authorize tool B; args A grant cannot authorize args B;
  expired grants rejected; principal mismatch rejected.
- No verifier injected → all side effects refuse by default. The default
  production runtime therefore has **no executable `action:write`
  capability** — `send_notification` is denied in every shipped manifest and
  additionally unconfirmable without a verifier.
- No confirmation value appears in `ToolResult.forModel()` or audit output.

### 3. Handler errors sanitized at the boundary

`ToolExecutor` no longer stores `String(err.message)` in the ToolResult or
audit. Model-facing results get a stable `EXECUTION_ERROR` category plus a
generic message. Audit entries store the typed category only. Detailed
diagnostics route to an optional injected `diagnostics` sink — operator-side,
not model context. Test coverage proves a `SUPER_SECRET_MARKER_123` thrown by
a handler appears nowhere in `forModel()`, audit serialization, or the public
health projection.

### 4. retain-stale requires positive identity proof

Pass-1 treated `knowledgePath == null` as proving sameness — a malformed
replacement package could retain the previous tenant.

Identity is now split:

- **Package/config identity:** `sourceKey`, `packageFileRealPath`,
  `configHash` (sha256-16 over the normalized package object), `manifestId`,
  `knowledgeSourceRealPath`.
- **Knowledge content identity:** `knowledgeHash`.

`retain-stale` is permitted **only** when package/config identity is
positively established as unchanged — same config fingerprint, same manifest
id, same resolved external knowledge source — and the failure is in the
knowledge content layer (e.g. backing file temporarily unreadable). Malformed
package JSON, changed manifest id, changed knowledge source declaration, or
any edited-into-invalid inline package all `drop`. Null/unknown fields never
count as proof. Legacy bare-knowledge files are both config and knowledge;
if one becomes malformed there is no config identity to prove, so it drops.

### 5. Invalid state no longer gets the 15-minute cache fast path

The fetch fast path now requires `packageCacheUsable`:
`activePackageIdentity.status === 'active'` AND `knowledgeReady` AND
`stale === false`. Dropped/invalid/stale state re-attempts the load on the
next request, so an operator fix recovers immediately instead of waiting out
the cache window. Covered by an A→invalid-B→fixed-B integration test.

### 6. Server validates against the real capability registry

`fetchKnowledge`/`loadDomainPackage` in `server-gemini.js` now passes
`knownCapabilities: toolRegistry` — the live `ToolRegistry`, not a CLI list.
An allow-listed capability unknown to the registry is a runtime validation
error: the package does not publish, drop semantics apply, and the capability
is never executable.

### 7. Package-file source security completed

Pass 1 confined `knowledge.source` only. Now the package file itself must
resolve (realpath, symlink-safe) inside an approved root:

- Default approved root: `<base>/data` — covers `data/packages/*` and legacy
  `data/recruiter-knowledge.json` without breaking deployments.
- Additional runtime roots via `SCOUT_PACKAGE_ROOTS` (path.delimiter list)
  or the `packageRoots` loader option.
- Traversal (`../`), absolute paths outside roots, and symlink escapes are
  rejected before the file is opened.
- Operator CLIs (`validate-package.js`, `inspect-package.js`) load with
  explicit `trustedOperator: true` — operator trust is a declared mode, not
  an accident.

### 8. Core vs deployment runtime facts

`data/scout-runtime-knowledge.json` is now architecture-only: tenant-neutral
statements about what Scout is (orchestration/intelligence runtime; retrieval
optional; model-authored prose; capability/evidence/validation architecture).
No "RAG-first" claim, no provider, model, host, or billing statements.

`lib/deployment-facts.js` generates deployment facts from actual runtime
config (`provider`, `model`, `deadlineMs`, rate limit) plus an optional
`data/deployment-facts.json` declaration file whose entries are provider-gated
(`when.provider`). A General Scout/Ollama deployment exposes no Cloudflare
claims; the current ProjectHub deployment still answers accurately about its
configured `@cf/meta/llama-3.1-8b-instruct-fast` model and free-tier facts.

### 9. Health surface (unchanged contract, restated)

`buildEnv.recentActions` stays removed. Public action surface is aggregates
only: `{ enabled, registeredCapabilities, enabledCapabilities,
auditBuffered }`. Package block reports `id/name/mode/legacy/warnings/
status/stale/knowledgeHash`.

## Action-runtime audit (items 1–20)

Verified structurally and via `test/package-hardening.test.js` +
`test/action-runtime.test.js`: package allow policy enforced inside the
executor; registry existence enforced; tenant availability enforced;
permission scopes enforced; side effects unexecutable under default runtime
(no verifier); grants cannot replay; grants bound to capability + arg digest
+ principal; args validated pre-handler; remaining deadline enforced;
handler failure contained and sanitized; timeouts produce typed
`EXECUTION_ERROR`, never prose; results keep typed provenance; tool output is
evidence, not authored prose; package data cannot register handlers, grant
scopes, or load code; workflows declarative only; no eval/dynamic require/
shell interpolation from package data; audit holds no raw secrets or grant
values; denied/failed actions audited as typed events; General Scout policy
remains calculator-only.

## Pass 3 — execution-contract completion

Independent inspection of the pass-2 pushed source found six remaining
runtime-boundary issues; all are fixed and tested.

### A. tenantAvailability is no longer bypassable

Pass-2 code ran the tenant gate only `if (context.knowledge)` — omitting
knowledge skipped availability entirely. The executor now evaluates
`isAvailableForTenant(descriptor, context.knowledge ?? null)` on every call:
knowledge-gated tools (knowledge_lookup, entity_lookup, content_search,
send_notification) fail closed with `TENANT_UNAVAILABLE` when no tenant
context exists; `tenantAvailability: true` tools (calculator) stay
available.

### B. Missing capabilityPolicy fails closed

`no capabilityPolicy → allow` is removed. An executor with no injected
policy denies every capability; deliberate standalone/internal executors
must opt in explicitly via `unscopedCapabilities: true` or the exported
`ALLOW_ALL_INTERNAL_POLICY`. The server continues injecting the live
package-policy resolver.

### C. Confirmation grant consumed last

Gate order is now registry → capability → tenant → permission → **args →
deadline → confirmation** → handler. A grant is consumed only when the
execution is actually authorized to proceed — invalid args or an
insufficient deadline refuse without burning the grant (tested: same grant
succeeds afterward with the exact issued args).

### D. Cancellation + ambiguous side-effect semantics

Handlers run under an `AbortController`; `context.signal` aborts on tool
timeout and the timer is always cleared. Side-effecting descriptors must
declare `idempotent` + `supportsAbort` (registration-time validation).
A timed-out side effect returns `EXECUTION_STATUS_UNKNOWN` — the adapter
may have committed — never a false "failed", and the executor never
auto-retries a side effect. Side-effect handlers receive a stable
per-execution `context.idempotencyKey`.

### E. Diagnostics redaction by default

The diagnostics sink now receives a safe record — `{tool, errorType,
timedOut, durationMs, errorFingerprint}` (sha256-16 of the raw message,
one-way correlation only). Raw handler exception text is emitted only when
`rawDiagnostics: true` is explicitly set — a development-only option, off
in the hosted path. `SUPER_SECRET_MARKER_123` is absent from model output,
audit, health, and default diagnostics.

### F. Deployment-profile boundary for declared facts

`data/deployment-facts.json` declares `profile: "projecthub-hosted"` and
loads only when explicitly selected: `SCOUT_DEPLOYMENT_PROFILE` env, the
deploy pipeline's stamped `deploy-source.json` `deploymentProfile` (added
in `manual-deploy-dev.js`), or an explicit `SCOUT_DEPLOYMENT_FACTS_FILE`.
No selection → generated config facts only. A bare checkout / isolated
General Scout boot emits no GitHub Pages / GCP / Cloudflare claims.
Unknown profiles fail closed. Provider-gated facts still require the
configured provider.

## Evidence

- `npm test`: 1621/1621 pass (floors: 1565 → 1601 → 1621)
- `npm run eval-retrieval`: Recall@6 = 1.000 (40/40), MRR@6 = 0.942
- `node --check` on all touched files: clean; `git diff --check`: clean
- `npm run workspace:check`: READY
- Package CLIs: all shipped packages VALID; `general` VALID
- `npm audit`: 4 advisories (2 moderate, 2 high — dompurify, nanoid,
  postcss, qs) — pre-existing dependency state, unchanged by this work;
  below the configured CI high-severity failure threshold.
- Frozen runtime SHA + exact-SHA CI + DEV verification: see PR #33 body and
  the commit history for the deployed head recorded at freeze time.

## Review state (accurate history)

- Copilot review 5205522750 (commit `72d59e2`): quota exhausted — not a code
  review.
- Copilot review 5222017585 (commit `b6979e4`): quota exhausted — not a code
  review.
- Copilot review 5235097347 (commit `25c656b`, pass-2 frozen head, submitted
  2026-09-17T11:39:15Z): quota exhausted — not a code review.
- Pass 3: no further Copilot request was made (three confirmed quota
  exhaustions). Recorded as
  `EXTERNAL_COPILOT_REVIEW_UNAVAILABLE_QUOTA` — an external advisory
  limitation, not a code review and not a findings claim. Branch readiness
  rests on pushed-source inspection, the deterministic suite, exact-SHA CI,
  DEV qualification, and Bradley's own review workflow.
