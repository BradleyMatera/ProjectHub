#!/usr/bin/env node
'use strict';

// Operator inspection surface for a Scout domain package.
// Prints manifest identity, knowledge section inventory, entity list,
// capability permissions, and validation status.
// Usage: node scripts/inspect-package.js [package-file|'general']

const path = require('path');
const { loadDomainPackage, isCapabilityAllowed } = require('../lib/domain-package');
const { buildToolRegistry } = require('../lib/tool-capabilities');
const { normalizeKnowledgeEntities } = require('../lib/knowledge-entities');

const target = process.argv[2] || 'general';
const registry = buildToolRegistry();
const knownCapabilities = new Map(registry.list().map(d => [d.id, d]));
const resolved = target === 'general' ? 'general' : path.resolve(process.cwd(), target);
// Operator CLI: the file path is chosen by the operator, so package-source
// confinement is bypassed explicitly (trustedOperator) rather than silently.
const result = loadDomainPackage(resolved, { baseDir: process.cwd(), knownCapabilities, trustedOperator: true });

if (!result.ok) {
  console.error('Package failed validation:');
  for (const e of result.errors) console.error(`  ERROR ${e.path}: ${e.message}`);
  process.exit(1);
}
for (const w of result.warnings) console.warn(`WARN  ${w.path}: ${w.message}`);

const { manifest, knowledge } = result;
console.log('=== Scout domain package ===');
console.log(`id:          ${manifest.id}`);
console.log(`name:        ${manifest.name}`);
console.log(`version:     package contract v${manifest.packageVersion}${manifest.legacy ? ' (legacy bare-knowledge file)' : ''}`);
console.log(`description: ${manifest.description || '(none)'}`);
console.log(`mode:        ${manifest.id === 'general-scout' ? 'GENERAL (no domain knowledge)' : 'domain application'}`);

const sections = Object.keys(knowledge || {});
console.log(`\n=== Knowledge (${sections.length} sections) ===`);
for (const key of sections) {
  const v = knowledge[key];
  const size = Array.isArray(v) ? `${v.length} item(s)` : typeof v === 'object' && v ? `${Object.keys(v).length} field(s)` : typeof v;
  console.log(`  ${key}: ${size}`);
}
if (!sections.length) console.log('  (empty — valid General Scout configuration)');

const entities = normalizeKnowledgeEntities(knowledge);
console.log(`\n=== Entities (${entities.length}) ===`);
for (const e of entities) {
  const alias = e.aliases.length ? ` (aliases: ${e.aliases.join(', ')})` : '';
  console.log(`  [${e.type}] ${e.name}${alias} — ${e.sourcePath}`);
}

console.log('\n=== Capabilities ===');
for (const d of registry.list()) {
  const allowed = isCapabilityAllowed(manifest, d.id);
  const flags = [d.readOnly ? 'read-only' : 'side-effect', d.requiresConfirmation ? 'confirmation' : null].filter(Boolean).join(', ');
  console.log(`  ${allowed ? 'ALLOW' : 'DENY '}  ${d.id} (${flags}; scope: ${d.permissionScope})`);
}
