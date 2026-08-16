'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildRelationshipGraph, checkRelationship } = require('../lib/relationship-graph');
const { validateRelationships } = require('../lib/relationship-validator');
const { normalizeEntity } = require('../lib/canonical-entities');

// Synthetic KB with explicit fields for provenance testing
const syntheticKB = {
  identity: { name: 'Maria Lopez', location: 'Austin, TX' },
  projects: [
    { name: 'Atlas', category: 'Data platform', tech: ['Python'], url: 'https://bradleymatera.github.io/Atlas/' },
    { name: 'Nebula Engine', category: 'Game engine', tech: ['C++'], founder: 'Maria Lopez', company: 'Lopez Studios', published_on: 'Steam', comparative_advantage: 'Atlas' }
  ],
  skills: { languages: ['Python', 'JavaScript'] },
  experience: [{ company: 'Acme Corp', role: 'Developer', type: 'full-time' }],
  education: { degree: 'B.S. Computer Science', school: 'State University' }
};

const graph = buildRelationshipGraph(syntheticKB);

// =========================================================
// Section 5: Graph provenance for every new relation
// =========================================================

// 1. founder_of: only from explicit projects[i].founder field
test('G1: founder_of triple exists ONLY from explicit founder field', () => {
  const founderTriples = graph.triples.filter(t => t.relation === 'founder_of');
  assert.equal(founderTriples.length, 1, 'Exactly one founder_of triple (from explicit field)');
  assert.equal(founderTriples[0].subject, 'Maria Lopez');
  assert.equal(founderTriples[0].object, 'Nebula Engine');
  // Atlas has NO founder field → no founder_of triple
  const atlasFounder = founderTriples.find(t => t.objectNorm === normalizeEntity('Atlas'));
  assert.equal(atlasFounder, undefined, 'Atlas has no founder_of triple (no explicit founder field)');
});

// 2. company_behind: only from explicit projects[i].company field
test('G2: company_behind triple exists ONLY from explicit company field', () => {
  const companyTriples = graph.triples.filter(t => t.relation === 'company_behind');
  assert.equal(companyTriples.length, 1, 'Exactly one company_behind triple (from explicit field)');
  assert.equal(companyTriples[0].subject, 'Lopez Studios');
  assert.equal(companyTriples[0].object, 'Nebula Engine');
});

// 3. published_on: only from explicit projects[i].published_on field
test('G3: published_on triple exists ONLY from explicit published_on field', () => {
  const publishedTriples = graph.triples.filter(t => t.relation === 'published_on');
  assert.equal(publishedTriples.length, 1, 'Exactly one published_on triple (from explicit field)');
  assert.equal(publishedTriples[0].subject, 'Nebula Engine');
  assert.equal(publishedTriples[0].object, 'Steam');
});

// 4. deployed_at: from URL (explicit deployment evidence)
test('G4: deployed_at triple from URL evidence', () => {
  const deployedTriples = graph.triples.filter(t => t.relation === 'deployed_at');
  // Atlas has a URL → deployed_at triple
  const atlasDeployed = deployedTriples.find(t => t.subjectNorm === normalizeEntity('Atlas'));
  assert.ok(atlasDeployed, 'Atlas has deployed_at triple from URL');
  assert.equal(atlasDeployed.object, 'GitHub Pages');
});

// 5. comparative_advantage: only from explicit projects[i].comparative_advantage field
test('G5: comparative_advantage triple from explicit field', () => {
  const compTriples = graph.triples.filter(t => t.relation === 'comparative_advantage');
  assert.equal(compTriples.length, 1, 'Exactly one comparative_advantage triple');
  assert.equal(compTriples[0].subject, 'Nebula Engine');
  assert.equal(compTriples[0].object, 'Atlas');
});

// --- Negative tests: prove no unsafe inferences ---

// 6. built_by does NOT imply founder_of
test('G6: built_by does NOT imply founder_of', () => {
  // Atlas has built_by → Maria, but NO founder field
  const atlasFounderTriples = graph.triples.filter(t =>
    t.relation === 'founder_of' && t.objectNorm === normalizeEntity('Atlas')
  );
  assert.equal(atlasFounderTriples.length, 0,
    'Atlas has built_by but NO founder_of triple — built_by does not imply founder_of');
});

// 7. project_contains does NOT imply company_behind
test('G7: No company_behind triple inferred from project existence or built_by', () => {
  // Atlas has no company field → no company_behind triple
  const atlasCompanyTriples = graph.triples.filter(t =>
    t.relation === 'company_behind' && t.objectNorm === normalizeEntity('Atlas')
  );
  assert.equal(atlasCompanyTriples.length, 0,
    'Atlas has no company_behind triple — project existence does not imply company_behind');
});

// 8. Source URL does NOT imply published_on to some other platform
test('G8: URL does NOT imply published_on to a different platform', () => {
  // Atlas has URL https://example.com/atlas but NO published_on triple
  const atlasPublished = graph.triples.filter(t =>
    t.relation === 'published_on' && t.subjectNorm === normalizeEntity('Atlas')
  );
  assert.equal(atlasPublished.length, 0,
    'Atlas has URL but NO published_on triple — URL does not imply published_on');
});

// 9. Entity co-occurrence does NOT establish relationship
test('G9: Entity co-occurrence in KB does NOT create arbitrary relationship triples', () => {
  // Maria and Atlas both exist in KB, but no arbitrary relationship is created
  // beyond what's explicitly stated (built_by, has_skill, etc.)
  const arbitraryRels = graph.triples.filter(t =>
    t.subjectNorm === normalizeEntity('Maria Lopez') &&
    t.objectNorm === normalizeEntity('Atlas') &&
    !['built_by', 'has_skill', 'has_degree', 'attended', 'worked_at', 'interned_at',
      'employed_as', 'has_cert', 'has_gap', 'uses_platform'].includes(t.relation)
  );
  // The only relationship from Maria to Atlas should be through built_by (which is
  // Atlas → built_by → Maria, not Maria → Atlas). So there should be NO direct
  // Maria → Atlas triples except through standard person relations.
  assert.ok(arbitraryRels.length === 0 || arbitraryRels.every(t =>
    t.relation === 'has_alias' || t.relation === 'has_property'
  ), 'No arbitrary relationship triples created from entity co-occurrence');
});

// 10. Validate that founder_of claim for Atlas (no explicit field) is UNSUPPORTED
test('G10: founder_of claim for Atlas (no explicit field) → UNSUPPORTED', () => {
  const result = validateRelationships(
    'Maria Lopez is the founder of Atlas.',
    graph, '', []
  );
  const founderUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'founder_of'
  );
  assert.ok(founderUnsupported, 'founder_of for Atlas (no explicit field) should be UNSUPPORTED');
});

// 11. Validate that founder_of claim for Nebula Engine (explicit field) is SUPPORTED
test('G11: founder_of claim for Nebula Engine (explicit field) → SUPPORTED', () => {
  const result = validateRelationships(
    'Maria Lopez is the founder of Nebula Engine.',
    graph, '', []
  );
  const founderUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'founder_of'
  );
  assert.equal(founderUnsupported, undefined,
    'founder_of for Nebula Engine (has explicit field) should be SUPPORTED');
});
