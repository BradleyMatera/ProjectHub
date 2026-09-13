'use strict';

// Post-PR#30 semantic reliability tests.
// Focus: contract-aligned polarity, bare known-entity follow-ups, facets.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sessionState = require(path.join(ROOT, 'lib/session-state'));
const { classifyResponsePolicy } = require(path.join(ROOT, 'lib/response-policy'));
const router = require(path.join(ROOT, 'lib/local-model-router'));
const { runRagPrimaryAgent } = require(path.join(ROOT, 'lib/rag-agent'));
const { validateAnswer, checkStance } = require(path.join(ROOT, 'lib/grounding-validator'));
const { buildResponseContract } = require(path.join(ROOT, 'lib/response-contract'));
const { executeAgentTool } = require(path.join(ROOT, 'lib/agent-tools'));
const { buildRelationshipGraph } = require(path.join(ROOT, 'lib/relationship-graph'));

const bradleyKnowledge = require(path.join(ROOT, 'data/recruiter-knowledge.json'));

function sid() { return `sr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

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

// ---------------------------------------------------------------------------
// A. Contract-aligned stance validation
// ---------------------------------------------------------------------------

test('A: positive skill contract accepts a YES stub', async () => {
  const k = freshKnowledge();
  const result = await stubRun('Does he know JavaScript?', 'Yes, the candidate has project experience with JavaScript.', k);
  assert.equal(result.proseSource, 'MODEL_GENERATION');
  const contract = result.responseContract;
  assert.ok(contract.directAnswer === 'YES' || contract.factState === 'TRUE' || contract.evidenceStrength === 'PROJECT',
    'contract should be positive for JavaScript');
});

test('B: positive skill contract rejects a NO stub', async () => {
  const k = freshKnowledge();
  const result = await stubRun('Does he know JavaScript?', 'No, he does not know JavaScript.', k);
  assert.notEqual(result.proseSource, 'MODEL_GENERATION', 'stance mismatch should reject the contradiction');
});

test('C: LeetCode gap contract rejects a YES stub', async () => {
  const k = freshKnowledge();
  const result = await stubRun('Does he know LeetCode?', 'Yes, Bradley has mixed evidence for LeetCode, as he has taken Udemy courses and discussed the math with others, but he has never had production mentorship in data structures and algorithms.', k);
  assert.notEqual(result.proseSource, 'MODEL_GENERATION',
    'a leading YES under an UNKNOWN/GAP contract must be rejected');
});

test('D: LeetCode gap contract accepts a qualified stub', async () => {
  const k = freshKnowledge();
  const result = await stubRun('Does he know LeetCode?', 'The profile documents LeetCode as a learning gap rather than verified proficiency.', k);
  assert.equal(result.proseSource, 'MODEL_GENERATION');
});

test('E: gap question can still answer YES when asked about the gap itself', async () => {
  const k = freshKnowledge();
  const result = await stubRun('Is data structures and algorithms documented as a gap?', 'Yes, data structures and algorithms is listed among the documented learning gaps.', k);
  assert.equal(result.proseSource, 'MODEL_GENERATION');
});

test('F: unknown technology rejects a closed NO under open world', async () => {
  const k = freshKnowledge();
  const result = await stubRun('Does he know ZebraLang?', 'No, he does not know ZebraLang.', k);
  assert.notEqual(result.proseSource, 'MODEL_GENERATION',
    'open-world unknown must not accept a definitive NO');
});

test('G: checkStance rejects YES under UNKNOWN contract', () => {
  const s = checkStance('Yes, he knows LeetCode.', 'Does he know LeetCode?', { directAnswer: 'UNKNOWN', factState: 'UNKNOWN' });
  assert.ok(!s.valid, 'YES under UNKNOWN contract is a stance mismatch');
  assert.ok(s.reason && /stance/.test(s.reason), `expected stance-related reason, got: ${s.reason}`);
});

test('H: checkStance accepts YES under YES contract', () => {
  const s = checkStance('Yes, the candidate has project experience with JavaScript.', 'Does he know JavaScript?', { directAnswer: 'YES', factState: 'TRUE' });
  assert.ok(s.valid, 'YES under YES contract should be accepted');
});

test('I: checkStance accepts NO under NO contract', () => {
  const s = checkStance('No, the verified profile does not document that.', 'Does he know COBOL?', { directAnswer: 'NO', factState: 'FALSE' });
  assert.ok(s.valid, 'NO under NO contract should be accepted');
});

test('J: checkStance accepts qualified answer under UNKNOWN contract', () => {
  const s = checkStance('The available evidence is insufficient to determine that.', 'Does he know ZebraLang?', { directAnswer: 'UNKNOWN', factState: 'UNKNOWN' });
  assert.ok(s.valid, 'qualified answer under UNKNOWN should pass');
});

test('K: validateAnswer rejects YES under UNKNOWN contract', () => {
  const v = validateAnswer('Yes, he knows LeetCode.', 'LeetCode style problem gap', 'Does he know LeetCode?', bradleyKnowledge, [], buildRelationshipGraph(bradleyKnowledge), null, { directAnswer: 'UNKNOWN', factState: 'UNKNOWN' });
  assert.ok(!v.valid, 'YES under UNKNOWN contract is a stance mismatch');
  const reasons = (v.reasons || []).join(' ');
  assert.ok(/stance/.test(reasons), `expected stance-related reason, got: ${reasons}`);
});

test('L: validateAnswer accepts YES under YES contract', () => {
  const v = validateAnswer('Yes, the candidate has project experience with JavaScript.', 'JavaScript used in Project Animal Sounds', 'Does he know JavaScript?', bradleyKnowledge, [], buildRelationshipGraph(bradleyKnowledge), null, { directAnswer: 'YES', factState: 'TRUE' });
  assert.ok(v.valid, 'YES under YES contract should be accepted');
});

// ---------------------------------------------------------------------------
// B. Bare known-entity follow-ups
// ---------------------------------------------------------------------------

test('M: bare skill follow-up after skills question routes to SKILL_EVIDENCE', () => {
  const k = freshKnowledge();
  const sessionId = sid();
  const ss = require(path.join(ROOT, 'lib/session-state'));
  ss.setState(sessionId, ss.freshState());
  const h = [];
  const p1 = classifyResponsePolicy('What skills does he have?', h, k, ss.getState(sessionId));
  ss.commitDiscourseTurn(sessionId, 'What skills does he have?', p1, k);
  h.push({ role: 'user', text: 'What skills does he have?' });
  const p2 = classifyResponsePolicy('JavaScript?', h, k, ss.getState(sessionId));
  assert.equal(p2.mode, 'SKILL_EVIDENCE');
  assert.equal(p2.activeEntity, 'javascript');
});

test('N: bare project follow-up routes to VERIFIED_FACT with active entity', () => {
  const k = freshKnowledge();
  const h = [{ role: 'user', text: 'Tell me about his projects.' }];
  const p = classifyResponsePolicy('ProjectHub?', h, k, null);
  assert.equal(p.activeEntity, 'projecthub');
  assert.equal(p.mode, 'VERIFIED_FACT');
});

// ---------------------------------------------------------------------------
// C. Facet follow-ups
// ---------------------------------------------------------------------------

test('O: project deployment facet preserves active entity', () => {
  const k = freshKnowledge();
  const h = [{ role: 'user', text: 'Tell me about ProjectHub.' }];
  const p = classifyResponsePolicy('What about its deployment?', h, k, null);
  assert.equal(p.activeEntity, 'projecthub');
  assert.equal(p.requestedTopic, 'deployment');
});

test('P: product price facet preserves active entity', () => {
  const k = {
    identity: { name: 'Avery Chen', role: 'Founder', company: 'Northstar Desk' },
    products: [{ name: 'Northstar Desk', type: 'B2B SaaS', description: 'Customer support ticketing platform', attributes: { price: '$99/mo' } }],
    skills: [],
    projects: []
  };
  const h = [{ role: 'user', text: 'Tell me about Northstar Desk.' }];
  const p = classifyResponsePolicy('What about its price?', h, k, null);
  assert.equal(p.activeEntity, 'northstar desk');
  assert.equal(p.requestedTopic, 'price');
});

// ---------------------------------------------------------------------------
// D. Generic assessment / request-context regressions
// ---------------------------------------------------------------------------

test('Q: extractRequestedRole handles negative presupposition (isn\'t)', () => {
  const k = freshKnowledge();
  const contract = buildResponseContract('Why isn\'t an Orbital Reliability Specialist a good fit?', 'No documented orbital reliability experience.', k);
  assert.equal(contract.subIntent, 'JOB_FIT');
  assert.equal(contract.requestedRole, 'orbital reliability specialist');
  assert.equal(contract.directAnswer, 'UNKNOWN');
  assert.equal(contract.factState, 'UNKNOWN');
});

test('R: requested role is request context, not subject evidence', () => {
  const k = freshKnowledge();
  const contract = buildResponseContract('What about an Orbital Reliability Specialist role?', 'No documented orbital reliability experience.', k);
  assert.equal(contract.requestedRole, 'orbital reliability specialist');
  const answer = 'The public profile does not show whether the subject fits the Orbital Reliability Specialist role.';
  const result = validateAnswer(answer, 'No documented orbital reliability experience.', 'What about an Orbital Reliability Specialist role?', k, [], null, null, contract, []);
  assert.equal(result.valid, true, JSON.stringify(result.reasons));
});

test('R2: role-fit accepts "partial fit" as a generic assessment', () => {
  const k = freshKnowledge();
  const q = 'Is he a fit for a junior frontend developer role?';
  const contract = buildResponseContract(q, 'JavaScript, React, TypeScript, Node, no dedicated frontend title.', k);
  const answer = 'Bradley Matera is a partial fit for the junior frontend developer role because he has JavaScript and React experience but has not worked in a dedicated frontend position.';
  const graph = buildRelationshipGraph(k);
  const result = validateAnswer(answer, 'JavaScript React TypeScript Node no dedicated frontend title.', q, k, [], graph, null, contract, []);
  assert.equal(result.valid, true, JSON.stringify(result.reasons));
});

test('S: match_role does not infer requirements for an unknown role name', () => {
  const result = executeAgentTool('match_role', { jobDescription: 'Is he a fit for an Orbital Reliability Specialist role?' }, freshKnowledge());
  assert.equal(result.role, null);
  assert.deepEqual(result.matchedSkills, []);
  assert.deepEqual(result.strong, []);
  assert.deepEqual(result.partial, []);
  assert.deepEqual(result.gaps, []);
});

test('T: non-recruiter assessment on empty knowledge stays UNKNOWN', () => {
  const emptyKnowledge = { identity: { name: 'Avery Chen' } };
  const contract = buildResponseContract('Is this candidate a good fit for our support team?', '', emptyKnowledge);
  assert.equal(contract.subIntent, 'JOB_FIT');
  assert.equal(contract.directAnswer, 'UNKNOWN');
  assert.equal(contract.factState, 'UNKNOWN');
});

// ---------------------------------------------------------------------------
// E. Role title is context, not an implicit requirement
// ---------------------------------------------------------------------------

const morganKnowledge = () => ({
  identity: { name: 'Morgan Vale', role: 'Systems Engineer' },
  summary: { whoIAm: 'Systems engineer.' },
  skills: { core: ['Telemetry Mesh', 'Signal Routing'] },
  projects: [],
  experience: [],
  certifications: []
});

test('U: role title words surface context evidence, never implicit requirements', () => {
  const result = executeAgentTool('match_role', {
    jobDescription: 'Would they fit a Telemetry Specialist role?'
  }, morganKnowledge());
  // The title overlap may surface Telemetry Mesh as relevant context evidence.
  assert.ok(result.contextMatches.includes('Telemetry Mesh'), 'Telemetry Mesh should be context evidence');
  assert.ok(result.matchedSkills.includes('Telemetry Mesh'));
  // But it must NOT become an explicit criterion or manufactured gap.
  assert.deepEqual(result.explicitCriteria, []);
  assert.deepEqual(result.gaps, []);
});

test('U2: role title words manufacture no gap when the subject lacks the skill', () => {
  const noMesh = morganKnowledge();
  noMesh.skills = { core: ['Signal Routing'] };
  const result = executeAgentTool('match_role', {
    jobDescription: 'Would they fit a Telemetry Specialist role?'
  }, noMesh);
  assert.deepEqual(result.explicitCriteria, []);
  assert.deepEqual(result.contextMatches, []);
  assert.deepEqual(result.gaps, []);
});

test('V: user-supplied criteria are explicit requirements assessed separately', () => {
  const result = executeAgentTool('match_role', {
    jobDescription: 'Would they fit a Telemetry Specialist role requiring Telemetry Mesh and Flight Pipelines?'
  }, morganKnowledge());
  assert.ok(result.explicitCriteria.some(c => /telemetry mesh/i.test(c)), 'Telemetry Mesh is a supplied criterion');
  assert.ok(result.explicitCriteria.some(c => /flight pipelines/i.test(c)), 'Flight Pipelines is a supplied criterion');
  assert.ok(result.matchedSkills.includes('Telemetry Mesh'));
  assert.deepEqual(result.gaps.map(g => g.skill), ['flight pipelines']);
});

test('W: non-technology domain role title stays context-only', () => {
  const orchard = {
    identity: { name: 'Rowan Birch' },
    skills: { core: ['Orchid Cultivation', 'Soil Chemistry'] },
    projects: [], experience: [], certifications: []
  };
  const result = executeAgentTool('match_role', {
    jobDescription: 'Would they fit an Orchid Curator role?'
  }, orchard);
  assert.ok(result.contextMatches.includes('Orchid Cultivation'));
  assert.deepEqual(result.explicitCriteria, []);
  assert.deepEqual(result.gaps, []);
});

// ---------------------------------------------------------------------------
// F. Availability/capability propositions must be grounded, not exempted
// ---------------------------------------------------------------------------

const averyKnowledge = () => ({
  identity: { name: 'Avery Chen', role: 'Support Engineer' },
  summary: { whoIAm: 'Support engineer.' },
  skills: { general: ['JavaScript'] },
  projects: [], experience: [], certifications: []
});

test('X: unsupported open/available/willing/ready/able claims are rejected', () => {
  const k = averyKnowledge();
  const graph = buildRelationshipGraph(k);
  const source = 'Support engineer. JavaScript.';
  const cases = [
    ['Is Avery open to relocation?', 'Avery Chen is open to relocation.'],
    ['Is Avery available for remote roles?', 'Avery Chen is available for remote roles.'],
    ['Is Avery willing to travel?', 'Avery Chen is willing to travel.'],
    ['Is Avery ready for production ownership?', 'Avery Chen is ready for production ownership.'],
    ['Is Avery able to administer anesthesia?', 'Avery Chen is able to administer anesthesia.']
  ];
  for (const [question, answer] of cases) {
    const v = validateAnswer(answer, source, question, k, [], graph, null, null, []);
    assert.equal(v.valid, false, `expected rejection for: ${answer}`);
    assert.ok((v.reasons || []).some(r => r.includes('has_property') || r === 'insufficient_content_overlap'),
      `expected has_property or overlap rejection for: ${answer}; got ${JSON.stringify(v.reasons)}`);
  }
});

test('X2: an unsupported capability cannot piggyback on a supported clause', () => {
  const k = averyKnowledge();
  const graph = buildRelationshipGraph(k);
  const source = 'Support engineer. JavaScript.';
  const v = validateAnswer('Avery Chen is a support engineer who is able to administer anesthesia.', source, 'Is Avery able to administer anesthesia?', k, [], graph, null, null, []);
  assert.equal(v.valid, false);
  assert.ok((v.reasons || []).some(r => r.includes('has_property')), JSON.stringify(v.reasons));
});

test('X3: documented availability property is supported', () => {
  const k = averyKnowledge();
  k.goals = { relocation: 'Open to relocation.' };
  const graph = buildRelationshipGraph(k);
  const source = 'Support engineer. JavaScript. Open to relocation.';
  const v = validateAnswer('Avery Chen is open to relocation.', source, 'Is Avery open to relocation?', k, [], graph, null, null, []);
  assert.equal(v.valid, true, JSON.stringify(v.reasons));
});

// ---------------------------------------------------------------------------
// G. Request-context provenance: supplied criteria are not tenant evidence
// ---------------------------------------------------------------------------

test('Y: user-supplied criteria never become subject relationships', () => {
  const k = morganKnowledge();
  const graph = buildRelationshipGraph(k);
  const source = 'Systems engineer. Skills: Telemetry Mesh, Signal Routing.';
  const q = 'Would Morgan fit an Orbital Reliability Specialist role requiring Telemetry Mesh and Flight Pipelines?';
  const contract = buildResponseContract(q, source, k);
  assert.equal(contract.subIntent, 'JOB_FIT');
  assert.equal(contract.requestedRole, 'orbital reliability specialist');

  // Request context may be restated — it is not a claim about Morgan.
  const restate = validateAnswer('The requested role includes Telemetry Mesh and Flight Pipelines.', source, q, k, [], graph, null, contract, []);
  assert.equal(restate.valid, true, JSON.stringify(restate.reasons));

  // Tenant-supported criterion may be affirmed.
  const supported = validateAnswer('Morgan has Telemetry Mesh experience.', source, q, k, [], graph, null, contract, []);
  assert.equal(supported.valid, true, JSON.stringify(supported.reasons));

  // Undocumented criterion must not become a has_skill/uses_tech/worked_at fact.
  const unsupported = validateAnswer('Morgan has Flight Pipelines experience.', source, q, k, [], graph, null, contract, []);
  assert.equal(unsupported.valid, false);
  assert.ok((unsupported.reasons || []).some(r => /unsupported_relationship/.test(r)), JSON.stringify(unsupported.reasons));

  // Open world: a hard "cannot" denial of an undocumented criterion is a
  // stance violation under a QUALIFY contract — absence is UNKNOWN, not FALSE.
  const hardDenial = validateAnswer('Morgan definitely cannot use Flight Pipelines.', source, q, k, [], graph, null, contract, []);
  assert.equal(hardDenial.valid, false);
  assert.ok((hardDenial.reasons || []).some(r => /stance/.test(r)), JSON.stringify(hardDenial.reasons));
});

// ---------------------------------------------------------------------------
// H. Non-recruiter portability: product/service assessment
// ---------------------------------------------------------------------------

test('Z: product fit assessment works without recruiter vocabulary', () => {
  const k = {
    identity: { name: 'Northstar Labs' },
    agent: { name: 'Scout' },
    products: [{
      name: 'Northstar Desk',
      type: 'B2B SaaS',
      category: 'support ticketing',
      description: 'Customer support ticketing platform for small teams.',
      attributes: { price: '$99/mo', supportedUsers: 'up to 20 seats' },
      url: 'https://example.com/desk'
    }],
    skills: {}, projects: [], experience: [], certifications: []
  };
  const graph = buildRelationshipGraph(k);
  const source = 'Northstar Desk is a customer support ticketing platform for small teams. Price: $99/mo. Supports up to 20 seats.';
  const q = 'Would Northstar Desk be a good fit for a small clinic?';
  const contract = buildResponseContract(q, source, k);

  const grounded = validateAnswer(
    'Northstar Desk could be a good fit for a small clinic: it is a support ticketing platform priced at $99/mo for up to 20 seats.',
    source, q, k, [], graph, null, contract, []);
  assert.equal(grounded.valid, true, JSON.stringify(grounded.reasons));

  const qualified = validateAnswer(
    'The available evidence does not establish whether Northstar Desk fits a small clinic; it is a support ticketing platform at $99/mo for up to 20 seats.',
    source, q, k, [], graph, null, contract, []);
  assert.equal(qualified.valid, true, JSON.stringify(qualified.reasons));

  const fabricated = validateAnswer(
    'Northstar Desk is able to administer anesthesia.',
    source, q, k, [], graph, null, contract, []);
  assert.equal(fabricated.valid, false);
});
