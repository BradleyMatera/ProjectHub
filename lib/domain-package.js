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
      if (knownCapabilities) {
        for (const id of caps.allow || []) {
          const descriptor = knownCapabilities instanceof Map ? knownCapabilities.get(id) : null;
          if (descriptor === null || (descriptor === undefined && !knownCapabilities.has(id))) {
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
  const roots = (approvedRoots || [pkgDir, path.resolve(baseDir, 'data')])
    .map(r => path.resolve(r));
  const inside = p => roots.some(r => p === r || p.startsWith(r + path.sep));
  if (!inside(resolved)) {
    return { error: `knowledge.source "${source}" resolves outside the approved roots (${roots.join(', ')})` };
  }
  try {
    const real = fs.realpathSync.native(resolved);
    if (!inside(real)) {
      return { error: `knowledge.source "${source}" resolves through a symlink outside the approved roots` };
    }
  } catch {
    // File may not exist — the reader reports that error; confinement held.
  }
  return { path: resolved };
}

/**
 * Load and validate a domain package.
 * @param {string|object|null} source — 'general', a file path, a parsed package
 *   object, or a bare knowledge object (legacy).
 * @param {object} [opts] — { baseDir, knownCapabilities, approvedRoots }
 * @returns {{ ok:boolean, manifest:object, knowledge:object, errors:array,
 *   warnings:array, identity:{sourceKey,manifestId,knowledgePath,knowledgeHash} }}
 */
function loadDomainPackage(source, { baseDir = process.cwd(), knownCapabilities, approvedRoots } = {}) {
  const fail = (errors, identity, warnings = []) =>
    ({ ok: false, manifest: null, knowledge: null, errors, warnings, identity });
  const done = (manifest, knowledge, errors, warnings, identity) =>
    ({ ok: errors.length === 0, manifest, knowledge: errors.length ? null : knowledge, errors, warnings, identity });

  if (source === 'general' || source === null || source === undefined) {
    return {
      ok: true, manifest: GENERAL_PACKAGE, knowledge: {}, errors: [], warnings: [],
      identity: { sourceKey: 'general', manifestId: GENERAL_PACKAGE.id, knowledgePath: null, knowledgeHash: knowledgeHash({}) }
    };
  }

  let pkg = source;
  let pkgDir = baseDir;
  let sourceKey = 'inline-object';
  let packagePath = null;
  if (typeof source === 'string') {
    packagePath = path.resolve(baseDir, source);
    sourceKey = packagePath;
    try {
      pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    } catch (err) {
      return fail(
        [issue('$', `cannot read package file ${packagePath}: ${err.message}`, 'Check the path and JSON syntax.')],
        { sourceKey, manifestId: null, knowledgePath: null, knowledgeHash: null });
    }
    pkgDir = path.dirname(packagePath);
  }

  // Legacy path: a bare knowledge document (identity/skills/etc., no manifest).
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
    return done(manifest, pkg, errors, warnings,
      { sourceKey, manifestId: manifest.id, knowledgePath: packagePath, knowledgeHash: knowledgeHash(pkg) });
  }

  const { ok, errors, warnings } = validateDomainPackage(pkg, { knownCapabilities });
  const manifestId = pkg && typeof pkg === 'object' && typeof pkg.id === 'string' ? pkg.id : null;
  let knowledge = {};
  let knowledgePath = null;
  if (ok && pkg.knowledge && typeof pkg.knowledge === 'object' && typeof pkg.knowledge.source === 'string') {
    const resolved = resolveKnowledgeSource(pkgDir, pkg.knowledge.source, { baseDir, approvedRoots });
    knowledgePath = resolved.path || pkg.knowledge.source;
    if (resolved.error) {
      return done(pkg, null,
        [...errors, issue('knowledge.source', resolved.error, 'Keep knowledge.source relative and inside the package or data root.')],
        warnings, { sourceKey, manifestId, knowledgePath, knowledgeHash: null });
    }
    try {
      knowledge = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
    } catch (err) {
      return done(pkg, null,
        [...errors, issue('knowledge.source', `cannot read knowledge source ${resolved.path}: ${err.message}`, 'Check the knowledge file path relative to the package.')],
        warnings, { sourceKey, manifestId, knowledgePath, knowledgeHash: null });
    }
    const kErrors = [], kWarnings = [];
    validateKnowledge(knowledge, kErrors, kWarnings);
    errors.push(...kErrors.map(e => ({ ...e, path: `knowledge.source→${e.path}` })));
    warnings.push(...kWarnings);
    return done(pkg, errors.length ? null : knowledge, errors, warnings,
      { sourceKey, manifestId, knowledgePath, knowledgeHash: errors.length ? null : knowledgeHash(knowledge) });
  }
  if (pkg && typeof pkg === 'object' && pkg.knowledge && typeof pkg.knowledge === 'object') {
    knowledge = pkg.knowledge;
  }
  return done(pkg, knowledge, errors, warnings,
    { sourceKey, manifestId, knowledgePath, knowledgeHash: ok ? knowledgeHash(knowledge) : null });
}

/**
 * Package-identity-bound cache transition. Decides what the runtime may do
 * with the last validated package state when (re)loading a package.
 *
 *   action 'publish'      — new package validated; publish it fully
 *   action 'retain-stale' — SAME package source failed to refresh; keep the
 *                           last validated snapshot and report stale/degraded
 *   action 'drop'         — requested source changed and is invalid (or the
 *                           first-ever load failed): clear all tenant state
 *
 * Retention requires the requested source identity AND the resolved
 * knowledge path to be provably unchanged — the "keep serving tenant A"
 * shortcut is never allowed across a configuration switch.
 */
function transitionPackageState(active, loadResult) {
  const next = loadResult.identity || { sourceKey: 'unknown', manifestId: null, knowledgePath: null };
  if (loadResult.ok) {
    return {
      action: 'publish',
      knowledge: loadResult.knowledge || {},
      manifest: loadResult.manifest,
      errors: loadResult.errors,
      warnings: loadResult.warnings,
      active: { ...next, status: 'active', stale: false, loadedAt: new Date().toISOString(), lastError: null }
    };
  }
  const sameSource = !!active && active.status === 'active' &&
    active.sourceKey === next.sourceKey &&
    (next.knowledgePath === null || next.knowledgePath === undefined || next.knowledgePath === active.knowledgePath);
  if (sameSource) {
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
    active: { ...next, manifestId: null, status: 'invalid', stale: false, loadedAt: null, lastError: loadResult.errors.map(e => e.message).join('; ') }
  };
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
  transitionPackageState, isCapabilityAllowed, publicActionRuntimeSummary,
  resolveKnowledgeSource, KNOWN_SCOPES
};
