'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyResponsePolicy } = require('../lib/response-policy-classifier');
const { buildResponseContract } = require('../lib/response-contract');
const { buildRagChunks } = require('../lib/rag-chunks');

const bradleyKB = require('../data/recruiter-knowledge.json');
const evidence = buildRagChunks(bradleyKB).map(c => c.text).join('\n');

// --- Classifier regression ---

test('arithmetic variants route to CONVERSATIONAL', () => {
  const cases = [
    'What is 2 plus 2?',
    'What is 7 times 8?',
    '19 minus 6?',
    "What is 100 divided by 4?",
    "What is 15% of 200?",
    "What\'s 15% of 200?",
    'If I have 12 and add 9 what do I get?'
  ];
  for (const q of cases) {
    const p = classifyResponsePolicy(q, [], bradleyKB);
    assert.equal(p.mode, 'CONVERSATIONAL', q);
  }
});

test('"what about X" is not ROLE_FIT or PROFILE', () => {
  const p = classifyResponsePolicy('What about backend frameworks?', [], bradleyKB);
  assert.notEqual(p.mode, 'ROLE_FIT');
  assert.notEqual(p.mode, 'PROFILE');
});

test('genuine evaluative role question is ROLE_FIT', () => {
  const p = classifyResponsePolicy('Would he be a good backend developer?', [], bradleyKB);
  assert.equal(p.mode, 'ROLE_FIT');
});

test('future learning for unknown technology is FUTURE_CAPABILITY', () => {
  const cases = [
    'Can he learn COBOL?',
    'Could he pick up Terraform?',
    'How quickly could he learn Rust?'
  ];
  for (const q of cases) {
    const p = classifyResponsePolicy(q, [], bradleyKB);
    assert.equal(p.mode, 'FUTURE_CAPABILITY', q);
  }
});

test('future learning for non-professional activity is OUT_OF_SCOPE', () => {
  const p = classifyResponsePolicy('Can he learn to ride a camel?', [], bradleyKB);
  assert.equal(p.mode, 'OUT_OF_SCOPE');
});

test('specific skill with subject pronoun is SKILL_EVIDENCE', () => {
  const p = classifyResponsePolicy('Does he use Math.js?', [], bradleyKB);
  assert.equal(p.mode, 'SKILL_EVIDENCE');
});

test('specific skill proficiency is SKILL_EVIDENCE; generic "computers" is not', () => {
  const react = classifyResponsePolicy('Is he good at React?', [], bradleyKB);
  assert.equal(react.mode, 'SKILL_EVIDENCE');
  const computers = classifyResponsePolicy('Is he good at computers?', [], bradleyKB);
  assert.notEqual(computers.mode, 'SKILL_EVIDENCE');
});

test('best skill question is SKILL_EVIDENCE', () => {
  const p = classifyResponsePolicy('Is AWS his best skill?', [], bradleyKB);
  assert.equal(p.mode, 'SKILL_EVIDENCE');
});

// --- Contract regression ---

test('broad negative capability claim gets NO from skill evidence', () => {
  const c = buildResponseContract('so he DOESNT know how to use a computer?', evidence, bradleyKB);
  assert.equal(c.intent, 'SKILL');
  assert.equal(c.directAnswer, 'NO');
  assert.equal(c.factState, 'FALSE');
});

test('unknown specific skill stays UNKNOWN', () => {
  const c = buildResponseContract('Does he know Fortran?', evidence, bradleyKB);
  assert.equal(c.directAnswer, 'UNKNOWN');
  assert.equal(c.factState, 'UNKNOWN');
});

test('follow-up about backend frameworks gets QUALIFICATIONS sub-intent', () => {
  const c = buildResponseContract('What about backend frameworks?', evidence, bradleyKB);
  assert.equal(c.subIntent, 'QUALIFICATIONS');
});

test('future capability contract is open-ended', () => {
  const c = buildResponseContract('Can he learn COBOL?', evidence, bradleyKB);
  assert.equal(c.intent, 'FUTURE_CAPABILITY');
  assert.equal(c.subIntent, 'FUTURE_CAPABILITY');
  assert.equal(c.factState, 'UNKNOWN');
});
