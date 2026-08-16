'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { validateRelationships } = require('../lib/relationship-validator');
const { validateAnswer } = require('../lib/grounding-validator');
const { buildEntityRegistry, isEntityGrounded, normalizeEntity } = require('../lib/canonical-entities');
const { COMPARATIVE_RE } = require('../lib/grounding-validator');
const { extractClaims } = require('../lib/claim-extractor');

const knowledge = require('../data/recruiter-knowledge.json');
const source = require('fs').readFileSync('./data/recruiter-knowledge.json', 'utf8');
const graph = buildRelationshipGraph(knowledge);
const registry = buildEntityRegistry(knowledge, source + '\n' + require('../lib/profile-summary').buildCompactProfileSummary());

// =========================================================
// Safety Regression Tests — 10 specific cases
// These verify that the audit fixes prevent known failure modes
// from recurring. Each test targets a specific safety concern.
// =========================================================

// 1. False denial of availability: projects ARE on GitHub Pages
test('S1: False denial_of_availability for a project with URL → unsupported', () => {
  const result = validateRelationships(
    'Interactive Pokedex is not publicly available.',
    graph, '', []
  );
  const availDenial = result.unsupportedClaims.find(
    uc => uc.relation === 'denial_of_availability'
  );
  assert.ok(availDenial, 'Should flag false denial of availability for project with URL');
});

// 2. False denial_of_existence for a known project
test('S2: False denial_of_existence for a known project → unsupported', () => {
  const result = validateRelationships(
    'There is no evidence of Interactive Pokedex in the portfolio.',
    graph, '', []
  );
  const existDenial = result.unsupportedClaims.find(
    uc => uc.relation === 'denial_of_existence'
  );
  assert.ok(existDenial, 'Should flag false denial of existence for a known project');
});

// 3. Denial of availability for tech skill (no URL) → SUPPORTED (not contradicted)
test('S3: Denial_of_availability for tech skill without URL → supported', () => {
  const result = validateRelationships(
    'Rust are not publicly available.',
    graph, '', []
  );
  const availDenial = result.unsupportedClaims.find(
    uc => uc.relation === 'denial_of_availability'
  );
  assert.equal(availDenial, undefined, 'Should NOT flag denial of availability for tech without URL evidence');
});

// 4. founder_of claim without explicit founder field → unsupported
test('S4: founder_of claim without explicit founder field → unsupported', () => {
  const result = validateRelationships(
    'Bradley Matera is the founder of ProjectHub.',
    graph, '', []
  );
  const founderUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'founder_of'
  );
  assert.ok(founderUnsupported, 'founder_of should be unsupported without explicit founder field');
});

// 5. company_behind claim without explicit company field → unsupported
test('S5: company_behind claim without explicit company field → unsupported', () => {
  const result = validateRelationships(
    'Bradley Matera is the company behind ProjectHub.',
    graph, '', []
  );
  const companyUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'company_behind'
  );
  assert.ok(companyUnsupported, 'company_behind should be unsupported without explicit company field');
});

// 6. published_on claim without explicit published_on field → unsupported
test('S6: published_on claim without explicit published_on field → unsupported', () => {
  const result = validateRelationships(
    'ProjectHub was published on GitHub Pages.',
    graph, '', []
  );
  const pubUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'published_on'
  );
  assert.ok(pubUnsupported, 'published_on should be unsupported without explicit published_on field');
});

// 7. Hallucinated law names (Social Security Act, Privacy Act) → not grounded
test('S7: Hallucinated law names are NOT grounded in entity registry', () => {
  assert.equal(isEntityGrounded('Social Security Act', registry), false,
    'Social Security Act should NOT be grounded — it is not in the knowledge base');
  assert.equal(isEntityGrounded('Privacy Act', registry), false,
    'Privacy Act should NOT be grounded — it is not in the knowledge base');
});

// 8. Comparative claim without evidence → unsupported
test('S8: Comparative claim without evidence → unsupported', () => {
  const result = validateRelationships(
    'ProjectHub is faster than Interactive Pokedex.',
    graph, '', []
  );
  const compUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'comparative_advantage'
  );
  assert.ok(compUnsupported, 'Comparative claim without evidence should be unsupported');
});

// 9. COMPARATIVE_RE detects comparative language but does not ban it
test('S9: COMPARATIVE_RE detects comparative language (detection, not ban)', () => {
  assert.ok(COMPARATIVE_RE.test('He is better than other candidates'));
  assert.ok(COMPARATIVE_RE.test('This project outperforms alternatives'));
  // But the regex itself does not reject — validation checks for evidence
  assert.ok(!COMPARATIVE_RE.test('He used React and Node.js'));
});

// 10. Graph does NOT contain inferred founder_of/company_behind/published_on triples
test('S10: Graph has NO inferred founder_of, company_behind, or published_on triples', () => {
  const founderTriples = graph.triples.filter(t => t.relation === 'founder_of');
  const companyTriples = graph.triples.filter(t => t.relation === 'company_behind');
  const publishedTriples = graph.triples.filter(t => t.relation === 'published_on');

  // These triples should only exist if explicit fields exist in the knowledge base
  // The real knowledge base does NOT have founder, company, or published_on fields
  assert.equal(founderTriples.length, 0, 'Graph should NOT have founder_of triples without explicit founder fields');
  assert.equal(companyTriples.length, 0, 'Graph should NOT have company_behind triples without explicit company fields');
  assert.equal(publishedTriples.length, 0, 'Graph should NOT have published_on triples without explicit published_on fields');
});
