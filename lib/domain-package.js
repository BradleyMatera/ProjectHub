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
 *   runtime          optional runtime option overrides (e.g. deadlineMs)
 *
 * Backward compatibility: a bare knowledge JSON file (no packageVersion)
 * loads as a legacy package with an implicit manifest.
 *
 * 'general' resolves to the built-in General Scout package: no domain
 * knowledge, compute capability only. Scout Core + no domain package is
 * a first-class runtime configuration, not a test accident.
 */

const fs = require('fs');
const path = require('path');
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
  'knownProjects'
];
// Sections whose items are entities that must not collide on name.
const ENTITY_SECTIONS = ['projects', 'codePens', 'products', 'services', 'publications'];
// Top-level knowledge keys allowed to be scalars.
const SCALAR_KEYS = new Set(['version', 'lastUpdated', 'summary']);
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
            warnings.push(issue(`capabilities.allow`, `unknown capability "${id}"`, 'Register this capability or remove it from allow.'));
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

  // ── presentation / runtime / policies ──
  for (const key of ['presentation', 'runtime', 'policies', 'identity']) {
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
  for (const [key, value] of Object.entries(knowledge)) {
    if (SCALAR_KEYS.has(key) || COLLECTION_SECTIONS.includes(key)) continue;
    if (value !== null && typeof value !== 'object') {
      errors.push(issue(`knowledge.${key}`, `knowledge.${key} must be an object or array`, `Make ${key} a structured section or remove it.`));
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

/**
 * Load and validate a domain package.
 * @param {string|object|null} source — 'general', a file path, a parsed package
 *   object, or a bare knowledge object (legacy).
 * @param {object} [opts] — { baseDir, knownCapabilities }
 * @returns {{ ok:boolean, manifest:object, knowledge:object, errors:array, warnings:array }}
 */
function loadDomainPackage(source, { baseDir = process.cwd(), knownCapabilities } = {}) {
  if (source === 'general' || source === null || source === undefined) {
    return { ok: true, manifest: GENERAL_PACKAGE, knowledge: {}, errors: [], warnings: [] };
  }
  let pkg = source;
  let pkgDir = baseDir;
  if (typeof source === 'string') {
    const filePath = path.resolve(baseDir, source);
    try {
      pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      return { ok: false, manifest: null, knowledge: null,
        errors: [issue('$', `cannot read package file ${filePath}: ${err.message}`, 'Check the path and JSON syntax.')], warnings: [] };
    }
    pkgDir = path.dirname(filePath);
  }

  // Legacy path: a bare knowledge document (identity/skills/etc., no manifest).
  if (pkg && typeof pkg === 'object' && pkg.packageVersion === undefined &&
      (pkg.identity || pkg.skills || pkg.projects || pkg.experience || pkg.summary)) {
    const errors = [], warnings = [];
    validateKnowledge(pkg, errors, warnings);
    return {
      ok: errors.length === 0,
      manifest: { packageVersion: PACKAGE_SCHEMA_VERSION, id: 'legacy-knowledge', name: 'Unmanaged knowledge file', legacy: true },
      knowledge: pkg, errors, warnings
    };
  }

  const { ok, errors, warnings } = validateDomainPackage(pkg, { knownCapabilities });
  let knowledge = {};
  if (ok && pkg.knowledge && typeof pkg.knowledge === 'object' && typeof pkg.knowledge.source === 'string') {
    const knowledgePath = path.resolve(pkgDir, pkg.knowledge.source);
    try {
      knowledge = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'));
    } catch (err) {
      errors.push(issue('knowledge.source', `cannot read knowledge source ${knowledgePath}: ${err.message}`, 'Check the knowledge file path relative to the package.'));
      return { ok: false, manifest: pkg, knowledge: null, errors, warnings };
    }
    const kErrors = [], kWarnings = [];
    validateKnowledge(knowledge, kErrors, kWarnings);
    errors.push(...kErrors.map(e => ({ ...e, path: `knowledge.source→${e.path}` })));
    warnings.push(...kWarnings);
    if (kErrors.length) return { ok: false, manifest: pkg, knowledge: null, errors, warnings };
  } else if (pkg.knowledge && typeof pkg.knowledge === 'object') {
    knowledge = pkg.knowledge;
  }
  return { ok: ok && errors.length === 0, manifest: pkg, knowledge, errors, warnings };
}

/** Capability gate for a loaded manifest: deny wins over allow; an allow
 *  list present means only listed capabilities are permitted. */
function isCapabilityAllowed(manifest, capabilityId) {
  const caps = manifest && manifest.capabilities;
  if (!caps) return true; // no declaration → registry default (all available)
  if ((caps.deny || []).includes(capabilityId)) return false;
  if (Array.isArray(caps.allow) && caps.allow.length) return caps.allow.includes(capabilityId);
  return true;
}

module.exports = {
  PACKAGE_SCHEMA_VERSION, GENERAL_PACKAGE,
  validateDomainPackage, loadDomainPackage, isCapabilityAllowed,
  KNOWN_SCOPES
};
