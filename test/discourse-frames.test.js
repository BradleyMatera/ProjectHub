'use strict';

// Generic discourse frame / alternative-set semantics.
//
// These tests assert INTERNAL conversation state (frames, alternatives,
// provenance, ordering, corrections) plus the clarification path — not model
// prose. runRagPrimaryAgent is exercised with a stubbed router so semantic
// behavior is deterministic and provider-independent.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sessionState = require(path.join(ROOT, 'lib/session-state'));
const { buildConversationState, resolveReferent } = require(path.join(ROOT, 'lib/conversation-resolver'));
const { classifyResponsePolicy } = require(path.join(ROOT, 'lib/response-policy'));

const router = require(path.join(ROOT, 'lib/local-model-router'));
const { runRagPrimaryAgent } = require(path.join(ROOT, 'lib/rag-agent'));

const bradleyKnowledge = require(path.join(ROOT, 'data/recruiter-knowledge.json'));

// Existing-tenant portability fixture — mirrors TENANT_ALPHA (Northstar Desk)
// from tenant-portability.test.js so the primitive is proven on a tenant
// structure Scout already supports.
const northstarKnowledge = {
  identity: {
    name: 'Avery Chen',
    role: 'Founder',
    company: 'Northstar Desk',
    location: 'Seattle, WA',
    contact: { email: 'avery@northstar.desk', phone: '206-555-0142' }
  },
  agent: { name: 'Scout' },
  products: [
    { name: 'Northstar Desk', type: 'B2B SaaS', description: 'Customer support ticketing platform' }
  ],
  skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL', 'AWS'],
  projects: [
    { name: 'Desk v2', tech: ['React', 'Node.js'], description: 'Support dashboard rewrite' }
  ],
  policies: {
    privateData: ['ssn', 'password', 'credit card', 'bank account'],
    refusalTopics: ['personal financial information']
  }
};

// Minimal unrelated-tenant fixture — a bicycle shop, not a recruiter.
const bikeKnowledge = {
  identity: { name: 'Northstar Cycles', preferredName: 'Northstar' },
  agent: { name: 'Scout' },
  projects: [
    { name: 'TrailRunner', aliases: [], tech: ['aluminum', 'disc brakes'] },
    { name: 'CityBike', aliases: [], tech: ['steel', 'hub gears'] },
    { name: 'Roadster', aliases: [], tech: ['carbon', 'rim brakes'] }
  ],
  experience: [],
  skills: [],
  certifications: []
};

function sid() { return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

// Emulates the server turn flow: classify (with discourse context), rewrite,
// commit discourse state, record history.
function runTurn(state, sessionId, userText, knowledge, history) {
  const policy = classifyResponsePolicy(userText, history, knowledge, sessionState.getState(sessionId));
  const convState = buildConversationState(history, knowledge, sessionState.getState(sessionId));
  const referent = resolveReferent(userText, convState, knowledge);
  sessionState.commitDiscourseTurn(sessionId, userText, policy, knowledge);
  sessionState.updateState(sessionId, userText, '[stub reply]', knowledge, policy.mode);
  history.push({ role: 'user', text: userText });
  history.push({ role: 'assistant', text: '[stub reply]' });
  return { policy, convState, referent, state: sessionState.getState(sessionId) };
}

function frameOf(r) { return r.state.discourseFrame; }
function altNames(r) { return (frameOf(r)?.alternatives || []).filter(a => a.active !== false).map(a => a.name); }

// ---------------------------------------------------------------------------
// A. Real recruiter 4-turn sequence (Bradley KB)
// ---------------------------------------------------------------------------
test('A: recruiter role-fit sequence seeds frame on turn 1 and grows the set', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;

  const t1 = runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  assert.equal(t1.policy.mode, 'ROLE_FIT');
  const f1 = frameOf(t1);
  assert.ok(f1, 'frame must exist after turn 1');
  assert.equal(f1.intent, 'ROLE_FIT');
  assert.deepEqual(altNames(t1), ['junior frontend developer']);

  const t2 = runTurn(null, sessionId, 'What about DevOps?', k, history);
  assert.equal(t2.policy.mode, 'ROLE_FIT', 'elliptical continuation inherits frame intent');
  assert.equal(t2.policy.contextualInheritance, true);
  assert.deepEqual(altNames(t2), ['junior frontend developer', 'DevOps']);

  const t3 = runTurn(null, sessionId, 'And QA?', k, history);
  assert.equal(t3.policy.mode, 'ROLE_FIT');
  assert.deepEqual(altNames(t3), ['junior frontend developer', 'DevOps', 'QA']);

  const t4State = buildConversationState(history, k, sessionState.getState(sessionId));
  const t4 = resolveReferent('Which of those is the strongest fit?', t4State, k);
  assert.equal(t4.resolved, true, '"those" must resolve against the active set');
  for (const name of ['junior frontend developer', 'DevOps', 'QA']) {
    assert.match(t4.rewrittenQuery, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  const p4 = classifyResponsePolicy(t4.rewrittenQuery, history, k, sessionState.getState(sessionId));
  assert.notEqual(p4.mode, 'OUT_OF_SCOPE');
});

// ---------------------------------------------------------------------------
// F. Weird alternative stays type-unknown, is not silently dropped
// ---------------------------------------------------------------------------
test('F: "What about pizza?" joins the set as unknown type, never role', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  const t2 = runTurn(null, sessionId, 'What about pizza?', k, history);
  const alt = frameOf(t2).alternatives.find(a => /pizza/i.test(a.name));
  assert.ok(alt, 'user-introduced alternative must be recorded');
  assert.equal(alt.type, 'unknown', 'frame inheritance must not type pizza as a role');
  assert.equal(alt.source, 'user');
  assert.equal(alt.confidence, 'contextual');
});

// ---------------------------------------------------------------------------
// C. Generic product options — no recruiter vocabulary
// ---------------------------------------------------------------------------
test('C: generic option comparison works for non-role domains', () => {
  const sessionId = sid();
  const history = [];
  const k = bikeKnowledge;

  const t1 = runTurn(null, sessionId, 'Compare TrailRunner and CityBike.', k, history);
  assert.notEqual(t1.policy.mode, 'OUT_OF_SCOPE');
  const f = frameOf(t1);
  assert.ok(f);
  assert.deepEqual(altNames(t1).sort(), ['CityBike', 'TrailRunner']);

  const t2 = runTurn(null, sessionId, 'What about Roadster?', k, history);
  assert.notEqual(t2.policy.mode, 'OUT_OF_SCOPE');
  assert.ok(altNames(t2).includes('Roadster'));

  const conv = buildConversationState(history, k, sessionState.getState(sessionId));
  const t3 = resolveReferent('Which of those is lightest?', conv, k);
  assert.equal(t3.resolved, true);
  assert.match(t3.rewrittenQuery, /TrailRunner/i);
  assert.match(t3.rewrittenQuery, /Roadster/i);
});

// ---------------------------------------------------------------------------
// B. Project alternatives (Bradley KB)
// ---------------------------------------------------------------------------
test('B: project follow-ups resolve through the same generic set', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  const project = (k.projects || [])[0];
  const project2 = (k.projects || [])[1];
  assert.ok(project && project2, 'fixture needs two projects');

  runTurn(null, sessionId, `Tell me about ${project.name}.`, k, history);
  const t2 = runTurn(null, sessionId, `What about ${project2.name}?`, k, history);
  assert.notEqual(t2.policy.mode, 'OUT_OF_SCOPE');
  const conv = buildConversationState(history, k, sessionState.getState(sessionId));
  const r = resolveReferent('Which of those used React?', conv, k);
  assert.equal(r.resolved, true);
});

// ---------------------------------------------------------------------------
// E. Empty KB — discourse state must work with no tenant facts
// ---------------------------------------------------------------------------
test('E: empty-KB conversation still tracks the alternative set', () => {
  const sessionId = sid();
  const history = [];
  const k = { identity: { name: 'Someone' }, agent: { name: 'Scout' } };

  runTurn(null, sessionId, 'I am choosing between Alpha and Beta.', k, history);
  const t2 = runTurn(null, sessionId, 'What about Gamma?', k, history);
  const alts = altNames(t2);
  assert.ok(alts.includes('Gamma'), 'Gamma must be tracked even without a KB');
  const conv = buildConversationState(history, k, sessionState.getState(sessionId));
  const r = resolveReferent('Which of those did I mention first?', conv, k);
  assert.equal(r.resolved, true);
});

// ---------------------------------------------------------------------------
// G. Assistant contamination: assistant-invented entity is not authoritative
// ---------------------------------------------------------------------------
test('G: assistant-mentioned entity cannot enter the authoritative set', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  runTurn(null, sessionId, 'What about DevOps?', k, history);
  // Simulate an assistant hallucination mentioning a third entity.
  history.push({ role: 'assistant', text: 'He might also fit Kubernetes engineering well.' });
  const conv = buildConversationState(history, k, sessionState.getState(sessionId));
  const names = (conv.alternatives || []).map(a => a.name);
  assert.ok(!names.some(n => /kubernetes/i.test(n)), 'assistant-sourced entity must not join the user set');
});

// ---------------------------------------------------------------------------
// H. Correction: "No, I meant DevSecOps" replaces the last alternative
// ---------------------------------------------------------------------------
test('H: correction replaces the mistaken alternative', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  runTurn(null, sessionId, 'What about DevOps?', k, history);
  const t = runTurn(null, sessionId, 'No, I meant DevSecOps.', k, history);
  const names = altNames(t);
  assert.ok(names.includes('DevSecOps'), 'corrected alternative added');
  assert.ok(!names.includes('DevOps'), 'mistaken alternative removed');
});

// ---------------------------------------------------------------------------
// I. Removal: "Forget QA." deactivates it
// ---------------------------------------------------------------------------
test('I: explicit removal deactivates the named alternative', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  runTurn(null, sessionId, 'What about DevOps?', k, history);
  runTurn(null, sessionId, 'And QA?', k, history);
  const t = runTurn(null, sessionId, 'Forget QA.', k, history);
  const names = altNames(t);
  assert.ok(!names.includes('QA'));
  assert.ok(names.includes('DevOps'));
});

// ---------------------------------------------------------------------------
// J. Ordinals resolve against the ordered set
// ---------------------------------------------------------------------------
test('J: ordinal and relational references resolve generically', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  runTurn(null, sessionId, 'What about DevOps?', k, history);
  runTurn(null, sessionId, 'And QA?', k, history);
  const conv = buildConversationState(history, k, sessionState.getState(sessionId));

  const first = resolveReferent('Is the first one a good fit?', conv, k);
  assert.equal(first.resolved, true);
  assert.match(first.rewrittenQuery, /junior frontend developer/i);

  const other = resolveReferent('What about the other one?', conv, k);
  assert.equal(other.resolved, true);
});

// ---------------------------------------------------------------------------
// K. Topic escape: a full new question replaces the frame
// ---------------------------------------------------------------------------
test('K: an explicit new question escapes the inherited frame', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  const project = (k.projects || [])[0];
  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  runTurn(null, sessionId, 'What about DevOps?', k, history);
  const t = runTurn(null, sessionId, `Anyway, tell me about ${project.name}.`, k, history);
  assert.notEqual(t.policy.mode, 'ROLE_FIT');
  assert.notEqual(t.policy.contextualInheritance, true);
  assert.equal(frameOf(t).intent, t.policy.mode);
});

// ---------------------------------------------------------------------------
// L. Genuine ambiguity -> generated clarification, not TECHNICAL_ERROR
// ---------------------------------------------------------------------------
test('L: unresolved plural reference generates a clarification, never a zero-attempt failure', async () => {
  const genCalls = [];
  const origGenerate = router.generate;
  const origProvider = router.inferenceProvider;
  router.generate = async (model, messages) => {
    genCalls.push({ system: messages?.[0]?.content || '', user: messages?.[1]?.content || '' });
    return { ok: true, text: 'Which items did you mean?', model: 'stub', usage: { provider: 'stub' }, latencyMs: 1 };
  };
  router.inferenceProvider = 'stub';
  try {
    const result = await runRagPrimaryAgent({
      question: 'Which of those is better?',
      conversationState: sessionState.freshState(),
      evidence: [],
      knowledge: bradleyKnowledge,
      sessionId: sid(),
      model: 'stub',
      policyContract: { mode: 'VERIFIED_FACT' },
      deadlineAt: Date.now() + 15000,
      abortSignal: new AbortController().signal
    });
    assert.equal(result.fallback, false);
    assert.equal(result.inferenceUnavailable, undefined);
    assert.ok(result.generationAttempts >= 1, 'clarification must call the model');
    assert.equal(result.proseSource, 'MODEL_GENERATION');
    assert.ok(result.reply);
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
  }
});

// ---------------------------------------------------------------------------
// Turn-4 end-to-end: the resolved comparison reaches generation
// ---------------------------------------------------------------------------
test('A2: resolved comparison turn reaches generation (no zero-attempt path)', async () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  runTurn(null, sessionId, 'What about DevOps?', k, history);
  runTurn(null, sessionId, 'And QA?', k, history);

  const conv = buildConversationState(history, k, sessionState.getState(sessionId));
  const ref = resolveReferent('Which of those is the strongest fit?', conv, k);
  const question = ref.resolved ? ref.rewrittenQuery : 'Which of those is the strongest fit?';

  const genCalls = [];
  const origGenerate = router.generate;
  const origProvider = router.inferenceProvider;
  router.generate = async (model, messages) => {
    genCalls.push(messages?.[1]?.content || '');
    return { ok: true, text: 'Of those, the frontend role looks strongest given his documented JavaScript and React work.', model: 'stub', usage: { provider: 'stub' }, latencyMs: 1 };
  };
  router.inferenceProvider = 'stub';
  try {
    const result = await runRagPrimaryAgent({
      question,
      conversationState: sessionState.getState(sessionId),
      evidence: [],
      knowledge: k,
      sessionId,
      model: 'stub',
      policyContract: { mode: 'ROLE_FIT' },
      deadlineAt: Date.now() + 15000,
      abortSignal: new AbortController().signal
    });
    assert.ok(genCalls.length >= 1, `expected >=1 generation attempt, got ${result.generationAttempts}`);
    assert.notEqual(result.clarification, true);
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
  }
});

// ---------------------------------------------------------------------------
// M. Explicit comparison must classify COMPARISON even when names match
//    known entities (single-entity detail must not steal it).
// ---------------------------------------------------------------------------
test('M: explicit comparison beats specific-project detail', () => {
  const sessionId = sid();
  const history = [];
  const k = bikeKnowledge;

  const direct = classifyResponsePolicy('Compare TrailRunner and CityBike.', [], k, sessionState.freshState());
  assert.equal(direct.mode, 'COMPARISON', 'explicit compare must be COMPARISON, not PROJECT_DETAIL');

  const t1 = runTurn(null, sessionId, 'Compare TrailRunner and CityBike.', k, history);
  assert.equal(t1.policy.mode, 'COMPARISON');
  const f = frameOf(t1);
  assert.equal(f.intent, 'COMPARISON');
  assert.deepEqual(altNames(t1).sort(), ['CityBike', 'TrailRunner']);

  const t2 = runTurn(null, sessionId, 'What about Roadster?', k, history);
  assert.equal(t2.policy.mode, 'COMPARISON', 'continuation must stay in the comparison relation');
  assert.equal(t2.policy.contextualInheritance, true);
  assert.ok(altNames(t2).includes('Roadster'));

  const conv = buildConversationState(history, k, sessionState.getState(sessionId));
  const t3 = resolveReferent('Which of those is lightest?', conv, k);
  assert.equal(t3.resolved, true);
  const p3 = classifyResponsePolicy(t3.rewrittenQuery, history, k, sessionState.getState(sessionId));
  assert.notEqual(p3.mode, 'PROJECT_DETAIL', 'set comparison must not collapse to single-entity detail');
});

// ---------------------------------------------------------------------------
// N/O/P. Stale frame: a new entity-less substantive topic must invalidate the
// previous alternative frame (frame lifetime is semantic, not just turn count).
// ---------------------------------------------------------------------------
test('N: certifications topic closes the stale role-fit frame', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;

  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  const t2 = runTurn(null, sessionId, 'What certifications does he have?', k, history);
  const f2 = frameOf(t2);
  assert.ok(!f2 || f2.intent !== 'ROLE_FIT', 'new substantive topic must close the role-fit frame');

  const t3 = runTurn(null, sessionId, 'What about AWS?', k, history);
  assert.notEqual(t3.policy.contextualInheritance, true, 'must not inherit the stale role-fit frame');
  assert.notEqual(t3.policy.mode, 'ROLE_FIT');
});

test('O: experience topic closes the stale role-fit frame', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;

  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  const t2 = runTurn(null, sessionId, 'What experience does he have?', k, history);
  const f2 = frameOf(t2);
  assert.ok(!f2 || f2.intent !== 'ROLE_FIT');

  const t3 = runTurn(null, sessionId, 'What about AWS?', k, history);
  assert.notEqual(t3.policy.contextualInheritance, true);
  assert.notEqual(t3.policy.mode, 'ROLE_FIT');
});

test('P: contact topic closes a stale comparison frame', () => {
  const sessionId = sid();
  const history = [];
  const k = bikeKnowledge;

  runTurn(null, sessionId, 'Compare TrailRunner and CityBike.', k, history);
  runTurn(null, sessionId, 'How do I contact you?', k, history);
  const t3 = runTurn(null, sessionId, 'What about LinkedIn?', k, history);
  assert.notEqual(t3.policy.contextualInheritance, true, 'must not inherit the stale comparison frame');
  assert.ok(!altNames(t3).some(n => /linkedin/i.test(n)), 'LinkedIn must not join the bike set');
});

// ---------------------------------------------------------------------------
// Q/R/S. Facet vs alternative: possessive/demonstrative continuations are
// facets of the current referent, not new substitutable alternatives.
// ---------------------------------------------------------------------------
test('Q: possessive facet follow-up is not a new alternative', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;

  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  const t2 = runTurn(null, sessionId, 'What about his AWS experience?', k, history);
  assert.notEqual(t2.policy.contextualInheritance, true, 'facet follow-up must not inherit frame alternatives');
  assert.ok(!altNames(t2).some(n => /aws experience/i.test(n)), '"his AWS experience" is a facet, not an alternative');

  // The frame itself survives — a facet follow-up does not end the discussion.
  const t3 = runTurn(null, sessionId, 'And QA?', k, history);
  assert.ok(altNames(t3).includes('QA'), 'frame must still accept genuine alternatives');
});

test('R: subject-possessive facet is not an alternative', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;

  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  const t2 = runTurn(null, sessionId, "What about Bradley's internship?", k, history);
  assert.notEqual(t2.policy.contextualInheritance, true);
  assert.ok(!altNames(t2).some(n => /internship/i.test(n)));
});

test('S: non-Bradley facet — "its warranty" is not a new option', () => {
  const sessionId = sid();
  const history = [];
  const k = bikeKnowledge;

  runTurn(null, sessionId, 'Compare TrailRunner and CityBike.', k, history);
  const t2 = runTurn(null, sessionId, 'What about its warranty?', k, history);
  assert.notEqual(t2.policy.contextualInheritance, true);
  assert.ok(!altNames(t2).some(n => /warranty/i.test(n)), 'its warranty is a facet of an option, not an option');
});

// ---------------------------------------------------------------------------
// T/U. Clarification provider semantics: failed or empty generation must be a
// technical failure with attempts recorded — never a fake MODEL_GENERATION.
// ---------------------------------------------------------------------------
test('T: clarification provider failure is INFERENCE_UNAVAILABLE, not fake success', async () => {
  const origGenerate = router.generate;
  const origProvider = router.inferenceProvider;
  router.generate = async () => ({ ok: false, text: '', error: 'simulated provider failure', usage: { provider: 'stub' }, latencyMs: 1 });
  router.inferenceProvider = 'stub';
  try {
    const result = await runRagPrimaryAgent({
      question: 'Which of those is better?',
      conversationState: sessionState.freshState(),
      evidence: [],
      knowledge: bradleyKnowledge,
      sessionId: sid(),
      model: 'stub',
      policyContract: { mode: 'VERIFIED_FACT' },
      deadlineAt: Date.now() + 15000,
      abortSignal: new AbortController().signal
    });
    assert.equal(result.inferenceUnavailable, true);
    assert.equal(result.proseSource, 'TECHNICAL_ERROR');
    assert.equal(result.generationAttempts, 1, 'the failed provider call must be counted');
    assert.equal(result.generationCalls?.[0]?.ok, false);
    assert.ok(!result.reply);
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
  }
});

test('U: empty clarification output is not a fabricated success', async () => {
  const origGenerate = router.generate;
  const origProvider = router.inferenceProvider;
  router.generate = async () => ({ ok: true, text: '', usage: { provider: 'stub' }, latencyMs: 1 });
  router.inferenceProvider = 'stub';
  try {
    const result = await runRagPrimaryAgent({
      question: 'Which of those is better?',
      conversationState: sessionState.freshState(),
      evidence: [],
      knowledge: bradleyKnowledge,
      sessionId: sid(),
      model: 'stub',
      policyContract: { mode: 'VERIFIED_FACT' },
      deadlineAt: Date.now() + 15000,
      abortSignal: new AbortController().signal
    });
    assert.notEqual(result.proseSource, 'MODEL_GENERATION', 'empty output is not generated prose');
    assert.equal(result.generationAttempts, 1);
    assert.ok(!result.reply);
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
  }
});

// ---------------------------------------------------------------------------
// V/W. True no-tenant state: discourse tracking must not require a knowledge
// base at all ({} and null knowledge).
// ---------------------------------------------------------------------------
test('V: discourse set works with completely empty knowledge {}', () => {
  const sessionId = sid();
  const history = [];
  const k = {};

  runTurn(null, sessionId, 'I am choosing between Alpha and Beta.', k, history);
  const t2 = runTurn(null, sessionId, 'What about Gamma?', k, history);
  assert.ok(altNames(t2).includes('Gamma'));
  const conv = buildConversationState(history, k, sessionState.getState(sessionId));
  const r = resolveReferent('Which of those did I mention first?', conv, k);
  assert.equal(r.resolved, true);
});

test('W: discourse state survives null knowledge without crashing', () => {
  const sessionId = sid();
  assert.doesNotThrow(() => {
    sessionState.commitDiscourseTurn(sessionId, 'I am choosing between Alpha and Beta.', { mode: 'CONVERSATIONAL' }, null);
    sessionState.commitDiscourseTurn(sessionId, 'What about Gamma?', { mode: 'COMPARISON', contextualInheritance: true, activeEntity: 'Gamma' }, null);
  });
  const frame = sessionState.getState(sessionId).discourseFrame;
  assert.ok(frame);
  assert.ok((frame.alternatives || []).some(a => /gamma/i.test(a.name)));
  const conv = buildConversationState([], null, sessionState.getState(sessionId));
  const r = resolveReferent('Which of those is first?', conv, null);
  assert.equal(r.resolved, true);
});

// ---------------------------------------------------------------------------
// X. Portability on the existing tenant fixture shape (Northstar Desk /
// tenant-portability.test.js mirror).
// ---------------------------------------------------------------------------
test('X: existing-tenant fixture supports the generic alternative set', () => {
  const sessionId = sid();
  const history = [];
  const k = northstarKnowledge;

  const t1 = runTurn(null, sessionId, 'Compare TypeScript and PostgreSQL.', k, history);
  assert.equal(t1.policy.mode, 'COMPARISON');
  const alts1 = frameOf(t1).alternatives;
  assert.deepEqual(alts1.map(a => a.name).sort(), ['PostgreSQL', 'TypeScript']);
  assert.ok(alts1.every(a => a.type !== 'role'), 'tenant skills must not be typed as roles');

  runTurn(null, sessionId, 'What about React?', k, history);
  const conv = buildConversationState(history, k, sessionState.getState(sessionId));
  const r = resolveReferent('Which of those did Avery use most?', conv, k);
  assert.equal(r.resolved, true);
  assert.match(r.rewrittenQuery, /React/i);
});

// ---------------------------------------------------------------------------
// Y/Z. Grounded UNKNOWN assessment — the contract, not prose. An inherited or
// uncovered alternative gets open-world UNKNOWN semantics: uncertainty is a
// legal completion and invented direct experience is forbidden.
// ---------------------------------------------------------------------------
test('Y: contextual inherited alternative gets open-world UNKNOWN contract', async () => {
  const origGenerate = router.generate;
  const origProvider = router.inferenceProvider;
  router.generate = async () => ({ ok: true, text: 'The verified evidence does not directly establish experience for that option.', model: 'stub', usage: { provider: 'stub' }, latencyMs: 1 });
  router.inferenceProvider = 'stub';
  try {
    const result = await runRagPrimaryAgent({
      question: 'What about DevOps?',
      conversationState: sessionState.freshState(),
      evidence: [],
      knowledge: bradleyKnowledge,
      sessionId: sid(),
      model: 'stub',
      policyContract: { mode: 'ROLE_FIT', contextualInheritance: true, activeEntity: 'DevOps' },
      deadlineAt: Date.now() + 15000,
      abortSignal: new AbortController().signal
    });
    const contract = result.responseContract || {};
    assert.equal(contract.evidenceStatus, 'UNVERIFIED', 'discourse-introduced target must be UNKNOWN, never silently verified');
    assert.match(String(contract.boundary || ''), /insufficient|not.*verified|not established/i);
    assert.ok((contract.forbiddenClaims || []).some(c => /devops/i.test(c) && /not.*evidence|does not show/i.test(c)),
      'must forbid verified-experience claims the evidence does not contain');
    assert.ok(result.generationAttempts >= 1, 'generation is still attempted');
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
  }
});

test('Z: set question marks uncovered members as UNKNOWN, keeps generation alive', async () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  runTurn(null, sessionId, 'What about DevOps?', k, history);
  runTurn(null, sessionId, 'And Zebra?', k, history);

  const conv = buildConversationState(history, k, sessionState.getState(sessionId));
  const ref = resolveReferent('Which of those is the strongest fit?', conv, k);
  const question = ref.resolved ? ref.rewrittenQuery : 'Which of those is the strongest fit?';

  const origGenerate = router.generate;
  const origProvider = router.inferenceProvider;
  router.generate = async () => ({ ok: true, text: 'The verified evidence does not directly establish experience for those options.', model: 'stub', usage: { provider: 'stub' }, latencyMs: 1 });
  router.inferenceProvider = 'stub';
  try {
    const result = await runRagPrimaryAgent({
      question,
      conversationState: sessionState.getState(sessionId),
      evidence: [],
      knowledge: k,
      sessionId,
      model: 'stub',
      policyContract: { mode: 'VERIFIED_FACT' },
      deadlineAt: Date.now() + 15000,
      abortSignal: new AbortController().signal
    });
    const contract = result.responseContract || {};
    // Zebra has no KB coverage at all — it must be bound as unverifiable.
    assert.ok((contract.forbiddenClaims || []).some(c => /zebra/i.test(c)),
      'uncovered set member must be explicitly unverifiable');
    assert.equal(contract.evidenceStatus, 'UNVERIFIED');
    assert.ok(result.generationAttempts >= 1, 'the comparison still reaches generation');
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
  }
});
