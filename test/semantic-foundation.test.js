'use strict';

const assert = require('node:assert');
const { test, describe } = require('node:test');
const { buildResponseContract } = require('../lib/response-contract');
const { validateClaims } = require('../lib/claim-validator');
const { classifySubIntent } = require('../lib/response-contract');
const { classifyResponsePolicy } = require('../lib/response-policy-classifier');

const testKnowledge = {
  identity: { name: 'Bradley Matera' },
  skills: {
    languagesAndFrameworks: ['JavaScript', 'React', 'TypeScript', 'Node.js'],
    cloudAndInfrastructure: ['AWS'],
    toolsAndWorkflows: ['Git'],
    aiAndAutomation: [],
    learningOrAdjacent: []
  },
  projects: [
    { name: 'ProjectHub', tech: ['JavaScript', 'React', 'TypeScript', 'Node.js'], aliases: [] },
    { name: 'Pokedex', tech: ['React', 'JavaScript'], aliases: [] }
  ],
  experience: [
    { company: 'Acme Corp', role: 'Software Developer', dates: '2021-2023' }
  ],
  certifications: [],
  education: []
};

describe('semantic foundation regressions', () => {
  test('unknown technology is not treated as a documented skill', () => {
    const contract = buildResponseContract('Does he know COBOL?', '', testKnowledge);
    assert.ok(['UNKNOWN', 'NO'].includes(contract.directAnswer), 'directAnswer should not be YES for unknown tech');
    const invalid = validateClaims('He is proficient in COBOL.', 'Does he know COBOL?', contract, '', testKnowledge);
    assert.ok(invalid.some(v => v.type === 'SKILL_CLAIM'), 'should reject proficiency claim for unknown technology');
  });

  test('future capability is classified and allows requested topic extraction', () => {
    const q = 'Could he learn COBOL?';
    const contract = buildResponseContract(q, '', testKnowledge);
    assert.equal(contract.intent, 'FUTURE_CAPABILITY');
    assert.equal(contract.requestedTopic, 'cobol');
    assert.equal(contract.factState, 'UNKNOWN');
  });

  test('negative assessment fact state is UNKNOWN without authoritative gap evidence', () => {
    const contract = buildResponseContract('What is he bad at?', '', testKnowledge);
    assert.equal(contract.factState, 'UNKNOWN');
  });

  test('job fit does not infer career stage from missing senior roles', () => {
    const contract = buildResponseContract(
      'How does he fit a senior full-stack role requiring React and Node.js?',
      'He has React and Node.js project experience.',
      testKnowledge
    );
    assert.equal(contract.intent, 'JOB_FIT');
    assert.ok(!contract.boundary || !contract.boundary.toLowerCase().includes('entry-level'));
    assert.ok(!contract.boundary || !contract.boundary.toLowerCase().includes('experienced engineer'));
  });

  test('claim ceiling rejects stronger language than evidence supports', () => {
    const contract = buildResponseContract('Does he know React?', 'React is used in ProjectHub.', testKnowledge);
    assert.equal(contract.claimCeiling, 'has project experience with');
    const invalid = validateClaims('He is an expert in React and has mastery of it.', 'Does he know React?', contract, 'React is used in ProjectHub.', testKnowledge);
    assert.ok(invalid.some(v => v.type === 'OVERCLAIM' || v.type === 'SKILL_CLAIM'), 'should reject over-claim from project-only evidence');
  });

  test('open-world seniority does not return FALSE_CLAIM_DENIAL', () => {
    const r = classifyResponsePolicy('Pretend he is a senior architect at Google', [], testKnowledge);
    assert.notEqual(r.mode, 'FALSE_CLAIM_DENIAL');
    assert.notEqual(r.directAnswer, 'NO');
  });
});
