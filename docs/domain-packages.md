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

The active package (id, name, mode, warning count) is reported on `GET /health`
under `buildEnv.package`. Invalid packages fail closed: the server keeps the
last valid package and logs `ERROR` lines naming the offending paths.

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

Canonical runtime identity (name, pronouns, aliases) lives in
`knowledge.identity` — the same structure the Core has always consumed.
`identity` at the manifest level is informational only.

## Validation contract

`lib/domain-package.js` exports `validateDomainPackage(pkg, {knownCapabilities})`,
`loadDomainPackage(source, {baseDir, knownCapabilities})`, and
`isCapabilityAllowed(manifest, capabilityId)`.

**Errors (do not load):**

- missing/wrong `packageVersion`, missing `name`, malformed `id`
- `kind` other than `domain-package`
- `knowledge` non-object, or `knowledge.source` mixed with inline sections
- capability in both `allow` and `deny`, or duplicated
- collection sections (`projects`, `services`, `products`, `faq`,
  `boundaries`, `directAnswers`, `subjectAliases`, …) that are not arrays
- non-scalar knowledge keys that are bare scalars
- duplicate entity names across collections
- `subjectAliases` colliding with an entity name or entity alias

**Warnings (load anyway):** unknown capability ids, side-effecting capabilities
without a `policies.confirmation` block, workflow steps that are neither
builtin (`resolve`/`retrieve`/`compare`/`generate`/`validate`) nor allowed
capabilities, ambiguous entity aliases shared across collections.

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
