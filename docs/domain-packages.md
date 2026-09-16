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
| `retain-stale` | **same** source key + resolved knowledge path, refresh failed | keep last validated snapshot, report `stale`/`status: "stale"` on health |
| `drop` | requested source changed and is invalid, or first load fails | clear ALL tenant state: knowledge snapshot, RAG/BM25, response cache, readiness, capability manifest (→ deny-all `package-error`) |

A configuration switch that fails can never keep serving the previous
tenant's knowledge. Health reports the true state; staleness is never
silently treated as current.

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

Canonical runtime identity (name, pronouns, aliases) lives in
`knowledge.identity` — the same structure the Core has always consumed.
`identity` at the manifest level is informational only.

## Validation contract

`lib/domain-package.js` exports `validateDomainPackage(pkg, {knownCapabilities})`,
`loadDomainPackage(source, {baseDir, knownCapabilities, approvedRoots})`,
`transitionPackageState(activeIdentity, loadResult)`,
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
`allow: []` enables nothing; `deny` always wins. Side effects additionally
require a permission scope, a confirmation token, and a registered handler —
package data alone can never make a side effect executable, grant scopes, or
register code.

Legacy bare-knowledge files (no `packageVersion`) load with the explicit
`LEGACY_CAPABILITY_POLICY` — the same four read-only capabilities, with
`send_notification` denied — rather than silently inheriting global access.

Packages may declare `knowledge.systemFacts` — tenant-scoped "what this app
covers" facts added to RAG evidence. The Core injects only neutral runtime
facts from `data/scout-runtime-knowledge.json`; scope claims belong to the
package that owns them.
