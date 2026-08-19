'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreCase,
  scoreArtifact,
  QUALITY,
  loadDefaultKnowledge
} = require('../lib/acceptance-scorer');

const knowledge = loadDefaultKnowledge();

function makeResult(reply, contract = null, bodyExtras = {}) {
  return {
    status: 200,
    latencyMs: 1000,
    body: {
      ok: true,
      reply,
      proseSource: 'MODEL_GENERATION',
      provider: 'cloudflare',
      ...bodyExtras
    },
    contract
  };
}

function makeArtifact(results) {
  return { results };
}

// Phrase-matching primitives
test('requireAll enforces every phrase', () => {
  const result = makeResult('I can share projects, skills, and experience.');
  const c = { id: 'meta', message: 'What can you do?', expect: { requireAll: ['projects', 'skills', 'experience'] } };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

test('requireAny accepts one of several phrases', () => {
  const result = makeResult('You can email Bradley or use LinkedIn.');
  const c = { id: 'contact', message: 'Contact?', expect: { requireAny: ['LinkedIn', 'GitHub', 'email'] } };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

test('forbidAny rejects forbidden wording', () => {
  const result = makeResult('Bradley is bad at writing tests.');
  const c = { id: 'weakness', message: 'What is he bad at?', expect: { forbidAny: ['bad at', 'weak at'] } };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.OVERCLAIM, s.reason);
});

// A. OPEN_WORLD_RELATIONSHIP
test('OPEN_WORLD_RELATIONSHIP fails on closed-world employer denial', () => {
  const result = makeResult(
    'No, Bradley\'s work experience does not include Google.',
    { intent: 'ADVERSARIAL_DENY', subIntent: 'ADVERSARIAL', factState: 'FALSE', directAnswer: 'NO', policyMode: 'VERIFIED_FACT' }
  );
  const c = { id: 'false-employer', message: 'Bradley worked at Google, right?', semanticType: 'OPEN_WORLD_RELATIONSHIP', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.notStrictEqual(s.quality, QUALITY.GOOD, s.reason);
});

test('OPEN_WORLD_RELATIONSHIP passes with uncertainty about unknown employer', () => {
  const result = makeResult(
    'I don\'t have a verified public record of Bradley working at Google.',
    { intent: 'ADVERSARIAL', subIntent: 'ADVERSARIAL', factState: 'UNKNOWN', directAnswer: 'UNKNOWN', policyMode: 'VERIFIED_FACT' }
  );
  const c = { id: 'false-employer', message: 'Bradley worked at Google, right?', semanticType: 'OPEN_WORLD_RELATIONSHIP', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

// B. UNKNOWN_SKILL
test('UNKNOWN_SKILL fails on flat denial of unknown skill', () => {
  const result = makeResult(
    'No, Bradley does not know COBOL.',
    { intent: 'SKILL', subIntent: 'SKILL_EVIDENCE', factState: 'FALSE', directAnswer: 'NO' }
  );
  const c = { id: 'unknown-skill', message: 'Does he know COBOL?', semanticType: 'UNKNOWN_SKILL', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.notEqual(s.quality, QUALITY.GOOD, s.reason);
});

test('UNKNOWN_SKILL passes with uncertainty', () => {
  const result = makeResult(
    'There is no verified project evidence of Bradley knowing COBOL.',
    { intent: 'SKILL', subIntent: 'SKILL_EVIDENCE', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' }
  );
  const c = { id: 'unknown-skill', message: 'Does he know COBOL?', semanticType: 'UNKNOWN_SKILL', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

// C. FUTURE_CAPABILITY
test('FUTURE_CAPABILITY fails when answer starts with No and misframes skill as role', () => {
  const result = makeResult(
    'No, the requested role is not COBOL.',
    { intent: 'FUTURE_CAPABILITY', subIntent: 'FUTURE_CAPABILITY', factState: 'UNKNOWN', directAnswer: 'NO' }
  );
  const c = { id: 'future-skill', message: 'Could he learn COBOL?', semanticType: 'FUTURE_CAPABILITY', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.notEqual(s.quality, QUALITY.GOOD, s.reason);
});

test('FUTURE_CAPABILITY fails on FALSE future role contract', () => {
  const result = makeResult(
    'There is no verified project evidence of Bradley working as a senior frontend engineer, but he could potentially learn and grow into this role if needed.',
    { intent: 'FUTURE_CAPABILITY', subIntent: 'FUTURE_CAPABILITY', factState: 'FALSE', directAnswer: 'NO', policyMode: 'VERIFIED_FACT', requestedRole: 'senior frontend engineer' }
  );
  const c = { id: 'future-role', message: 'Could he become a senior frontend engineer?', semanticType: 'FUTURE_CAPABILITY', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.FACT_WRONG, s.reason);
});

test('FUTURE_CAPABILITY passes with future-facing answer', () => {
  const result = makeResult(
    'He doesn\'t currently have evidence of senior frontend engineering work, but he could learn and grow into that role.',
    { intent: 'FUTURE_CAPABILITY', subIntent: 'FUTURE_CAPABILITY', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' }
  );
  const c = { id: 'future-role', message: 'Could he become a senior frontend engineer?', semanticType: 'FUTURE_CAPABILITY', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

// D. PROJECT_TECH_RELATIONSHIP
test('PROJECT_TECH_RELATIONSHIP fails when reply assigns Rust to Triangle Shader Lab', () => {
  const result = makeResult(
    'Bradley can learn Rust, and he has already demonstrated this by using the Triangle Shader Lab WebGPU learning demo, which was built using Rust.',
    { intent: 'FUTURE_CAPABILITY', subIntent: 'FUTURE_CAPABILITY', factState: 'UNKNOWN', directAnswer: 'UNKNOWN', requestedTopic: 'rust' }
  );
  const c = { id: 'unknown-tech-2', message: 'But can he learn Rust?', semanticType: 'PROJECT_TECH_RELATIONSHIP', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.notEqual(s.quality, QUALITY.GOOD, s.reason);
});

test('PROJECT_TECH_RELATIONSHIP passes when project tech is verified', () => {
  const result = makeResult(
    'Triangle Shader Lab is a WebGPU and JavaScript browser demo.',
    { intent: 'FOLLOW_UP', subIntent: 'SKILL_EVIDENCE', factState: 'TRUE' }
  );
  const c = { id: 'skill-frame', message: 'What about TypeScript?', semanticType: 'PROJECT_TECH_RELATIONSHIP', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

// E. ROLE_FIT
test('ROLE_FIT fails when reply invents historical employment', () => {
  const result = makeResult(
    'Yes, he worked as a junior frontend engineer at a previous company.',
    { intent: 'JOB_FIT', subIntent: 'JOB_FIT', factState: 'TRUE', directAnswer: 'FIT' }
  );
  const c = { id: 'role-fit', message: 'Is he a fit for a junior frontend role?', semanticType: 'ROLE_FIT', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.notEqual(s.quality, QUALITY.GOOD, s.reason);
});

// F. OUT_OF_SCOPE
test('OUT_OF_SCOPE fails if answer gives weather specifics', () => {
  const result = makeResult(
    'It is sunny and 72 degrees.',
    { intent: 'OOS', subIntent: 'OOS', policyMode: 'OUT_OF_SCOPE' }
  );
  const c = { id: 'oos', message: 'What is the weather like today?', semanticType: 'OUT_OF_SCOPE', expect: { forbidAny: ['sunny', '72 degrees'] } };
  const s = scoreCase(c, result, { knowledge });
  assert.notEqual(s.quality, QUALITY.GOOD, s.reason);
});

test('OUT_OF_SCOPE passes with a scope redirect', () => {
  const result = makeResult(
    'I can only answer questions about Bradley\'s projects, skills, and background. I don\'t have weather data.',
    { intent: 'OOS', subIntent: 'OOS', policyMode: 'OUT_OF_SCOPE' }
  );
  const c = { id: 'oos', message: 'What is the weather like today?', semanticType: 'OUT_OF_SCOPE', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

// Telemetry checks
test('telemetry checks flag wrong contract.factState', () => {
  const result = makeResult('Some reply.', { factState: 'FALSE', directAnswer: 'NO' });
  const c = { id: 'x', message: 'x', expect: { telemetry: { factState: 'UNKNOWN' } } };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.FACT_WRONG, s.reason);
});

// Offline artifact rescore
test('scoreArtifact rescores a raw artifact with case map', () => {
  const artifact = makeArtifact([
    { id: 'false-employer', message: 'Bradley worked at Google, right?', reply: 'No, Bradley\'s work experience does not include Google.', contract: { factState: 'FALSE', directAnswer: 'NO' } }
  ]);
  const cases = [{ id: 'false-employer', message: 'Bradley worked at Google, right?', semanticType: 'OPEN_WORLD_RELATIONSHIP', expect: {} }];
  const out = scoreArtifact(artifact, cases, { knowledge });
  assert.equal(out.total, 1);
  assert.equal(out.good, 0);
  assert.ok(out.failedIds.includes('false-employer'));
});
