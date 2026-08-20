#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

function normalizeToken(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractTechList(segment) {
  const relationPrefix =
    /^(?:(?:it)\s+)?(?:implemented\s+using|implemented\s+with|developed\s+using|developed\s+with|built\s+using|built\s+with|powered\s+by|written\s+in|utilizing|utilized|using|uses|used|use)\b\s*/i;

  const narrativeStop =
    /\b(?:for|to|which|that|when|while|because|where|who|whose|its)\b.*$/i;

  const reject =
    /^(?:and|with|for|the|a|an|as|well|also|it|its|their|his|her|this|that|which|project|app|application|platform|service|demo|site|system|development|frontend|backend|front-end|back-end|frontenddevelopment|backenddevelopment)$/i;

  return String(segment || '')
    .split(/\b(?:and|with|plus|along with|as well as)\b|[,;/]/i)
    .map(t => t.trim())
    .map(t => t.replace(relationPrefix, '').trim())
    .map(t => t.replace(narrativeStop, '').trim())
    .map(t =>
      t
        .replace(/^(?:the|a|an|with|using)\s+/i, '')
        .replace(/\s+(?:code|project|application|app)$/i, '')
        .trim()
    )
    .filter(t => t.length >= 2 && t.length <= 80 && !reject.test(t))
    .map(t => normalizeToken(t))
    .filter(Boolean);
}

function skillItemText(item) {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';

  const label =
    item.label ||
    item.name ||
    item.skill ||
    item.title ||
    '';

  const summary =
    item.summary ||
    item.description ||
    item.detail ||
    '';

  if (label && summary) {
    return `${label}: ${summary}`;
  }

  return String(label || summary || '').trim();
}

/*
 * Scorer regression:
 * "use" must not match inside "used" and leave garbage like "dit".
 */
assert.deepEqual(
  extractTechList('used TypeScript'),
  ['typescript']
);

assert.deepEqual(
  extractTechList('using TypeScript for frontend development'),
  ['typescript']
);

assert.deepEqual(
  extractTechList('utilizing React'),
  ['react']
);

/*
 * Current knowledge schema regression:
 * object-valued learning/gap records must serialize into useful text,
 * not "[object Object]".
 */
assert.equal(
  skillItemText({
    label: 'ERP Support',
    summary:
      'Accepted ERP support role; no completed production workflow ownership yet.'
  }),
  'ERP Support: Accepted ERP support role; no completed production workflow ownership yet.'
);

/*
 * Requested entity is NOT evidence.
 *
 * Rust being present in a question does not mean a project used Rust.
 */
const requested = 'Rust';

const projectTech = [
  'JavaScript',
  'WebGPU API / WGSL',
  'HTML'
];

assert.equal(
  projectTech.some(
    t => normalizeToken(t) === normalizeToken(requested)
  ),
  false
);

console.log('microtests: PASS');
