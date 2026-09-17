'use strict';

/**
 * domain-package — the stable contract for specializing Scout Core.
 *
 * A domain package is a JSON document that provides identity, knowledge,
 * policies, capability permissions, optional workflows, and presentation
 * metadata for one Scout application. The Core loads a package; the
 * package never patches Core code.
 *
 * Package shape (all sections optional except id/name/packageVersion):
 *   packageVersion   contract version (currently 1)
 *   kind             'domain-package'
 *   id               lowercase slug, e.g. 'recruiter-alpha'
 *   name             display name
 *   description      what the application is
 *   identity         optional informational identity block (canonical
 *                    identity for the runtime still lives in knowledge.identity)
 *   knowledge        tenant knowledge object, OR { source: 'relative/path.json' }
 *   policies         scope/boundary/evidence policy overrides
 *   capabilities     { allow: [...], deny: [...] } — registry capability ids
 *   workflows        [{ id, description, steps: [...] }]
 *   presentation     optional app-facing labels
 *
 *   `runtime` is NOT part of the V1 contract: packages may never raise the
 *   global Scout deadline, disable validation, select providers, grant
 *   scopes, or move security boundaries. The key is rejected outright.
 *
 * Backward compatibility: a bare knowledge JSON file (no packageVersion)
 * loads as a legacy package with an implicit manifest carrying the
 * explicit LEGACY_CAPABILITY_POLICY allow-list — legacy files do not
 * silently inherit global fail-open capability access.
 *
 * 'general' resolves to the built-in General Scout package: no domain
 * knowledge, compute capability only. Scout Core + no domain package is
 * a first-class runtime configuration, not a test accident.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { KNOWN_SCOPES } = require('./tool-registry');

const PACKAGE_SCHEMA_VERSION = 1;
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

// Knowledge sections that must be arrays of records when present.
// Note: sections like education, sitesAndProperties, and sourceMaterial vary
// legitimately between object and array shapes across tenants, so only the
// true collections are pinned to arrays. Any other section just cannot be a
// bare scalar (except top-level scalar metadata like version/lastUpdated).
const COLLECTION_SECTIONS = [
  'experience', 'certifications', 'projects', 'codePens', 'products',
  'services', 'publications', 'interviewStories', 'faq', 'boundaries',
  'directAnswers', 'claimCorrections', 'learnedAnswers', 'subjectAliases',
  'knownProjects', 'systemFacts'
];
// Sections whose items are entities that must not collide on name.
const ENTITY_SECTIONS = ['projects', 'codePens', 'products', 'services', 'publications'];
// Known object sections are pinned to objects; every other section — custom
// tenant data like `maintenanceWindows` or `readingRoomHours` — is free-form
// JSON so packages are not bound to the recruiter knowledge shape.
const KNOWN_OBJECT_SECTIONS = [
  'identity', 'goals', 'rules', 'metadata', 'knowledgeCompleteness',
  'business', 'contact', 'policies', 'sitesAndProperties', 'blogCatalog',
  'conversationQualityStandards', 'commonPatterns', 'agent'
];
const WORKFLOW_BUILTIN_STEPS = new Set(['resolve', 'retrieve', 'compare', 'generate', 'validate']);

const GENERAL_PACKAGE = Object.freeze({
  packageVersion: PACKAGE_SCHEMA_VERSION,
  kind: 'domain-package',
  id: 'general-scout',
  name: 'General Scout',
  description: 'Scout Core with no domain knowledge. Conversation, computation, and session state remain available; domain claims resolve as UNKNOWN.',
  capabilities: { allow: ['calculator'] },
  knowledge: {}
});

// Legacy compatibility: bare knowledge files predating the package contract
// get this explicit allow-list — the same read-only set the recruiter
// application declares — rather than an implicit "everything allowed".
const LEGACY_CAPABILITY_POLICY = Object.freeze({
  allow: Object.freeze(['calculator', 'knowledge_lookup', 'entity_lookup', 'content_search']),
  deny: Object.freeze(['send_notification'])
});

// Deny-all manifest used when a requested package fails to load. Under
// fail-closed semantics (isCapabilityAllowed) this permits nothing.
const INVALID_PACKAGE_MANIFEST = Object.freeze({
  packageVersion: PACKAGE_SCHEMA_VERSION,
  kind: 'domain-package',
  id: 'package-error',
  name: 'Invalid domain package',
  description: 'Placeholder manifest for a requested package that failed validation. No capabilities enabled.',
  capabilities: { allow: [] },
  invalid: true
});

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'packageVersion', 'kind', 'id', 'name', 'description', 'identity',
  'knowledge', 'policies', 'capabilities', 'workflows', 'presentation'
]);

function issue(path_, message, fix) {
  return { path: path_, message, fix };
}

/** Validate a parsed package document. Returns { ok, errors, warnings } —
 *  errors are fatal (do not load); warnings are surfaced but non-fatal. */
function validateDomainPackage(pkg, { knownCapabilities } = {}) {
  const errors = [];
  const warnings = [];
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return { ok: false, errors: [issue('$', 'package must be a JSON object', 'Provide a domain-package JSON document.')], warnings };
  }
  if (pkg.packageVersion !== PACKAGE_SCHEMA_VERSION) {
    errors.push(issue('packageVersion', `unsupported packageVersion ${JSON.stringify(pkg.packageVersion)}`,
      `Set packageVersion to ${PACKAGE_SCHEMA_VERSION}.`));
  }
  if (typeof pkg.id !== 'string' || !ID_PATTERN.test(pkg.id)) {
    errors.push(issue('id', `id must be a lowercase slug, got ${JSON.stringify(pkg.id)}`,
      'Use lowercase letters, digits, and dashes, e.g. "recruiter-alpha".'));
  }
  if (typeof pkg.name !== 'string' || !pkg.name.trim()) {
    errors.push(issue('name', 'name is required', 'Add a human-readable package name.'));
  }
  if (pkg.kind !== undefined && pkg.kind !== 'domain-package') {
    errors.push(issue('kind', `kind must be "domain-package", got ${JSON.stringify(pkg.kind)}`,
      'Set kind to "domain-package" or omit it.'));
  }
  // `runtime` is deliberately not part of the V1 contract — a package may
  // never raise the global deadline, disable validation, pick providers,
  // grant scopes, or move security boundaries.
  if (pkg.runtime !== undefined) {
    errors.push(issue('runtime', '"runtime" is not part of the V1 package contract', 'Remove it — packages cannot override runtime/security configuration.'));
  }
  for (const key of Object.keys(pkg)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key) && key !== 'runtime') {
      warnings.push(issue(key, `unknown top-level key "${key}"`, 'Unknown keys are ignored; remove them or check for typos.'));
    }
  }

  // ── knowledge ──
  const knowledge = pkg.knowledge;
  if (knowledge !== undefined) {
    if (knowledge === null || typeof knowledge !== 'object' || Array.isArray(knowledge)) {
      errors.push(issue('knowledge', 'knowledge must be an object or { source }', 'Provide a knowledge object or { "source": "./knowledge.json" }.'));
    } else if (knowledge.source !== undefined) {
      if (typeof knowledge.source !== 'string' || !knowledge.source.trim()) {
        errors.push(issue('knowledge.source', 'knowledge.source must be a non-empty path string', 'Point source at a JSON knowledge file relative to the package file.'));
      }
      if (Object.keys(knowledge).length > 1) {
        errors.push(issue('knowledge', 'knowledge cannot mix "source" with inline sections', 'Use either a source reference or inline knowledge, not both.'));
      }
    } else {
      validateKnowledge(knowledge, errors, warnings);
    }
  }

  // ── capabilities ──
  const caps = pkg.capabilities;
  if (caps !== undefined) {
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
      errors.push(issue('capabilities', 'capabilities must be an object with allow/deny arrays', 'Use { "allow": ["calculator"], "deny": [] }.'));
    } else {
      for (const key of Object.keys(caps)) {
        if (!['allow', 'deny'].includes(key)) {
          warnings.push(issue(`capabilities.${key}`, `unknown capabilities key "${key}"`, 'Only "allow" and "deny" are read.'));
        }
      }
      for (const list of ['allow', 'deny']) {
        const arr = caps[list];
        if (arr !== undefined && (!Array.isArray(arr) || arr.some(v => typeof v !== 'string'))) {
          errors.push(issue(`capabilities.${list}`, `${list} must be an array of capability id strings`, 'List registry capability ids such as "calculator".'));
        }
      }
      const declared = [...(caps.allow || []), ...(caps.deny || [])];
      const dupes = declared.filter((v, i) => declared.indexOf(v) !== i);
      if (dupes.length) errors.push(issue('capabilities', `duplicate capability ids: ${[...new Set(dupes)].join(', ')}`, 'Declare each capability once.'));
      const conflict = (caps.allow || []).filter(id => (caps.deny || []).includes(id));
      if (conflict.length) errors.push(issue('capabilities', `capabilities both allowed and denied: ${conflict.join(', ')}`, 'A capability must appear in only one list.'));
      const capLookup = capabilityLookup(knownCapabilities);
      if (capLookup) {
        for (const id of caps.allow || []) {
          const descriptor = capLookup(id);
          if (descriptor === null) {
            // Fail closed: an allow-listed id that the registry does not
            // know can never execute, so it is a contract error, not noise.
            errors.push(issue(`capabilities.allow`, `unknown capability "${id}"`, 'Register this capability in the runtime or remove it from allow.'));
          } else if (descriptor.sideEffect && !(pkg.policies && pkg.policies.confirmation)) {
            warnings.push(issue(`capabilities.allow`, `side-effecting capability "${id}" allowed without a policies.confirmation block`, 'Document who may confirm side-effecting actions for this tenant.'));
          }
        }
      }
    }
  }

  // ── workflows ──
  if (pkg.workflows !== undefined) {
    if (!Array.isArray(pkg.workflows)) {
      errors.push(issue('workflows', 'workflows must be an array', 'Provide [{ "id": "...", "steps": [...] }].'));
    } else {
      const wfIds = new Set();
      pkg.workflows.forEach((wf, i) => {
        const p = `workflows[${i}]`;
        if (!wf || typeof wf !== 'object') { errors.push(issue(p, 'workflow must be an object', 'Provide { id, steps }.')); return; }
        if (typeof wf.id !== 'string' || !wf.id.trim()) errors.push(issue(`${p}.id`, 'workflow id is required', 'Give each workflow a unique id.'));
        else if (wfIds.has(wf.id)) errors.push(issue(`${p}.id`, `duplicate workflow id "${wf.id}"`, 'Workflow ids must be unique.'));
        else wfIds.add(wf.id);
        if (!Array.isArray(wf.steps) || !wf.steps.length) {
          errors.push(issue(`${p}.steps`, 'workflow must declare a non-empty steps array', 'List step ids such as "resolve", "retrieve", or a capability id.'));
        } else {
          for (const step of wf.steps) {
            const stepId = typeof step === 'string' ? step : step && step.tool;
            const known = WORKFLOW_BUILTIN_STEPS.has(stepId) || (caps && (caps.allow || []).includes(stepId));
            if (!known) {
              warnings.push(issue(`${p}.steps`, `step "${JSON.stringify(step)}" is not a builtin step or allowed capability`, 'Use builtin steps (resolve/retrieve/compare/generate/validate) or allow the capability.'));
            }
          }
        }
      });
    }
  }

  // ── presentation / policies / manifest identity ──
  for (const key of ['presentation', 'policies', 'identity']) {
    if (pkg[key] !== undefined && (pkg[key] === null || typeof pkg[key] !== 'object' || Array.isArray(pkg[key]))) {
      errors.push(issue(key, `${key} must be an object`, `Provide a ${key} object or omit it.`));
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function validateKnowledge(knowledge, errors, warnings) {
  for (const section of COLLECTION_SECTIONS) {
    if (knowledge[section] !== undefined && !Array.isArray(knowledge[section])) {
      errors.push(issue(`knowledge.${section}`, `knowledge.${section} must be an array`, `Make ${section} an array or remove it.`));
    }
  }
  for (const section of KNOWN_OBJECT_SECTIONS) {
    const value = knowledge[section];
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      errors.push(issue(`knowledge.${section}`, `knowledge.${section} must be an object`, `Make ${section} an object or remove it.`));
    }
  }
  if (knowledge.identity && typeof knowledge.identity === 'object') {
    if (knowledge.identity.name !== undefined && typeof knowledge.identity.name !== 'string') {
      errors.push(issue('knowledge.identity.name', 'identity.name must be a string', 'Set the canonical subject name.'));
    }
    if (knowledge.identity.pronouns !== undefined) {
      const p = knowledge.identity.pronouns;
      const pronouns = Array.isArray(p) ? p : [p.subject, p.object, p.possessive];
      if (pronouns.some(v => v !== undefined && typeof v !== 'string')) {
        errors.push(issue('knowledge.identity.pronouns', 'pronouns must be strings or an array of strings', 'Use { subject, object, possessive } strings or a string array.'));
      }
    }
  }
  // Duplicate entity names across collections create ambiguous resolution.
  const seen = new Map();
  for (const section of ENTITY_SECTIONS) {
    for (const item of knowledge[section] || []) {
      const name = item && (item.name || item.title);
      if (typeof name !== 'string' || !name.trim()) {
        warnings.push(issue(`knowledge.${section}`, 'entity entry missing a name/title', 'Give every entity a name so it can be resolved.'));
        continue;
      }
      const norm = name.trim().toLowerCase();
      if (seen.has(norm)) {
        errors.push(issue(`knowledge.${section}`, `duplicate entity name "${name}" also declared in ${seen.get(norm)}`, 'Entity names must be unique across collections; use aliases for alternates.'));
      } else {
        seen.set(norm, `knowledge.${section}`);
      }
      for (const alias of item.aliases || []) {
        if (typeof alias !== 'string' || !alias.trim()) continue;
        const aNorm = alias.trim().toLowerCase();
        // Ambiguous aliases are tolerated (the resolver disambiguates by
        // context) but worth surfacing — a colliding subject alias stays fatal.
        if (seen.has(aNorm)) {
          warnings.push(issue(`knowledge.${section}`, `entity alias "${alias}" also used by ${seen.get(aNorm)}`, 'Prefer unique aliases; ambiguous aliases rely on contextual disambiguation.'));
        } else {
          seen.set(aNorm, `knowledge.${section} alias`);
        }
      }
    }
  }
  // subjectAliases must not collide with real entity names or aliases.
  for (const alias of knowledge.subjectAliases || []) {
    if (typeof alias === 'string' && seen.has(alias.trim().toLowerCase())) {
      errors.push(issue('knowledge.subjectAliases', `subject alias "${alias}" collides with a declared entity`, 'Rename the entity or remove the alias — alias/entity collisions break identity precedence.'));
    }
  }
}

function knowledgeHash(knowledge) {
  return crypto.createHash('sha256').update(JSON.stringify(knowledge ?? null)).digest('hex').slice(0, 16);
}

/** Content fingerprint of a package/config document — Buffer for file
 *  bytes, object for inline documents. */
function configHash(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(stableStringify(input ?? null));
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Path containment check, case-insensitive on Windows where the
 *  filesystem is case-insensitive. */
function isInsideRoots(resolvedPath, roots) {
  const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
  const target = norm(resolvedPath);
  return roots.some(root => {
    const r = norm(path.resolve(root));
    return target === r || target.startsWith(r + path.sep);
  });
}

function realpathOrResolved(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/**
 * Resolve a package's knowledge.source against the package directory and
 * confine it to approved roots. Package data may only read files under an
 * approved root — default roots are the package's own directory and
 * `<baseDir>/data` — never an absolute path and never via traversal.
 * Symlinks are resolved and re-checked so a link cannot escape the root.
 * Returns { path } or { error }.
 */
function resolveKnowledgeSource(pkgDir, source, { baseDir, approvedRoots } = {}) {
  if (typeof source !== 'string' || !source.trim()) {
    return { error: 'knowledge.source must be a non-empty relative path' };
  }
  if (path.isAbsolute(source)) {
    return { error: `knowledge.source "${source}" is absolute; only paths relative to the package file are allowed` };
  }
  const resolved = path.resolve(pkgDir, source);
  const roots = (approvedRoots || [pkgDir, path.resolve(baseDir, 'data')]);
  if (!isInsideRoots(resolved, roots)) {
    return { error: `knowledge.source "${source}" resolves outside the approved roots (${roots.map(r => path.resolve(r)).join(', ')})` };
  }
  try {
    const real = fs.realpathSync.native(resolved);
    if (!isInsideRoots(real, roots)) {
      return { error: `knowledge.source "${source}" resolves through a symlink outside the approved roots` };
    }
  } catch {
    // File may not exist — the reader reports that error; confinement held.
  }
  return { path: resolved };
}

/**
 * Confine a runtime-loaded package file to approved package roots.
 * Default root is `<baseDir>/data` — the shipped package/knowledge
 * directory. Deployments may authorize additional roots via
 * `packageRoots` (server maps SCOUT_PACKAGE_ROOTS onto it). Operator
 * tooling passes `trustedOperator: true` — an explicit, documented bypass
 * for operator-selected files, never set by the runtime path.
 * Returns { path } or { error }.
 */
function resolvePackageSource(source, { baseDir, packageRoots, trustedOperator } = {}) {
  if (trustedOperator) {
    const resolved = path.resolve(baseDir, source);
    return { path: resolved, realPath: realpathOrResolved(resolved) };
  }
  const roots = (packageRoots && packageRoots.length ? packageRoots : [path.resolve(baseDir, 'data')]);
  const resolved = path.resolve(baseDir, source);
  if (!isInsideRoots(resolved, roots)) {
    return { error: `package source "${source}" resolves outside the approved package roots (${roots.map(r => path.resolve(r)).join(', ')})` };
  }
  const realPath = realpathOrResolved(resolved);
  if (!isInsideRoots(realPath, roots)) {
    return { error: `package source "${source}" resolves through a symlink outside the approved package roots` };
  }
  return { path: resolved, realPath };
}

/**
 * Normalize a known-capabilities collection — a Map, a ToolRegistry-like
 * object with get/has, or an id array — into a descriptor lookup. */
function capabilityLookup(knownCapabilities) {
  if (!knownCapabilities) return null;
  if (knownCapabilities instanceof Map || typeof knownCapabilities.get === 'function') {
    return id => knownCapabilities.get(id) || null;
  }
  if (typeof knownCapabilities.has === 'function') {
    return id => (knownCapabilities.has(id) ? { id } : null);
  }
  if (Array.isArray(knownCapabilities)) {
    return id => (knownCapabilities.includes(id) ? { id } : null);
  }
  return null;
}

function baseIdentity(overrides = {}) {
  return {
    sourceKey: null,
    packageFileRealPath: null,
    packageConfigHash: null,
    manifestId: null,
    knowledgeSourceRealPath: null,
    knowledgeHash: null,
    ...overrides
  };
}

/**
 * Load and validate a domain package.
 * @param {string|object|null} source — 'general', a file path, a parsed package
 *   object, or a bare knowledge object (legacy).
 * @param {object} [opts] — { baseDir, knownCapabilities, approvedRoots,
 *   packageRoots, trustedOperator }
 * @returns {{ ok:boolean, manifest:object, knowledge:object, errors:array,
 *   warnings:array, identity:{sourceKey,packageFileRealPath,packageConfigHash,
 *   manifestId,knowledgeSourceRealPath,knowledgeHash} }}
 *
 * The identity object separates package/config identity (file realpath +
 * content fingerprint + manifest id) from loaded-knowledge identity
 * (resolved source realpath + content hash). transitionPackageState uses it
 * to prove — not assume — that a failed reload is the same package.
 */
function loadDomainPackage(source, { baseDir = process.cwd(), knownCapabilities, approvedRoots, packageRoots, trustedOperator } = {}) {
  const fail = (errors, identity, warnings = []) =>
    ({ ok: false, manifest: null, knowledge: null, errors, warnings, identity });
  const done = (manifest, knowledge, errors, warnings, identity) =>
    ({ ok: errors.length === 0, manifest, knowledge: errors.length ? null : knowledge, errors, warnings, identity });

  if (source === 'general' || source === null || source === undefined) {
    return {
      ok: true, manifest: GENERAL_PACKAGE, knowledge: {}, errors: [], warnings: [],
      identity: baseIdentity({ sourceKey: 'general', packageConfigHash: configHash(GENERAL_PACKAGE), manifestId: GENERAL_PACKAGE.id, knowledgeHash: knowledgeHash({}) })
    };
  }

  let pkg = source;
  let pkgDir = baseDir;
  let sourceKey = 'inline-object';
  let packageFileRealPath = null;
  let packageConfigHash = null;
  let packagePath = null;
  if (typeof source === 'string') {
    const resolved = resolvePackageSource(source, { baseDir, packageRoots, trustedOperator });
    packagePath = resolved.path || path.resolve(baseDir, source);
    packageFileRealPath = resolved.realPath || null;
    sourceKey = packageFileRealPath || packagePath;
    if (resolved.error) {
      return fail(
        [issue('$', resolved.error, 'Keep the package file inside an approved package/data root, or configure a trusted root.')],
        baseIdentity({ sourceKey, packageFileRealPath }));
    }
    let raw;
    try {
      raw = fs.readFileSync(packagePath);
      pkg = JSON.parse(raw.toString('utf8'));
      packageConfigHash = configHash(raw);
    } catch (err) {
      // The package file itself is unreadable/malformed — identity cannot
      // be positively established, so nothing may be retained from it.
      return fail(
        [issue('$', `cannot read package file ${packagePath}: ${err.message}`, 'Check the path and JSON syntax.')],
        baseIdentity({ sourceKey, packageFileRealPath }));
    }
    pkgDir = path.dirname(packagePath);
  } else {
    // Inline object: the document itself is the configuration fingerprint.
    packageConfigHash = configHash(pkg);
  }

  // Legacy path: a bare knowledge document (identity/skills/etc., no manifest).
  // The file is both configuration and knowledge — there is no separate
  // config identity to prove unchanged, so any failure here drops state.
  if (pkg && typeof pkg === 'object' && pkg.packageVersion === undefined &&
      (pkg.identity || pkg.skills || pkg.projects || pkg.experience || pkg.summary)) {
    const errors = [], warnings = [];
    validateKnowledge(pkg, errors, warnings);
    const manifest = {
      packageVersion: PACKAGE_SCHEMA_VERSION,
      id: 'legacy-knowledge',
      name: 'Unmanaged knowledge file',
      legacy: true,
      capabilities: LEGACY_CAPABILITY_POLICY
    };
    return done(manifest, pkg, errors, warnings, baseIdentity({
      sourceKey, packageFileRealPath, packageConfigHash,
      manifestId: manifest.id,
      knowledgeSourceRealPath: packageFileRealPath,
      knowledgeHash: errors.length ? null : knowledgeHash(pkg)
    }));
  }

  const { ok, errors, warnings } = validateDomainPackage(pkg, { knownCapabilities });
  const manifestId = pkg && typeof pkg === 'object' && typeof pkg.id === 'string' ? pkg.id : null;
  let knowledge = {};
  let knowledgeSourceRealPath = null;
  if (ok && pkg.knowledge && typeof pkg.knowledge === 'object' && typeof pkg.knowledge.source === 'string') {
    const resolved = resolveKnowledgeSource(pkgDir, pkg.knowledge.source, { baseDir, approvedRoots });
    knowledgeSourceRealPath = resolved.path ? realpathOrResolved(resolved.path) : null;
    const identity = () => baseIdentity({ sourceKey, packageFileRealPath, packageConfigHash, manifestId, knowledgeSourceRealPath });
    if (resolved.error) {
      return done(pkg, null,
        [...errors, issue('knowledge.source', resolved.error, 'Keep knowledge.source relative and inside the package or data root.')],
        warnings, identity());
    }
    try {
      knowledge = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
    } catch (err) {
      // Package config fully proved (file bytes + manifest id + resolved
      // knowledge path) — only the backing knowledge failed. This is the
      // one case transitionPackageState may legitimately retain-stale.
      return done(pkg, null,
        [...errors, issue('knowledge.source', `cannot read knowledge source ${resolved.path}: ${err.message}`, 'Check the knowledge file path relative to the package.')],
        warnings, identity());
    }
    const kErrors = [], kWarnings = [];
    validateKnowledge(knowledge, kErrors, kWarnings);
    errors.push(...kErrors.map(e => ({ ...e, path: `knowledge.source→${e.path}` })));
    warnings.push(...kWarnings);
    return done(pkg, errors.length ? null : knowledge, errors, warnings,
      baseIdentity({ sourceKey, packageFileRealPath, packageConfigHash, manifestId, knowledgeSourceRealPath, knowledgeHash: errors.length ? null : knowledgeHash(knowledge) }));
  }
  if (pkg && typeof pkg === 'object' && pkg.knowledge && typeof pkg.knowledge === 'object') {
    knowledge = pkg.knowledge;
  }
  return done(pkg, knowledge, errors, warnings, baseIdentity({
    sourceKey, packageFileRealPath, packageConfigHash, manifestId,
    knowledgeSourceRealPath, knowledgeHash: ok ? knowledgeHash(knowledge) : null
  }));
}

/**
 * Package-identity-bound cache transition. Decides what the runtime may do
 * with the last validated package state when (re)loading a package.
 *
 *   action 'publish'      — new package validated; publish it fully
 *   action 'retain-stale' — the SAME package config provably unchanged while
 *                           its backing knowledge failed: keep the last
 *                           validated snapshot and report stale/degraded
 *   action 'drop'         — identity cannot be positively proven unchanged:
 *                           clear all tenant state
 *
 * retain-stale requires POSITIVE identity proof — every field must be
 * non-null and equal:
 *   sourceKey (requested source), packageConfigHash (package file bytes or
 *   inline document), manifestId, and knowledgeSourceRealPath (declared
 *   knowledge source resolution). A null/unknown field is never treated as
 *   proof of sameness. This means: identical package file whose external
 *   knowledge source temporarily fails → retain-stale; malformed package
 *   file, changed manifest id, changed source declaration, edited inline
 *   package, or a different tenant under the same pathname → drop.
 */
function transitionPackageState(active, loadResult) {
  const next = loadResult.identity || {};
  if (loadResult.ok) {
    return {
      action: 'publish',
      knowledge: loadResult.knowledge || {},
      manifest: loadResult.manifest,
      errors: loadResult.errors,
      warnings: loadResult.warnings,
      active: { ...baseIdentity(next), status: 'active', stale: false, loadedAt: new Date().toISOString(), lastError: null }
    };
  }
  const samePackage = !!active && active.status === 'active' &&
    active.sourceKey != null && active.sourceKey === next.sourceKey &&
    next.packageConfigHash != null && next.packageConfigHash === active.packageConfigHash &&
    next.manifestId != null && next.manifestId === active.manifestId &&
    (next.knowledgeSourceRealPath ?? null) === (active.knowledgeSourceRealPath ?? null);
  if (samePackage) {
    return {
      action: 'retain-stale',
      errors: loadResult.errors,
      warnings: loadResult.warnings,
      active: { ...active, status: 'stale', stale: true, lastError: loadResult.errors.map(e => e.message).join('; ') }
    };
  }
  return {
    action: 'drop',
    knowledge: {},
    manifest: INVALID_PACKAGE_MANIFEST,
    errors: loadResult.errors,
    warnings: loadResult.warnings,
    active: { ...baseIdentity(next), manifestId: null, status: 'invalid', stale: false, loadedAt: null, lastError: loadResult.errors.map(e => e.message).join('; ') }
  };
}

/**
 * May the runtime serve the cached knowledge snapshot on the normal fast
 * path? Only an active, non-stale, published package may — an
 * invalid/dropped state (empty knowledge) must never ride the cache TTL;
 * it must retry so a fixed package recovers promptly.
 */
function packageCacheUsable(activeIdentity, knowledgeReady) {
  return !!activeIdentity &&
    activeIdentity.status === 'active' &&
    activeIdentity.stale !== true &&
    knowledgeReady === true;
}

/**
 * Fail-closed capability gate. A capability executes only if the manifest
 * explicitly allows it. deny always wins; a missing capabilities block, a
 * missing allow list, or an empty allow list enables NOTHING. Unknown ids
 * can never become available (they are not in the registry and the
 * executor refuses unknown tools anyway).
 */
function isCapabilityAllowed(manifest, capabilityId) {
  const caps = manifest && manifest.capabilities;
  if (!caps || !Array.isArray(caps.allow)) return false;
  if (Array.isArray(caps.deny) && caps.deny.includes(capabilityId)) return false;
  return caps.allow.includes(capabilityId);
}

/**
 * Safe public-health projection of the action runtime. Aggregates only —
 * no chronology, arguments, results, destinations, or tenant data. This is
 * the complete public surface for action state; detailed audit inspection
 * stays internal (operator tooling / local logs).
 */
function publicActionRuntimeSummary({ registry, manifest, auditEntries, configured }) {
  const registered = registry ? registry.list().length : 0;
  const enabled = manifest && registry
    ? registry.list().filter(d => isCapabilityAllowed(manifest, d.id)).length
    : 0;
  return {
    enabled: !!configured,
    registeredCapabilities: registered,
    enabledCapabilities: enabled,
    auditBuffered: auditEntries ? auditEntries.length : 0
  };
}

module.exports = {
  PACKAGE_SCHEMA_VERSION, GENERAL_PACKAGE, LEGACY_CAPABILITY_POLICY,
  INVALID_PACKAGE_MANIFEST, validateDomainPackage, loadDomainPackage,
  transitionPackageState, packageCacheUsable, isCapabilityAllowed,
  publicActionRuntimeSummary, resolveKnowledgeSource, resolvePackageSource,
  KNOWN_SCOPES
};
