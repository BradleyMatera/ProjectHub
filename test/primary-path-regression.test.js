'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateClaims } = require('../lib/claim-validator');
const { buildResponseContract } = require('../lib/response-contract');

const testKnowledge = {
  identity: { name: 'Bradley Matera', preferredName: 'Bradley' },
  agent: { name: 'Scout', persona: 'Scout is a helpful recruiter assistant' },
  summary: { whoIAm: 'Bradley is an entry-level developer with internship and project experience' },
  projects: [
    { name: 'ProjectHub', tech: ['JavaScript', 'Node.js', 'Chart.js', 'AWS', 'Bootstrap'] },
    { name: 'CIRIS', tech: ['React', 'Tailwind CSS'], aliases: ['CIRIS Dashboard'] }
  ],
  skills: {
    languages: ['JavaScript', 'Python'],
    frameworks: ['React', 'Node.js'],
    tools: ['AWS', 'Chart.js']
  },
  experience: [{ company: 'Wilmoth Group', role: 'Web Development Intern' }],
  certifications: [{ name: 'AWS Certified Cloud Practitioner' }]
};

function makeContract(intent, subIntent, evidenceStrength, requestedTopic, requestedRole) {
  return {
    intent,
    subIntent,
    policyMode: subIntent,
    evidenceStrength,
    requestedTopic,
    requestedRole,
    directAnswer: 'UNKNOWN',
    naturalInstructions: ''
  };
}

test('META: generic "I am an Assistant" is rejected', () => {
  const contract = makeContract('META', 'META_IDENTITY', null, null, null);
  const issues = validateClaims('I am an AI assistant and I can help with many tasks.', 'what is your name?', contract, '', testKnowledge);
  assert.ok(issues.some(i => i.type === 'ASSISTANT_IDENTITY_CLAIM'));
});

test('META: Scout identity is accepted', () => {
  const contract = makeContract('META', 'META_IDENTITY', null, null, null);
  const issues = validateClaims('I am Scout, a recruiter assistant powered by the Scout engine. I answer questions about Bradley Matera.', 'what is your name?', contract, '', testKnowledge);
  assert.equal(issues.filter(i => i.type === 'ASSISTANT_IDENTITY_CLAIM').length, 0);
});

test('META: self-learning claim is rejected', () => {
  const contract = makeContract('META', 'META_IDENTITY', null, null, null);
  const issues = validateClaims('I am Scout and I learn and improve from our conversations.', 'what can you do?', contract, '', testKnowledge);
  assert.ok(issues.some(i => i.type === 'ASSISTANT_IDENTITY_CLAIM' && /self-learning|improve/i.test(i.detail)));
});

test('NEGATIVE_ASSESSMENT: unsupported negative trait is rejected', () => {
  const contract = makeContract('OPINION', 'NEGATIVE_ASSESSMENT', null, null, null);
  const issues = validateClaims('He is bad at communication and slow to ship.', 'what is he bad at?', contract, 'Bradley built ProjectHub using JavaScript and Node.js.', testKnowledge);
  assert.ok(issues.some(i => i.type === 'NEGATIVE_PERSONAL_CLAIM'));
});

test('ROLE_FIT: fabricated historical title is rejected', () => {
  const contract = makeContract('JOB_FIT', 'SKILL_EVIDENCE', 'PROJECT', null, 'frontend developer');
  const issues = validateClaims('He has experience as a Full Stack Engineer Frontend at the company.', 'would he fit a frontend role?', contract, 'Bradley built ProjectHub with JavaScript and Node.js.', testKnowledge);
  assert.ok(issues.some(i => i.type === 'ROLE_TITLE_CLAIM'));
});

test('SKILL_EVIDENCE: proficiency overclaim from project evidence is rejected', () => {
  const contract = makeContract('SKILL', 'SKILL_EVIDENCE', 'PROJECT', 'Python', null);
  const issues = validateClaims('He is proficient in Python and has extensive experience with it.', 'is he good at Python?', contract, 'Python appears in the ProjectHub and CIRIS code.', testKnowledge);
  assert.ok(issues.some(i => i.type === 'PROFICIENCY_CLAIM'));
});

test('SKILL_EVIDENCE: unknown skill cannot claim experience', () => {
  const contract = makeContract('SKILL', 'SKILL_EVIDENCE', 'UNKNOWN', 'Rust', null);
  const issues = validateClaims('He has experience with Rust and has built production systems in it.', 'what about Rust?', contract, '', testKnowledge);
  assert.ok(issues.some(i => i.type === 'SKILL_CLAIM'));
});

test('OUT_OF_SCOPE: candidate factual claim is rejected', () => {
  const contract = makeContract('OOS', 'OUT_OF_SCOPE', null, null, null);
  const issues = validateClaims('Bradley worked at Netflix on a recommendation algorithm.', 'who won the super bowl?', contract, '', testKnowledge);
  assert.ok(issues.some(i => i.type === 'OUT_OF_SCOPE_CLAIM' || i.type === 'EMPLOYMENT_CLAIM'));
});

test('Response contract includes factState, claimCeiling, requestedRole', () => {
  const evidence = '[ProjectHub] Built with JavaScript, Node.js, Chart.js, AWS.\n[CIRIS] Uses React and Tailwind CSS.';
  const contract = buildResponseContract('would he fit a frontend role?', evidence, testKnowledge);
  assert.ok(contract.factState);
  assert.ok(contract.claimCeiling);
  assert.equal(contract.requestedRole, 'frontend');
});
