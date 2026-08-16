'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { extractClaims } = require('../lib/claim-extractor');
const { validateRelationships } = require('../lib/relationship-validator');
const { buildRelationshipGraph } = require('../lib/relationship-graph');

// =========================================================
// Synthetic fixtures — unrelated to the real knowledge base.
// Maria Lopez is a fictional developer who built the Nebula
// Engine project using Rust and WebGPU, worked at Acme Corp,
// and attended Stanford University.
// =========================================================

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

const graph = buildRelationshipGraph(syntheticKnowledge);

// --- Claim extraction tests ---

test('DENIAL: "Nebula Engine does not exist" extracts as DENIAL claim', () => {
  const claims = extractClaims('Nebula Engine does not exist in the portfolio.', graph, '', []);
  const denial = claims.find(c => c.type === 'DENIAL');
  assert.ok(denial, 'Should extract a DENIAL claim');
  assert.equal(denial.relation, 'denial_of_existence');
});

test('DENIAL: "no evidence of Nebula Engine" extracts as DENIAL claim', () => {
  const claims = extractClaims('There is no evidence of Nebula Engine in the portfolio.', graph, '', []);
  const denial = claims.find(c => c.type === 'DENIAL');
  assert.ok(denial, 'Should extract a DENIAL claim');
  assert.equal(denial.relation, 'denial_of_existence');
});

test('DENIAL: "Rust are not publicly available" extracts as DENIAL claim', () => {
  const claims = extractClaims('Rust are not publicly available.', graph, '', []);
  const denial = claims.find(c => c.type === 'DENIAL');
  assert.ok(denial, 'Should extract a DENIAL claim');
  assert.equal(denial.relation, 'denial_of_availability');
});

test('DENIAL: "has no WebGPU" extracts as DENIAL claim', () => {
  const claims = extractClaims('Maria has no WebGPU experience listed.', graph, '', []);
  const denial = claims.find(c => c.type === 'DENIAL');
  assert.ok(denial, 'Should extract a DENIAL claim');
  assert.equal(denial.relation, 'denial_of_existence');
});

// --- Validation tests ---

test('DENIAL validation: denying existence of a known entity → unsupported', () => {
  const result = validateRelationships(
    'There is no evidence of Nebula Engine in the portfolio.',
    graph, '', []
  );
  const falseDenial = result.unsupportedClaims.find(
    uc => uc.relation === 'denial_of_existence'
  );
  assert.ok(falseDenial, 'Should flag false denial of a known entity');
  assert.ok(falseDenial.reason.includes('exists in the knowledge base'));
});

test('DENIAL validation: denying existence of an unknown entity → supported', () => {
  const result = validateRelationships(
    'There is no evidence of Quantum Reactor in the portfolio.',
    graph, '', []
  );
  const falseDenial = result.unsupportedClaims.find(
    uc => uc.relation === 'denial_of_existence'
  );
  assert.equal(falseDenial, undefined, 'Should NOT flag denial of unknown entity');
});

test('DENIAL validation: denying availability of a project WITH URL → unsupported', () => {
  const result = validateRelationships(
    'Nebula Engine are not publicly available.',
    graph, '', []
  );
  const falseDenial = result.unsupportedClaims.find(
    uc => uc.relation === 'denial_of_availability'
  );
  assert.ok(falseDenial, 'Should flag false denial of availability for project with URL evidence');
});

test('DENIAL validation: denying availability of a tech skill (no URL) → SUPPORTED', () => {
  const result = validateRelationships(
    'Rust are not publicly available.',
    graph, '', []
  );
  const falseDenial = result.unsupportedClaims.find(
    uc => uc.relation === 'denial_of_availability'
  );
  assert.equal(falseDenial, undefined, 'Should NOT flag denial of availability for entity without URL/deployment evidence');
});

test('DENIAL validation: denying availability of unknown tech → supported', () => {
  const result = validateRelationships(
    'Quantum Computing are not publicly available.',
    graph, '', []
  );
  const falseDenial = result.unsupportedClaims.find(
    uc => uc.relation === 'denial_of_availability'
  );
  assert.equal(falseDenial, undefined, 'Should NOT flag denial of unknown tech');
});

test('DENIAL validation: denying existence of a project that has a URL → still denial_of_existence (not availability)', () => {
  const result = validateRelationships(
    'Nebula Engine does not exist in the portfolio.',
    graph, '', []
  );
  const existenceDenial = result.unsupportedClaims.find(
    uc => uc.relation === 'denial_of_existence'
  );
  assert.ok(existenceDenial, 'Should flag false denial_of_existence for a known project');
  // This is denial_of_existence, NOT denial_of_availability — the entity exists.
  const availDenial = result.unsupportedClaims.find(
    uc => uc.relation === 'denial_of_availability'
  );
  assert.equal(availDenial, undefined, 'Should not produce denial_of_availability for an existence claim');
});

test('DENIAL: "No, Maria attended Stanford." does NOT produce a false DENIAL claim', () => {
  const claims = extractClaims('No, Maria attended Stanford.', graph, '', []);
  const denial = claims.find(c => c.type === 'DENIAL');
  // "No," is a discourse marker, not a denial pattern trigger
  // The denial pattern "no [Entity] in evidence" should not match "No, Maria attended"
  assert.equal(denial, undefined, 'Discourse "No," should not trigger DENIAL extraction');
});
