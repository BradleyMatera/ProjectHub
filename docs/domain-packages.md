# Scout Domain Packages

A **domain package** is the stable contract for specializing Scout Core into a
Scout application. Scout Core loads a package; a package never patches Core
code. Core + no domain package = **General Scout mode** — a first-class
runtime configuration, not a missing-data accident.

```text
Scout Core
  + domain package (identity, knowledge, policies, capabilities, workflows)
  = a specialized Scout application
```

## Selecting a package

```bash
# Domain application (package manifest file)
SCOUT_DOMAIN_PACKAGE=data/packages/rivera-home-electric.package.json node server-gemini.js

# General Scout — no domain knowledge, conversation + compute only
SCOUT_DOMAIN_PACKAGE=general node server-gemini.js

# Legacy — a bare knowledge JSON still works exactly as before
KNOWLEDGE_FILE=data/recruiter-knowledge.json node server-gemini.js
```

The active package (id, name, mode, warning count, load status, staleness,
knowledge hash) is reported on `GET /health` under `buildEnv.package`, and
`buildEnv.actionRuntime` exposes safe aggregates only (registered/enabled
capability counts, audit buffer size) — never action history, arguments,
results, or tenant data.

### Package-identity-bound cache transitions

`transitionPackageState` decides what the runtime may do on every (re)load:

| Decision | Condition | Effect |
|----------|-----------|--------|
| `publish` | requested package validates | swap knowledge, rebuild BM25/RAG, clear response cache, reconfigure tool runtime |
| `retain-stale` | **same** package/config identity — identical `configHash`, `manifestId`, and resolved knowledge source — but the backing knowledge content fails to load | keep last validated snapshot, report `stale`/`status: "stale"` on health |
| `drop` | requested source changed and is invalid, package file unparseable, manifest id changed, knowledge source declaration changed, or first load fails | clear ALL tenant state: knowledge snapshot, RAG/BM25, response cache, readiness, capability manifest (→ deny-all `package-error`) |

Identity is proven, never assumed: package/config identity (`sourceKey`,
`packageFileRealPath`, `configHash`, `manifestId`, `knowledgeSourceRealPath`)
is tracked separately from knowledge-content identity (`knowledgeHash`).
Null/unknown fields are never treated as proof of sameness — a malformed
package file at a known pathname drops rather than retains. Legacy
bare-knowledge files are config *and* knowledge; a malformed legacy file has
no provable config identity, so it drops.

A configuration switch that fails can never keep serving the previous
tenant's knowledge. Health reports the true state; staleness is never
silently treated as current. Dropped/invalid state is not served by the
knowledge-cache fast path — the loader retries on the next request, so an
operator fix recovers immediately.

## Package shape

```jsonc
{
  "packageVersion": 1,            // required — contract version
  "kind": "domain-package",
  "id": "rivera-home-electric",   // required — lowercase slug
  "name": "Rivera Home Electric", // required — display name
  "description": "...",
  "identity": {                   // informational app identity (optional)
    "applicationName": "...", "assistantName": "Scout"
  },
  "knowledge": {                  // inline knowledge object, OR:
    "source": "../knowledge.json" // relative path to a knowledge file
  },
  "capabilities": {
    "allow": ["calculator", "knowledge_lookup"],  // registry capability ids
    "deny":  ["send_notification"]                // deny wins over allow
  },
  "policies": { "confirmation": "...", "worldModel": "..." },
  "workflows": [{ "id": "wf", "steps": ["resolve", "retrieve", "calculator"] }],
  "presentation": { "headerTitle": "Scout", "headerSubtitle": "..." }
}
```

There is **no `runtime` key** in the V1 contract. A package may never raise
the global Scout deadline (≤15000 ms), disable validation, select providers,
grant permission scopes, or move security boundaries — the key is a hard
validation error, not an ignored knob.

`knowledge.source` is resolved relative to the package file and **confined
to approved roots** (the package's own directory and `<base>/data` by
default). Absolute paths, `..` traversal outside the roots, and symlink
escapes are rejected.

The package file itself is confined the same way: runtime loads resolve its
real path inside `<base>/data` by default, plus any roots listed in
`SCOUT_PACKAGE_ROOTS` (path-delimiter) or the `packageRoots` loader option.
Symlink escapes are rejected before the file is opened. Operator CLIs
(`validate-package.js`, `inspect-package.js`) declare `trustedOperator`
explicitly — operator-selected paths are a deliberate trust mode, not a hole
in the runtime boundary.

Canonical runtime identity (name, pronouns, aliases) lives in
`knowledge.identity` — the same structure the Core has always consumed.
`identity` at the manifest level is informational only.

## Validation contract

`lib/domain-package.js` exports `validateDomainPackage(pkg, {knownCapabilities})`,
`loadDomainPackage(source, {baseDir, knownCapabilities, approvedRoots, packageRoots, trustedOperator})`,
`transitionPackageState(activeIdentity, loadResult)`,
`packageCacheUsable(identity, ready)`,
`isCapabilityAllowed(manifest, capabilityId)`, and
`publicActionRuntimeSummary({registry, manifest, auditEntries, configured})`.

**Errors (do not load):**

- missing/wrong `packageVersion`, missing `name`, malformed `id`
- `kind` other than `domain-package`
- `knowledge` non-object, or `knowledge.source` mixed with inline sections
- capability in both `allow` and `deny`, or duplicated
- `runtime` key present (not part of the V1 contract)
- allow-listed capability ids unknown to the registry — an id that cannot
  execute is a contract error, not noise
- collection sections (`projects`, `services`, `products`, `faq`,
  `boundaries`, `directAnswers`, `subjectAliases`, `systemFacts`, …) that
  are not arrays
- known object sections (`identity`, `contact`, `business`, …) that are not
  objects — custom sections are free-form JSON and are not type-pinned
- duplicate entity names across collections
- `subjectAliases` colliding with an entity name or entity alias
- `knowledge.source` escaping approved roots (absolute path, `..` traversal,
  symlink escape)

**Warnings (load anyway):** unknown top-level manifest keys, side-effecting
capabilities without a `policies.confirmation` block, workflow steps that are
neither builtin (`resolve`/`retrieve`/`compare`/`generate`/`validate`) nor
allowed capabilities, ambiguous entity aliases shared across collections
(contextual disambiguation handles them — recruiter data relies on this).

## CLI

```bash
node scripts/validate-package.js data/packages/recruiter-alpha.package.json
node scripts/inspect-package.js  data/packages/rivera-home-electric.package.json
node scripts/inspect-package.js  general
```

`inspect-package.js` prints manifest identity, knowledge-section inventory,
normalized entities with provenance paths, and per-capability ALLOW/DENY —
the operator inspection surface.

## Shipped packages

| Package | Domain | Knowledge |
|---------|--------|-----------|
| `recruiter-alpha` | Recruiter (reference app) | `data/recruiter-knowledge.json` via `source` |
| `rivera-home-electric` | Local service business | inline |
| `northstar-desk` | Product / B2B SaaS | inline |
| `general` | General Scout | empty by design |

All shipped packages allow the four read-only capabilities
(`calculator`, `knowledge_lookup`, `entity_lookup`, `content_search`) and deny
`send_notification`. General Scout allows `calculator` only.

## Capability semantics (fail closed)

`isCapabilityAllowed` permits a capability **only** when it appears in
`capabilities.allow`. Missing `capabilities`, missing `allow`, or
`allow: []` enables nothing; `deny` always wins. The policy is enforced
inside `ToolExecutor` (injected as `capabilityPolicy`), not only at agent
call sites — a denied attempt returns a typed `CAPABILITY_NOT_ALLOWED`
refusal and never reaches the handler.

Side effects additionally require a permission scope, a registered handler,
and a **one-time confirmation grant** verified by an injected
`ConfirmationGrantVerifier` (`lib/confirmation-grants.js`). Grants are bound
to the tool id, a normalized argument digest, an optional principal, an
expiry, and a nonce — a truthy string is never accepted, and a consumed
grant cannot replay. With no verifier injected, side effects always refuse;
the default runtime therefore has no executable `action:write` capability.
Package data alone can never make a side effect executable, grant scopes, or
register code.

Handler exceptions are sanitized at the executor: model-facing results and
the audit trail carry a stable typed error category and a generic message —
never raw exception text. Detailed diagnostics go only to an explicitly
injected operator sink.

Legacy bare-knowledge files (no `packageVersion`) load with the explicit
`LEGACY_CAPABILITY_POLICY` — the same four read-only capabilities, with
`send_notification` denied — rather than silently inheriting global access.

Packages may declare `knowledge.systemFacts` — tenant-scoped "what this app
covers" facts added to RAG evidence. The Core injects only neutral
architecture facts from `data/scout-runtime-knowledge.json` (tenant-neutral;
retrieval is described as optional, never as Scout's identity). Deployment
facts — configured provider/model, deadline, gated hosting/billing facts —
are generated at runtime by `lib/deployment-facts.js` from actual config plus
the provider-gated declarations in `data/deployment-facts.json`; an Ollama
deployment never sees a Cloudflare claim. Scope claims belong to the package
that owns them.
