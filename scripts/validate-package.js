#!/usr/bin/env node
'use strict';

// Validate a Scout domain package.
// Usage: node scripts/validate-package.js <package.json|knowledge.json|'general'>

const path = require('path');
const { loadDomainPackage } = require('../lib/domain-package');
const { buildToolRegistry } = require('../lib/tool-capabilities');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/validate-package.js <package-file|"general">');
  process.exit(2);
}

const registry = buildToolRegistry();
const knownCapabilities = new Map(registry.list().map(d => [d.id, d]));
const resolved = target === 'general' ? 'general' : path.resolve(process.cwd(), target);
const result = loadDomainPackage(resolved, { baseDir: process.cwd(), knownCapabilities });

for (const w of result.warnings) {
  console.warn(`WARN  ${w.path}: ${w.message}${w.fix ? ` — fix: ${w.fix}` : ''}`);
}
for (const e of result.errors) {
  console.error(`ERROR ${e.path}: ${e.message}${e.fix ? ` — fix: ${e.fix}` : ''}`);
}

if (!result.ok) {
  console.error(`\nINVALID: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`VALID: ${result.manifest.id} (${result.manifest.name}) — ${result.errors.length} errors, ${result.warnings.length} warnings`);
