'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { extractClaims } = require('../lib/claim-extractor');
const { validateRelationships } = require('../lib/relationship-validator');
const { buildRelationshipGraph } = require('../lib/relationship-graph');

// =========================================================
// Synthetic fixtures — Maria Lopez, Nebula Engine, Acme Corp
// =========================================================

// Knowledge WITHOUT explicit founder/company/published_on fields
const syntheticKnowledge = {
  identity: { name: 'Maria Lopez' },
  summary: {
    name: 'Maria Lopez',
    whoIAm: 'An entry-level developer who builds rendering engines.',
  },
  projects: [
    {
      name: 'Nebula Engine',
      category: 'Rendering engine',
      tech: ['Rust', 'WebGPU'],
      url: 'https://example.github.io/nebula',
      description: 'A real-time rendering engine built with Rust and WebGPU.',
      aliases: ['Nebula'],
    },
  ],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Software Engineering Intern',
      type: 'internship',
      skills: ['Rust', 'C++'],
    },
  ],
  education: {
    school: 'Stanford University',
    degree: 'BS Computer Science',
  },
  skills: {
    languages: ['Rust', 'C++', 'JavaScript'],
    frameworks: ['WebGPU'],
  },
  certifications: [],
};

// Knowledge WITH explicit founder field (for positive founder_of test)
const knowledgeWithFounder = {
  identity: { name: 'Maria Lopez' },
  summary: {
    name: 'Maria Lopez',
    whoIAm: 'An entry-level developer who builds rendering engines.',
  },
  projects: [
    {
      name: 'Nebula Engine',
      category: 'Rendering engine',
      tech: ['Rust', 'WebGPU'],
      url: 'https://example.github.io/nebula',
      description: 'A real-time rendering engine built with Rust and WebGPU.',
      aliases: ['Nebula'],
      founder: 'Maria Lopez',
    },
  ],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Software Engineering Intern',
      type: 'internship',
      skills: ['Rust', 'C++'],
    },
  ],
  education: {
    school: 'Stanford University',
    degree: 'BS Computer Science',
  },
  skills: {
    languages: ['Rust', 'C++', 'JavaScript'],
    frameworks: ['WebGPU'],
  },
  certifications: [],
};

const graph = buildRelationshipGraph(syntheticKnowledge);
const graphWithFounder = buildRelationshipGraph(knowledgeWithFounder);

// --- Claim extraction tests ---

test('founder_of: "Maria is the founder of Nebula Engine" extracts founder_of claim', () => {
  const claims = extractClaims('Maria is the founder of Nebula Engine.', graph, '', []);
  const founderClaim = claims.find(c => c.relation === 'founder_of');
  assert.ok(founderClaim, 'Should extract founder_of claim');
  assert.equal(founderClaim.type, 'FACT');
});

test('founder_of: "Maria founded Nebula Engine" extracts founder_of claim', () => {
  const claims = extractClaims('Maria founded Nebula Engine.', graph, '', []);
  const founderClaim = claims.find(c => c.relation === 'founder_of');
  assert.ok(founderClaim, 'Should extract founder_of claim');
});

test('company_behind: "Maria, the company behind Nebula Engine" extracts company_behind claim', () => {
  const claims = extractClaims('Maria Lopez, the company behind Nebula Engine.', graph, '', []);
  const companyClaim = claims.find(c => c.relation === 'company_behind');
  assert.ok(companyClaim, 'Should extract company_behind claim');
});

test('published_on: "Nebula Engine was published on GitHub" extracts published_on claim', () => {
  const claims = extractClaims('Nebula Engine was published on GitHub Pages.', graph, '', []);
  const pubClaim = claims.find(c => c.relation === 'published_on');
  assert.ok(pubClaim, 'Should extract published_on claim');
});

test('deployed_on: "Nebula Engine is deployed on GitHub Pages" extracts deployed_on claim', () => {
  const claims = extractClaims('Nebula Engine is deployed on GitHub Pages.', graph, '', []);
  const depClaim = claims.find(c => c.relation === 'deployed_on');
  assert.ok(depClaim, 'Should extract deployed_on claim');
});

// --- Validation tests ---

test('founder_of validation: Maria founder_of Nebula Engine → UNSUPPORTED without explicit founder field', () => {
  const result = validateRelationships(
    'Maria Lopez is the founder of Nebula Engine.',
    graph, '', []
  );
  const founderUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'founder_of'
  );
  assert.ok(founderUnsupported, 'founder_of should be UNSUPPORTED without explicit founder field');
});

test('founder_of validation: Maria founder_of Nebula Engine → SUPPORTED with explicit founder field', () => {
  const result = validateRelationships(
    'Maria Lopez is the founder of Nebula Engine.',
    graphWithFounder, '', []
  );
  const founderUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'founder_of'
  );
  assert.equal(founderUnsupported, undefined, 'founder_of should be supported when founder field exists');
});

test('founder_of validation: Random person founder_of Nebula Engine → unsupported', () => {
  const result = validateRelationships(
    'John Smith is the founder of Nebula Engine.',
    graphWithFounder, '', []
  );
  const founderUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'founder_of'
  );
  assert.ok(founderUnsupported, 'founder_of by unknown person should be unsupported');
});

test('company_behind validation: Maria company_behind Nebula Engine → UNSUPPORTED (built_by != company_behind)', () => {
  const result = validateRelationships(
    'Maria Lopez, the company behind Nebula Engine.',
    graph, '', []
  );
  const companyUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'company_behind'
  );
  assert.ok(companyUnsupported, 'company_behind should be UNSUPPORTED — built_by is not company_behind');
});

test('company_behind validation: Unknown corp company_behind Nebula Engine → unsupported', () => {
  const result = validateRelationships(
    'Zenith Corp, the company behind Nebula Engine.',
    graph, '', []
  );
  const companyUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'company_behind'
  );
  assert.ok(companyUnsupported, 'company_behind by unknown corp should be unsupported');
});

test('published_on validation: Nebula Engine published_on GitHub Pages → UNSUPPORTED (deployed_at != published_on)', () => {
  const result = validateRelationships(
    'Nebula Engine was published on GitHub Pages.',
    graph, '', []
  );
  const pubUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'published_on'
  );
  assert.ok(pubUnsupported, 'published_on should be UNSUPPORTED — deployed_at is not published_on');
});

test('published_on validation: Nebula Engine published_on AWS → unsupported', () => {
  const result = validateRelationships(
    'Nebula Engine was published on AWS.',
    graph, '', []
  );
  const pubUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'published_on'
  );
  assert.ok(pubUnsupported, 'published_on on unknown platform should be unsupported');
});

test('deployed_on validation: Nebula Engine deployed_on GitHub Pages → supported', () => {
  const result = validateRelationships(
    'Nebula Engine is deployed on GitHub Pages.',
    graph, '', []
  );
  const depUnsupported = result.unsupportedClaims.find(
    uc => uc.relation === 'deployed_on'
  );
  assert.equal(depUnsupported, undefined, 'deployed_on should be supported');
});

test('founder_of: graph does NOT contain founder_of triple when no explicit founder field', () => {
  const founderTriples = graph.triples.filter(t => t.relation === 'founder_of');
  assert.equal(founderTriples.length, 0, 'Graph should NOT have founder_of triples without explicit founder field');
});

test('founder_of: graph contains founder_of triple when explicit founder field exists', () => {
  const founderTriples = graphWithFounder.triples.filter(t => t.relation === 'founder_of');
  assert.ok(founderTriples.length > 0, 'Graph should have founder_of triples when founder field exists');
});
