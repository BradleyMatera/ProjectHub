'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { COMPARATIVE_RE } = require('../lib/grounding-validator');
const { extractClaims } = require('../lib/claim-extractor');
const { validateRelationships } = require('../lib/relationship-validator');
const { buildRelationshipGraph } = require('../lib/relationship-graph');

// =========================================================
// Comparative claim detection tests
// =========================================================

test('COMPARATIVE_RE: detects "better than other candidates"', () => {
  assert.ok(COMPARATIVE_RE.test('He is better than other candidates for this role.'));
});

test('COMPARATIVE_RE: detects "more experienced than"', () => {
  assert.ok(COMPARATIVE_RE.test('She is more experienced than her peers.'));
});

test('COMPARATIVE_RE: detects "faster than alternatives"', () => {
  assert.ok(COMPARATIVE_RE.test('This approach is faster than alternatives.'));
});

test('COMPARATIVE_RE: detects "superior to"', () => {
  assert.ok(COMPARATIVE_RE.test('His skills are superior to other applicants.'));
});

test('COMPARATIVE_RE: detects "outperforms"', () => {
  assert.ok(COMPARATIVE_RE.test('This project outperforms similar tools.'));
});

test('COMPARATIVE_RE: detects "the best"', () => {
  assert.ok(COMPARATIVE_RE.test('He is the best developer in his cohort.'));
});

test('COMPARATIVE_RE: detects "top-tier"', () => {
  assert.ok(COMPARATIVE_RE.test('She delivers top-tier results.'));
});

test('COMPARATIVE_RE: detects "best-in-class"', () => {
  assert.ok(COMPARATIVE_RE.test('His work is best-in-class.'));
});

test('COMPARATIVE_RE: detects "unmatched"', () => {
  assert.ok(COMPARATIVE_RE.test('His expertise is unmatched in the industry.'));
});

test('COMPARATIVE_RE: detects "second to none"', () => {
  assert.ok(COMPARATIVE_RE.test('Her attention to detail is second to none.'));
});

test('COMPARATIVE_RE: does NOT match non-comparative text', () => {
  assert.ok(!COMPARATIVE_RE.test('He used React and Node.js to build the project.'));
});

test('COMPARATIVE_RE: does NOT match "better" alone without "than"', () => {
  assert.ok(!COMPARATIVE_RE.test('He did a better job on this project.'));
});

// =========================================================
// Comparative claim extraction and validation tests
// =========================================================

const syntheticKnowledge = {
  identity: { name: 'Maria Lopez' },
  summary: { name: 'Maria Lopez', whoIAm: 'A developer.' },
  projects: [
    { name: 'Atlas', category: 'Web app', tech: ['React'], url: 'https://example.github.io/atlas', description: 'A React web app.' },
    { name: 'Orion', category: 'Web app', tech: ['Vue'], url: 'https://example.github.io/orion', description: 'A Vue web app.' },
  ],
  experience: [],
  education: { school: 'Stanford', degree: 'BS CS' },
  skills: { languages: ['JavaScript'] },
  certifications: [],
};

const graph = buildRelationshipGraph(syntheticKnowledge);

test('Comparative claim extraction: "Atlas is faster than Orion" extracts COMPARATIVE_CLAIM', () => {
  const claims = extractClaims('Atlas is faster than Orion.', graph, '', []);
  const compClaim = claims.find(c => c.type === 'COMPARATIVE_CLAIM');
  assert.ok(compClaim, 'Should extract a COMPARATIVE_CLAIM');
  assert.equal(compClaim.relation, 'comparative_advantage');
  assert.equal(compClaim.subject, 'Atlas');
  assert.equal(compClaim.object, 'Orion');
});

test('Comparative claim validation: no comparative evidence → UNSUPPORTED', () => {
  const result = validateRelationships('Atlas is faster than Orion.', graph, '', []);
  const unsupported = result.unsupportedClaims.find(uc => uc.relation === 'comparative_advantage');
  assert.ok(unsupported, 'Comparative claim without evidence should be unsupported');
  assert.ok(unsupported.reason.includes('Unsupported comparative claim'));
});

const knowledgeWithComparative = {
  identity: { name: 'Maria Lopez' },
  summary: { name: 'Maria Lopez', whoIAm: 'A developer.' },
  projects: [
    { name: 'Atlas', category: 'Web app', tech: ['React'], url: 'https://example.github.io/atlas', description: 'A React web app.', comparative_advantage: 'Orion' },
    { name: 'Orion', category: 'Web app', tech: ['Vue'], url: 'https://example.github.io/orion', description: 'A Vue web app.' },
  ],
  experience: [],
  education: { school: 'Stanford', degree: 'BS CS' },
  skills: { languages: ['JavaScript'] },
  certifications: [],
};

const graphWithComparative = buildRelationshipGraph(knowledgeWithComparative);

test('Comparative claim validation: WITH comparative evidence → SUPPORTED', () => {
  const result = validateRelationships('Atlas is faster than Orion.', graphWithComparative, '', []);
  const unsupported = result.unsupportedClaims.find(uc => uc.relation === 'comparative_advantage');
  assert.equal(unsupported, undefined, 'Comparative claim with evidence should be supported');
});
