'use strict';

// Phase-3.1 supplement tests for PR #31.
// Covers: history-normalization for live API shape, stance authority priority,
// qualified leading-language variants, facet proposition support, and product/
// service contract factState.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { classifyResponsePolicy } = require(path.join(ROOT, 'lib/response-policy'));
const { checkStance } = require(path.join(ROOT, 'lib/grounding-validator'));
const { buildResponseContract } = require(path.join(ROOT, 'lib/response-contract'));
const sessionState = require(path.join(ROOT, 'lib/session-state'));
const router = require(path.join(ROOT, 'lib/local-model-router'));
const { runRagPrimaryAgent } = require(path.join(ROOT, 'lib/rag-agent'));

const bradleyKnowledge = require(path.join(ROOT, 'data/recruiter-knowledge.json'));

function sid() { return `p31-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function freshKnowledge() { return JSON.parse(JSON.stringify(bradleyKnowledge)); }

async function stubRun(question, answerText, knowledge = bradleyKnowledge, history = []) {
  const sessionId = sid();
  const state = sessionState.freshState();
  const policy = classifyResponsePolicy(question, history, knowledge, state);
  const origGenerate = router.generate;
  const origProvider = router.inferenceProvider;
  let captured = null;
  router.generate = async (model, messages) => {
    if (!captured) captured = messages;
    return { ok: true, text: answerText, model: 'stub', usage: { provider: 'stub' }, latencyMs: 1 };
  };
  router.inferenceProvider = 'stub';
  try {
    const result = await runRagPrimaryAgent({
      question,
      conversationState: state,
      evidence: [],
      knowledge,
      sessionId,
      model: 'stub',
      policyContract: policy,
      deadlineAt: Date.now() + 15000
    });
    return { ...result, policy, captured };
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
  }
}

function kBase() {
  return {
    identity: { name: 'Jane Smith', role: 'mechanic' },
    agent: { name: 'Scout' },
    products: [
      { name: 'Northstar Desk', type: 'B2B SaaS', description: 'Customer support ticketing platform', attributes: { price: '$99/mo' }, aliases: ['Northstar Desk'] }
    ],
    services: [
      { name: 'Panel Upgrade', type: 'electrical repair', description: 'Residential panel replacement', attributes: { duration: '1 day' }, aliases: ['Panel Upgrade'] }
    ],
    projects: [
      { name: 'ProjectHub (Scout)', url: 'https://bradleymatera.github.io/ProjectHub/', platform: 'GitHub Pages', description: 'Portable generative intelligence engine', tech: ['JavaScript', 'Node.js'], aliases: ['ProjectHub', 'projecthub'] }
    ],
    skills: [],
    certifications: [
      { name: 'AWS Cloud Practitioner', issuer: 'Amazon Web Services', year: '2023' }
    ],
    experience: [],
    education: [],
    sourceMaterial: []
  };
}

// ---------------------------------------------------------------------------
// History normalization: actual server shape is { user, assistant }
// ---------------------------------------------------------------------------

test('Q: bare skill follow-up uses { user, assistant } history', () => {
  const k = kBase();
  k.skills = [{ name: 'JavaScript' }];
  const history = [{ user: 'What skills does he have?', assistant: 'He has JavaScript.' }];
  const p = classifyResponsePolicy('JavaScript?', history, k, null);
  assert.equal(p.mode, 'SKILL_EVIDENCE');
  assert.equal(p.activeEntity, 'javascript');
});

test('R: bare project follow-up uses { user, assistant } history', () => {
  const k = kBase();
  const history = [{ user: 'Tell me about his projects.', assistant: 'ProjectHub is...' }];
  const p = classifyResponsePolicy('ProjectHub?', history, k, null);
  assert.equal(p.mode, 'VERIFIED_FACT');
  assert.equal(p.activeEntity, 'projecthub');
});

test('S: bare product follow-up uses { user, assistant } history', () => {
  const k = kBase();
  const history = [{ user: 'Tell me about the products.', assistant: 'Northstar Desk is...' }];
  const p = classifyResponsePolicy('Northstar Desk?', history, k, null);
  assert.equal(p.activeEntity, 'northstar desk');
});

test('T: bare service follow-up uses { user, assistant } history', () => {
  const k = kBase();
  const history = [{ user: 'What services are offered?', assistant: 'Panel Upgrade is...' }];
  const p = classifyResponsePolicy('Panel Upgrade?', history, k, null);
  assert.equal(p.activeEntity, 'panel upgrade');
});

test('U: bare certification follow-up uses { user, assistant } history', () => {
  const k = kBase();
  const history = [{ user: 'What certifications does he have?', assistant: 'AWS...' }];
  const p = classifyResponsePolicy('AWS Cloud Practitioner?', history, k, null);
  assert.ok(p.activeEntity === 'aws cloud practitioner' || p.mode === 'VERIFIED_FACT',
    'certification bare entity should route to verification');
});

// ---------------------------------------------------------------------------
// Stance authority priority
// ---------------------------------------------------------------------------

test('V: requiredStance QUALIFY beats factState TRUE', () => {
  const s = checkStance('The available evidence is insufficient.', '...', {
    requiredStance: 'QUALIFY', directAnswer: 'UNKNOWN', factState: 'TRUE'
  });
  assert.ok(s.valid, 'explicit QUALIFY stance must dominate inferred TRUE');
});

test('W: requiredStance DENY beats factState TRUE', () => {
  const s = checkStance('No, that is not supported.', '...', {
    requiredStance: 'DENY', factState: 'TRUE'
  });
  assert.ok(s.valid, 'explicit DENY stance must dominate inferred TRUE');
});

test('X: requiredStance AFFIRM beats factState UNKNOWN', () => {
  const s = checkStance('Yes, the candidate has project experience with it.', '...', {
    requiredStance: 'AFFIRM', factState: 'UNKNOWN'
  });
  assert.ok(s.valid, 'explicit AFFIRM stance must dominate inferred UNKNOWN');
});

test('Y: directAnswer UNKNOWN outranks factState TRUE when no explicit stance', () => {
  const s = checkStance('The profile does not document that.', '...', {
    directAnswer: 'UNKNOWN', factState: 'TRUE'
  });
  assert.ok(s.valid, 'directAnswer UNKNOWN should drive QUALIFY expectation');
});

// ---------------------------------------------------------------------------
// Qualified leading-language variants under UNKNOWN contract
// ---------------------------------------------------------------------------

for (const [label, phrase] of [
  ['Z1', 'No verified evidence establishes that.'],
  ['Z2', 'There is no direct evidence that he knows it.'],
  ['Z3', "There isn't enough evidence to determine that."],
  ['Z4', "The profile doesn't verify that."],
  ['Z5', 'The available record does not establish that.']
]) {
  test(`${label}: qualified phrase ${phrase.slice(0, 30)}... is not a hard denial`, () => {
    const s = checkStance(phrase, 'Does he know X?', { directAnswer: 'UNKNOWN', factState: 'UNKNOWN' });
    assert.ok(s.valid, `expected qualified/uncertain stance for: ${phrase}`);
  });
}

// ---------------------------------------------------------------------------
// Facet requested-proposition support
// ---------------------------------------------------------------------------

test('AA: ProjectHub deployment facet is SUPPORTED', () => {
  const k = kBase();
  const history = [{ user: 'Tell me about ProjectHub (Scout).', assistant: '...' }];
  const p = classifyResponsePolicy('What about its deployment?', history, k, null);
  assert.equal(p.mode, 'VERIFIED_FACT');
  assert.equal(p.activeEntity, 'projecthub');
  assert.equal(p.requestedTopic, 'deployment');
  assert.equal(p.factState, 'TRUE');
  assert.equal(p.requiredStance, 'AFFIRM');
  assert.ok(Array.isArray(p.supportingFacts) && p.supportingFacts.length > 0, 'supporting facts must be present');
});

test('AB: Northstar Desk warranty facet is UNKNOWN', () => {
  const k = kBase();
  const history = [{ user: 'Tell me about Northstar Desk.', assistant: '...' }];
  const p = classifyResponsePolicy('What about its warranty?', history, k, null);
  assert.equal(p.mode, 'VERIFIED_FACT');
  assert.equal(p.activeEntity, 'northstar desk');
  assert.equal(p.requestedTopic, 'warranty');
  assert.equal(p.factState, 'UNKNOWN');
  assert.equal(p.requiredStance, 'QUALIFY');
  assert.ok(!p.supportingFacts || p.supportingFacts.length === 0, 'no supporting facts for unsupported facet');
});

test('AC: Northstar Desk price facet is SUPPORTED', () => {
  const k = kBase();
  const history = [{ user: 'Tell me about Northstar Desk.', assistant: '...' }];
  const p = classifyResponsePolicy('What about its price?', history, k, null);
  assert.equal(p.factState, 'TRUE');
  assert.equal(p.requiredStance, 'AFFIRM');
  assert.ok(p.supportingFacts && p.supportingFacts.length > 0);
});

test('AD: Panel Upgrade duration facet is SUPPORTED', () => {
  const k = kBase();
  const history = [{ user: 'Tell me about Panel Upgrade.', assistant: '...' }];
  const p = classifyResponsePolicy('What about its duration?', history, k, null);
  assert.equal(p.factState, 'TRUE');
  assert.equal(p.requiredStance, 'AFFIRM');
});

test('AE: Panel Upgrade deployment facet is UNKNOWN', () => {
  const k = kBase();
  const history = [{ user: 'Tell me about Panel Upgrade.', assistant: '...' }];
  const p = classifyResponsePolicy('What about its deployment?', history, k, null);
  assert.equal(p.factState, 'UNKNOWN');
  assert.equal(p.requiredStance, 'QUALIFY');
});

// ---------------------------------------------------------------------------
// Product/service contract consumes policy factState, not hard TRUE
// ---------------------------------------------------------------------------

test('AF: supported product facet contract is TRUE', () => {
  const k = kBase();
  const policy = classifyResponsePolicy('What about its price?', [{ user: 'Tell me about Northstar Desk.', assistant: '...' }], k, null);
  const contract = buildResponseContract('What about its price?', '', k, [], policy);
  assert.equal(contract.factState, 'TRUE');
  assert.equal(contract.requiredStance, 'AFFIRM');
});

test('AG: unsupported product facet contract is UNKNOWN', () => {
  const k = kBase();
  const policy = classifyResponsePolicy('What about its warranty?', [{ user: 'Tell me about Northstar Desk.', assistant: '...' }], k, null);
  const contract = buildResponseContract('What about its warranty?', '', k, [], policy);
  assert.equal(contract.factState, 'UNKNOWN');
  assert.equal(contract.requiredStance, 'QUALIFY');
});

// ---------------------------------------------------------------------------
// AH/AI: LeetCode end-to-end contract and no leading YES
// ---------------------------------------------------------------------------

test('AH: LeetCode policy contract is UNKNOWN/QUALIFY', () => {
  const k = freshKnowledge();
  const p = classifyResponsePolicy('Does he know LeetCode?', [], k, null);
  assert.equal(p.directAnswer, 'UNKNOWN');
  assert.equal(p.requiredStance, 'QUALIFY');
});

test('AI: LeetCode generated response contract stays UNKNOWN/QUALIFY', async () => {
  const k = freshKnowledge();
  const result = await stubRun('Does he know LeetCode?', 'There is no verified evidence of LeetCode; it is not documented in the profile.', k);
  assert.equal(result.proseSource, 'MODEL_GENERATION');
  assert.equal(result.responseContract?.directAnswer, 'UNKNOWN', 'directAnswer should remain UNKNOWN');
  assert.equal(result.responseContract?.requiredStance, 'QUALIFY', 'requiredStance should be QUALIFY');
  assert.notEqual(result.responseContract?.factState, 'TRUE', 'factState must not be forced to TRUE for an unknown skill');
});

test('AJ: LeetCode qualified variants pass standalone stance check', () => {
  const contract = { directAnswer: 'UNKNOWN', factState: 'UNKNOWN' };
  for (const answer of [
    'No verified evidence establishes LeetCode in the profile.',
    'There is no direct evidence that he knows LeetCode.',
    "There isn't enough evidence to determine that.",
    "The profile doesn't verify LeetCode.",
    'The available record does not establish that.'
  ]) {
    const s = checkStance(answer, 'Does he know LeetCode?', contract);
    assert.ok(s.valid, `qualified answer should pass stance check: ${answer}`);
  }
});

// ---------------------------------------------------------------------------
// AK/AL: gap-proposition "Is X documented as a gap?" is distinct from "Does
// he know X?" and produces YES/TRUE/AFFIRM when the graph has has_gap.
// ---------------------------------------------------------------------------

test('AK: knowledge question "Does he know LeetCode?" remains UNKNOWN/QUALIFY', () => {
  const k = freshKnowledge();
  const p = classifyResponsePolicy('Does he know LeetCode?', [], k, null);
  assert.equal(p.directAnswer, 'UNKNOWN', 'LeetCode is not a verified skill');
  assert.equal(p.requiredStance, 'QUALIFY');
});

test('AL: gap-proposition "Is LeetCode documented as a gap?" is YES/TRUE/AFFIRM', () => {
  const k = freshKnowledge();
  const p = classifyResponsePolicy('Is LeetCode documented as a gap?', [], k, null);
  assert.equal(p.directAnswer, 'YES', 'has_gap(Bradley, LeetCode) is verified');
  assert.equal(p.factState, 'TRUE');
  assert.equal(p.answerStance, 'AFFIRM');
  assert.equal(p.requiredStance, 'AFFIRM');
  assert.equal(p.evidenceStatus, 'VERIFIED');
  assert.equal(p.requestedRelation, 'has_gap');

  const contract = buildResponseContract('Is LeetCode documented as a gap?', '', k, [], p);
  assert.equal(contract.directAnswer, 'YES');
  assert.equal(contract.factState, 'TRUE');
  assert.equal(contract.requiredStance, 'AFFIRM');
  assert.equal(contract.policyMode, 'SKILL_EVIDENCE');
  assert.equal(contract.claimCeiling, 'has a documented gap for');
});
