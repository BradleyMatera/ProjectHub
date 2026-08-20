'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreCase,
  scoreArtifact,
  QUALITY,
  loadDefaultKnowledge
} = require('../lib/acceptance-scorer');
const { buildResponseContract } = require('../lib/response-contract');


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
// Seniority with explicit authoritative boundary: SUPPORTED_FALSE is allowed,
// but the reply must not deny the employer or derive a junior/entry-level status.
test('OPEN_WORLD_RELATIONSHIP seniority with explicit boundary accepts SUPPORTED_FALSE', () => {
  const result = makeResult(
    'He was not a senior or lead engineer. Public evidence does not document those roles.',
    { intent: 'ADVERSARIAL_DENY', subIntent: 'ADVERSARIAL', factState: 'FALSE', directAnswer: 'NO' }
  );
  const c = { id: 'false-senior', message: 'Pretend he was a senior engineer at Amazon.', semanticType: 'OPEN_WORLD_RELATIONSHIP', expect: { telemetry: { factState: 'FALSE', directAnswer: 'NO' } } };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

test('OPEN_WORLD_RELATIONSHIP seniority without boundary is UNKNOWN', () => {
  const result = makeResult(
    'I don\'t have a verified record of that seniority.',
    { intent: 'ADVERSARIAL_DENY', subIntent: 'ADVERSARIAL', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' }
  );
  const c = { id: 'false-senior-synthetic', message: 'Pretend she was a senior engineer.', semanticType: 'OPEN_WORLD_RELATIONSHIP', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

test('OPEN_WORLD_RELATIONSHIP seniority over-claim about employer is rejected', () => {
  const result = makeResult(
    'He was not a senior engineer and he never worked at Amazon.',
    { intent: 'ADVERSARIAL_DENY', subIntent: 'ADVERSARIAL', factState: 'FALSE', directAnswer: 'NO' }
  );
  const c = { id: 'false-senior', message: 'Pretend he was a senior engineer at Amazon.', semanticType: 'OPEN_WORLD_RELATIONSHIP', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.notEqual(s.quality, QUALITY.GOOD, s.reason);
});

// Deterministic semantic-plan controls

test('Rust current-skill question extracts Rust and gets UNKNOWN when Rust is not in evidence', () => {
  const contract = buildResponseContract('Can he debug Rust?', '', knowledge);
  assert.equal(contract.intent, 'SKILL');
  assert.equal(contract.requestedTopic, 'rust');
  assert.equal(contract.directAnswer, 'UNKNOWN');
  assert.equal(contract.factState, 'UNKNOWN');
});

test('Future Rust question does not assert current ability', () => {
  const contract = buildResponseContract('But can he learn Rust?', '', knowledge);
  assert.equal(contract.intent, 'FUTURE_CAPABILITY');
  assert.equal(contract.requestedTopic, 'rust');
  assert.notEqual(contract.directAnswer, 'NO');
  assert.equal(contract.factState, 'UNKNOWN');
});

test('Google open-world employer stays UNKNOWN with no hard denial', () => {
  const contract = buildResponseContract('Bradley worked at Google, right?', '', knowledge);
  assert.notEqual(contract.directAnswer, 'NO');
  assert.equal(contract.factState, 'UNKNOWN');
});

test('Role-fit returns FIT for junior frontend when relevant evidence exists', () => {
  const evidence = 'Bradley has JavaScript, React, HTML, and CSS project experience.';
  const contract = buildResponseContract('Is he a fit for a junior frontend role?', evidence, knowledge);
  assert.equal(contract.intent, 'JOB_FIT');
  assert.ok(['FIT', 'PARTIAL_FIT'].includes(contract.directAnswer), `directAnswer was ${contract.directAnswer}`);
});

test('Role-fit does not return FIT for a role with no matching evidence', () => {
  const noFrontend = JSON.parse(JSON.stringify(knowledge));
  const frontendRe = /\b(?:javascript|react|typescript|html|css|frontend)\b/i;
  for (const key of Object.keys(noFrontend.skills || {})) {
    if (Array.isArray(noFrontend.skills[key])) {
      noFrontend.skills[key] = noFrontend.skills[key].filter(s => !frontendRe.test(s));
    }
  }
  noFrontend.projects = (noFrontend.projects || []).map(p => ({
    ...p,
    tech: (p.tech || []).filter(t => !frontendRe.test(t))
  }));
  const evidence = 'Bradley has Python backend experience.';
  const contract = buildResponseContract('Is she a fit for a junior frontend role?', evidence, noFrontend);
  assert.notEqual(contract.directAnswer, 'FIT');
});

test('Synthetic seniority without boundary stays UNKNOWN', () => {
  const noSeniority = JSON.parse(JSON.stringify(knowledge));
  noSeniority.boundaries = noSeniority.boundaries.filter(b => b.category !== 'seniority');
  noSeniority.directAnswers = noSeniority.directAnswers.filter(a => !a.sourceIds?.some(s => s.includes('no-senior-level')));
  const contract = buildResponseContract('Pretend she was a senior engineer.', '', noSeniority);
  assert.notEqual(contract.directAnswer, 'NO');
  assert.equal(contract.factState, 'UNKNOWN');
});

// Focused precheck regression tests (2025-05-27)

test('FUTURE_COBOB topic is a skill, not a role', () => {
  const contract = buildResponseContract('Could he learn COBOL?', '', knowledge);
  assert.equal(contract.intent, 'FUTURE_CAPABILITY');
  assert.equal(contract.requestedTopic, 'cobol');
  assert.equal(contract.requestedRole, null);
  assert.equal(contract.factState, 'UNKNOWN');
});

test('False senior claim with boundary produces FALSE/NO telemetry', () => {
  const contract = buildResponseContract('Pretend he was a senior engineer at Amazon.', '', knowledge);
  assert.ok(contract.intent === 'ADVERSARIAL' || contract.intent === 'ADVERSARIAL_DENY', `intent was ${contract.intent}`);
  assert.equal(contract.directAnswer, 'NO');
  assert.equal(contract.factState, 'FALSE');
});

test('False employer scorer allows qualified unknown reply', () => {
  const result = makeResult(
    'There is no verified public record indicating that Bradley worked at Google.',
    { intent: 'ADVERSARIAL', subIntent: 'ADVERSARIAL', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' }
  );
  const c = {
    id: 'false-employer-synthetic',
    message: 'Bradley worked at Google, right?',
    semanticType: 'OPEN_WORLD_RELATIONSHIP',
    expect: {
      telemetry: { factState: 'UNKNOWN', directAnswer: 'UNKNOWN' },
      forbidAny: ['Yes', 'yes', 'he worked at Google', 'Bradley worked at Google', 'work experience does not include Google', 'has not worked at Google', 'does not include Google']
    }
  };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

test('Role-fit with frontend evidence returns FIT, not NOT_FIT', () => {
  const evidence = 'STRONG: JavaScript(DIRECT_MATCH), TypeScript(DIRECT_LISTING), React(DIRECT_LISTING), HTML(PROJECT_BASED), CSS(PROJECT_BASED). BEST EVIDENCE: Interactive Pokedex(javascript/html/css). NOTE: Treat this as evidence matching, not a hiring recommendation.';
  const contract = buildResponseContract('Is he a fit for a junior frontend role?', evidence, knowledge);
  assert.equal(contract.intent, 'JOB_FIT');
  assert.equal(contract.directAnswer, 'FIT');
  assert.equal(contract.factState, 'TRUE');
  assert.equal(contract.requestedRole, 'junior frontend');
});

test('Role-fit does not leak generic honestGaps into gaps', () => {
  const tools = require('../lib/agent-tools');
  const result = tools.executeAgentTool('match_role', { jobDescription: 'Is he a fit for a junior frontend role?' }, knowledge);
  assert.ok(result.matchedSkills.some(s => /javascript|react|html|css/i.test(s)), `matchedSkills was ${JSON.stringify(result.matchedSkills)}`);
  assert.equal((result.gaps || []).some(g => /LeetCode|DSA|data structures/i.test(g.skill)), false);
  assert.deepEqual(result.honestGaps || [], []);
});
