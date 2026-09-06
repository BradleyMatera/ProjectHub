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

  const t2 = runTurn(null, sessionId, 'What about React?', k, history);
  // React is has_skill in this tenant — discourse introduction is neutral;
  // the tenant relationship keeps it verified.
  assert.equal(t2.policy.contextualInheritance, true);
  assert.equal(t2.policy.evidenceStatus, 'VERIFIED');
  const conv = buildConversationState(history, k, sessionState.getState(sessionId));
  const r = resolveReferent('Which of those did Avery use most?', conv, k);
  assert.equal(r.resolved, true);
  assert.match(r.rewrittenQuery, /React/i);
});

// ---------------------------------------------------------------------------
// Y. Two-axis model: discourse membership is independent of knowledge status.
//    User introduction neither creates nor erases verified knowledge — the
//    tenant relationship graph decides the evidence state.
// ---------------------------------------------------------------------------
function seedRoleFitFrame(sessionId, history, k = bradleyKnowledge) {
  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
}

test('Y1: contextual target with no KB relationship is UNKNOWN (discourse-neutral)', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  seedRoleFitFrame(sessionId, history, k);
  const t = runTurn(null, sessionId, 'What about DevOps?', k, history);
  assert.equal(t.policy.contextualInheritance, true);
  assert.equal(t.policy.activeEntity, 'DevOps');
  assert.equal(t.policy.evidenceStatus, 'UNKNOWN',
    'no supported relationship -> UNKNOWN regardless of discourse introduction');
});

test('Y2: contextual target with a verified relationship stays VERIFIED', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  seedRoleFitFrame(sessionId, history, k);
  const t = runTurn(null, sessionId, 'What about JavaScript?', k, history);
  assert.equal(t.policy.contextualInheritance, true, 'still a discourse continuation');
  assert.equal(t.policy.evidenceStatus, 'VERIFIED',
    'has_skill in the tenant graph means user introduction did not make it unverified');
  assert.ok(!(t.policy.forbiddenClaims || []).some(c => /javascript/i.test(c)),
    'a verified target must not carry an unverifiable forbidden claim');
});

test('Y3: gap-only relationship is not positive verified experience', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  seedRoleFitFrame(sessionId, history, k);
  const t = runTurn(null, sessionId, 'What about LeetCode?', k, history);
  assert.equal(t.policy.contextualInheritance, true);
  assert.equal(t.policy.evidenceStatus, 'GAP',
    'has_gap is evidence of a documented gap, not verified expertise');
});

test('Y4: rag contract keeps the assessed state, does not blanket-UNVERIFIED', async () => {
  const origGenerate = router.generate;
  const origProvider = router.inferenceProvider;
  router.generate = async () => ({ ok: true, text: 'He has verified JavaScript project experience.', model: 'stub', usage: { provider: 'stub' }, latencyMs: 1 });
  router.inferenceProvider = 'stub';
  try {
    const result = await runRagPrimaryAgent({
      question: 'What about JavaScript?',
      conversationState: sessionState.freshState(),
      evidence: [],
      knowledge: bradleyKnowledge,
      sessionId: sid(),
      model: 'stub',
      policyContract: { mode: 'ROLE_FIT', contextualInheritance: true, activeEntity: 'JavaScript' },
      deadlineAt: Date.now() + 15000,
      abortSignal: new AbortController().signal
    });
    const contract = result.responseContract || {};
    assert.equal(contract.evidenceStatus, 'VERIFIED',
      'a graph-verified contextual target must not be downgraded to unverified');
    assert.ok(!(contract.forbiddenClaims || []).some(c => /javascript/i.test(c)));
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
  }
});

test('Y5: uncovered contextual target still gets the UNKNOWN contract + narrowing', async () => {
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
    assert.equal(contract.evidenceStatus, 'UNKNOWN');
    assert.match(String(contract.boundary || ''), /insufficient|unverified|not established/i);
    assert.ok((contract.forbiddenClaims || []).some(c => /devops/i.test(c)));
    assert.ok(result.generationAttempts >= 1);
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
  }
});

// ---------------------------------------------------------------------------
// G/D. Resolved plural ranking: relation from the frame + generic COMPARE
//      operation + per-member evidence states — never generic VERIFIED_FACT.
// ---------------------------------------------------------------------------
test('G: resolved set ranking yields frame relation + COMPARE operation + per-member states', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;

  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  runTurn(null, sessionId, 'What about DevOps?', k, history);
  runTurn(null, sessionId, 'And QA?', k, history);

  // Classify the RAW user text the way production does — no injected policy.
  const raw = classifyResponsePolicy('Which of those is the strongest fit?', history, k, sessionState.getState(sessionId));
  assert.equal(raw.mode, 'ROLE_FIT', 'relation comes from the frame, not a fresh fallback');
  assert.equal(raw.setOperation, 'COMPARE', 'plural selection over the set is a comparison operation');
  assert.deepEqual(raw.alternatives, ['junior frontend developer', 'DevOps', 'QA']);

  const conv = buildConversationState(history, k, sessionState.getState(sessionId));
  const ref = resolveReferent('Which of those is the strongest fit?', conv, k);
  const resolved = classifyResponsePolicy(ref.rewrittenQuery, history, k, sessionState.getState(sessionId));
  assert.equal(resolved.mode, 'ROLE_FIT');
  assert.equal(resolved.setOperation, 'COMPARE');
  assert.notEqual(resolved.mode, 'VERIFIED_FACT');
  assert.notEqual(resolved.mode, 'PROJECT_DETAIL');
});

test('D: mixed set keeps per-member evidence states (verified/unknown/gap)', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;

  runTurn(null, sessionId, 'Compare JavaScript and Zebra.', k, history);
  runTurn(null, sessionId, 'What about LeetCode?', k, history);
  const p = classifyResponsePolicy('Which of those is best?', history, k, sessionState.getState(sessionId));
  assert.equal(p.setOperation, 'COMPARE');
  const byName = new Map((p.memberEvidence || []).map(m => [m.name, m.evidenceStatus]));
  assert.equal(byName.get('JavaScript'), 'VERIFIED');
  assert.equal(byName.get('Zebra'), 'UNKNOWN');
  assert.equal(byName.get('LeetCode'), 'GAP', 'gap relation is kept distinct — not flattened to unknown or promoted to verified');
});

// ---------------------------------------------------------------------------
// E/F. Aspirational mention is not claim: text that mentions a target without
//      a supporting relationship leaves it UNKNOWN — for single targets and
//      for set members alike.
// ---------------------------------------------------------------------------
test('E: aspirational-text mention without a relationship stays UNKNOWN', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge; // devops-engineer.mdx mentions DevOps, claims nothing
  seedRoleFitFrame(sessionId, history, k);
  const t = runTurn(null, sessionId, 'What about DevOps?', k, history);
  assert.equal(t.policy.evidenceStatus, 'UNKNOWN', 'mention in practice text is not a claimed relationship');
});

test('F: set member with only aspirational mentions stays UNKNOWN', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, 'Compare JavaScript and React.', k, history);
  runTurn(null, sessionId, 'What about DevOps?', k, history);
  const p = classifyResponsePolicy('Which of those is best?', history, k, sessionState.getState(sessionId));
  const byName = new Map((p.memberEvidence || []).map(m => [m.name, m.evidenceStatus]));
  assert.equal(byName.get('DevOps'), 'UNKNOWN');
  assert.equal(byName.get('JavaScript'), 'VERIFIED');
  assert.equal(byName.get('React'), 'VERIFIED');
});

// ---------------------------------------------------------------------------
// H/I. PROFILE_SUMMARY: normal path is generative; DIRECT_KB stays an
//      explicit opt-in, not the default authoring path.
// ---------------------------------------------------------------------------
test('H: PROFILE_SUMMARY produces model generation, not deterministic prose', async () => {
  const origGenerate = router.generate;
  const origProvider = router.inferenceProvider;
  const origEnv = process.env.SCOUT_DIRECT_KB_ENABLED;
  delete process.env.SCOUT_DIRECT_KB_ENABLED;
  router.generate = async () => ({ ok: true, text: 'Bradley Matera is an early-career software engineer based in Davis, Illinois.', model: 'stub', usage: { provider: 'stub' }, latencyMs: 1 });
  router.inferenceProvider = 'stub';
  try {
    const result = await runRagPrimaryAgent({
      question: 'Tell me about Bradley.',
      conversationState: sessionState.freshState(),
      evidence: [],
      knowledge: bradleyKnowledge,
      sessionId: sid(),
      model: 'stub',
      policyContract: { mode: 'VERIFIED_FACT' },
      deadlineAt: Date.now() + 15000,
      abortSignal: new AbortController().signal
    });
    assert.equal(result.responseContract?.subIntent, 'PROFILE_SUMMARY', 'test must exercise the profile-summary path');
    assert.ok(result.generationAttempts >= 1, 'the model must write the sentence');
    assert.equal(result.proseSource, 'MODEL_GENERATION');
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
    if (origEnv === undefined) delete process.env.SCOUT_DIRECT_KB_ENABLED;
    else process.env.SCOUT_DIRECT_KB_ENABLED = origEnv;
  }
});

test('I: DIRECT_KB explicit opt-in still returns the direct answer', async () => {
  const origGenerate = router.generate;
  const origProvider = router.inferenceProvider;
  const origEnv = process.env.SCOUT_DIRECT_KB_ENABLED;
  process.env.SCOUT_DIRECT_KB_ENABLED = 'true';
  router.generate = async () => { throw new Error('must not be called under explicit DIRECT_KB opt-in'); };
  router.inferenceProvider = 'stub';
  try {
    const result = await runRagPrimaryAgent({
      question: 'Tell me about Bradley.',
      conversationState: sessionState.freshState(),
      evidence: [],
      knowledge: bradleyKnowledge,
      sessionId: sid(),
      model: 'stub',
      policyContract: { mode: 'VERIFIED_FACT' },
      deadlineAt: Date.now() + 15000,
      abortSignal: new AbortController().signal
    });
    assert.equal(result.proseSource, 'DIRECT_KB', 'explicit opt-in keeps the canonical direct-answer path');
    assert.ok(result.reply && result.reply.length > 10);
    assert.equal(result.generationAttempts, 0);
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
    if (origEnv === undefined) delete process.env.SCOUT_DIRECT_KB_ENABLED;
    else process.env.SCOUT_DIRECT_KB_ENABLED = origEnv;
  }
});

// ---------------------------------------------------------------------------
// AA. Dimension-aware comparison support: entity knowledge and requested-
//     proposition support are different axes. Known entities + an unsupported
//     requested dimension must NOT become a verified comparison.
// ---------------------------------------------------------------------------
const { assessEntityEvidence } = require(path.join(ROOT, 'lib/relationship-graph'));

const pricedBikeKnowledge = {
  ...bikeKnowledge,
  projects: bikeKnowledge.projects.map((p, i) => ({
    ...p,
    attributes: { price: ['£900', '£650', '£1400'][i] }
  }))
};

test('AA1: known entities + unsupported dimension -> dimension UNKNOWN, generation allowed', () => {
  const sessionId = sid();
  const history = [];
  const k = bikeKnowledge; // TrailRunner/CityBike exist, no weight data anywhere
  runTurn(null, sessionId, 'Compare TrailRunner and CityBike.', k, history);
  const p = classifyResponsePolicy('Which of those is lightest?', history, k, sessionState.getState(sessionId));
  assert.equal(p.setOperation, 'COMPARE');
  assert.ok((p.memberEvidence || []).every(m => m.evidenceStatus === 'VERIFIED'),
    'both products are known entities with claiming edges');
  assert.equal(p.dimensionSupport, 'UNKNOWN',
    'no weight/lightness relationship exists — the requested proposition is unverifiable');
  assert.notEqual(p.mode, 'VERIFIED_FACT');
});

test('AA2: supported dimension via generic has_property attributes', () => {
  const sessionId = sid();
  const history = [];
  const k = pricedBikeKnowledge;
  runTurn(null, sessionId, 'Compare TrailRunner and CityBike.', k, history);
  const p = classifyResponsePolicy('Which of those is cheaper?', history, k, sessionState.getState(sessionId));
  assert.equal(p.setOperation, 'COMPARE');
  assert.equal(p.dimension, 'price');
  assert.equal(p.dimensionSupport, 'SUPPORTED', 'has_property price edges support a price comparison');
});

test('AA3: role-fit ranking is an assessment, not a stored fact', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, "I'm hiring for a junior frontend developer. Is he a fit?", k, history);
  runTurn(null, sessionId, 'What about DevOps?', k, history);
  runTurn(null, sessionId, 'And QA?', k, history);
  const p = classifyResponsePolicy('Which of those is the strongest fit?', history, k, sessionState.getState(sessionId));
  assert.equal(p.setOperation, 'COMPARE');
  assert.equal(p.dimensionKind, 'assessment', 'role-fit ranking is synthesized from member evidence, not stored');
  assert.equal(p.dimensionSupport, 'SUPPORTED', 'assessment may proceed from member profiles');
});

test('AA4: no-KB set is understood, dimension unknown, no recruiter requirements', () => {
  const sessionId = sid();
  const history = [];
  const k = {};
  runTurn(null, sessionId, 'I am choosing between Alpha and Beta.', k, history);
  const p = classifyResponsePolicy('Which is better?', history, k, sessionState.getState(sessionId));
  assert.equal(p.setOperation, 'COMPARE');
  assert.ok(!(p.evidenceRequirements || []).some(r => /subject\.|project\d\./.test(r)),
    'empty tenant must not get recruiter evidence requirements');
});

test('AA5: unsupported dimension still reaches generation, never fabricated', async () => {
  const sessionId = sid();
  const history = [];
  const k = bikeKnowledge;
  runTurn(null, sessionId, 'Compare TrailRunner and CityBike.', k, history);
  const policy = classifyResponsePolicy('Which of those is lightest?', history, k, sessionState.getState(sessionId));
  const origGenerate = router.generate;
  const origProvider = router.inferenceProvider;
  router.generate = async () => ({ ok: true, text: 'I do not have verified weight data to compare them.', model: 'stub', usage: { provider: 'stub' }, latencyMs: 1 });
  router.inferenceProvider = 'stub';
  try {
    const result = await runRagPrimaryAgent({
      question: 'Which of those is lightest?',
      conversationState: sessionState.getState(sessionId),
      evidence: [],
      knowledge: k,
      sessionId,
      model: 'stub',
      policyContract: policy,
      deadlineAt: Date.now() + 15000,
      abortSignal: new AbortController().signal
    });
    const contract = result.responseContract || {};
    assert.equal(contract.dimensionSupport, 'UNKNOWN');
    assert.ok(result.generationAttempts >= 1, 'generation still happens for honest uncertainty');
    assert.equal(result.proseSource, 'MODEL_GENERATION');
  } finally {
    router.generate = origGenerate;
    router.inferenceProvider = origProvider;
  }
});

// ---------------------------------------------------------------------------
// AB. Explicit comparison parser: all claimed forms must populate the member
//     set — keyword-first AND infix "A vs B" forms.
// ---------------------------------------------------------------------------
for (const [q, a, b] of [
  ['Compare TrailRunner and CityBike.', 'TrailRunner', 'CityBike'],
  ['Compare TrailRunner with CityBike.', 'TrailRunner', 'CityBike'],
  ['Compare TrailRunner to CityBike.', 'TrailRunner', 'CityBike'],
  ['Difference between TrailRunner and CityBike?', 'TrailRunner', 'CityBike'],
  ['TrailRunner vs CityBike', 'TrailRunner', 'CityBike'],
  ['TrailRunner versus CityBike', 'TrailRunner', 'CityBike'],
  ['React vs Vue', 'React', 'Vue'],
  ['Choosing between TrailRunner and CityBike.', 'TrailRunner', 'CityBike']
]) {
  test(`AB: "${q}" extracts both members`, () => {
    const p = classifyResponsePolicy(q, [], bikeKnowledge, sessionState.freshState());
    assert.equal(p.mode, 'COMPARISON');
    assert.equal((p.requiredEntities || []).length, 2, 'must never emit an empty comparison contract');
    assert.match(p.requiredEntities[0], new RegExp(a, 'i'));
    assert.match(p.requiredEntities[1], new RegExp(b, 'i'));
  });
}

test('AB2: unextractable comparison degrades honestly, never empty contract', () => {
  const p = classifyResponsePolicy('Can you compare them?', [], {}, sessionState.freshState());
  assert.notEqual(p.mode, 'COMPARISON', 'no extractable members -> not an empty comparison');
});

// ---------------------------------------------------------------------------
// AC. Evidence requirements are semantic — no project/recruiter hardcoding
//     leaks into unrelated domains.
// ---------------------------------------------------------------------------
test('AC1: skill comparison carries no project requirements', () => {
  const p = classifyResponsePolicy('Compare TypeScript and PostgreSQL.', [], bradleyKnowledge, sessionState.freshState());
  assert.equal(p.mode, 'COMPARISON');
  assert.ok(!(p.evidenceRequirements || []).some(r => /project\d|subject\.experience|subject\.skills/.test(r)),
    'a skills comparison must not demand project or subject-experience evidence');
});

test('AC2: product comparison needs entity evidence, not subject experience', () => {
  const p = classifyResponsePolicy('Compare TrailRunner and CityBike.', [], bikeKnowledge, sessionState.freshState());
  assert.equal(p.mode, 'COMPARISON');
  assert.ok(!(p.evidenceRequirements || []).some(r => /subject\.experience|subject\.skills/.test(r)));
});

test('AC3: role-fit keeps subject evidence requirements', () => {
  const p = classifyResponsePolicy("I'm hiring for a junior frontend developer. Is he a fit?", [], bradleyKnowledge, sessionState.freshState());
  assert.equal(p.mode, 'ROLE_FIT');
  assert.ok((p.evidenceRequirements || []).some(r => /subject\./.test(r)),
    'role-fit legitimately needs subject skills/experience');
});

// ---------------------------------------------------------------------------
// AD. Homogeneous-set type compatibility for elliptical inheritance.
// ---------------------------------------------------------------------------
test('AD1: known incompatible type does not silently inherit into a project set', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, 'Compare ProjectHub and Voice Ops Platform.', k, history);
  const f = frameOf(sessionState.getState(sessionId) && { state: sessionState.getState(sessionId) });
  const alts = (sessionState.getState(sessionId).discourseFrame?.alternatives || []).map(a => a.name);
  assert.equal(alts.length, 2, 'explicit project set exists');
  const t = runTurn(null, sessionId, 'What about JavaScript?', k, history);
  assert.ok(!t.policy.contextualInheritance,
    'a confidently-typed skill must not silently join a homogeneous project set');
});

test('AD2: unknown-type alternative still inherits a homogeneous set', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, 'Compare ProjectHub and Voice Ops Platform.', k, history);
  const t = runTurn(null, sessionId, 'What about Zebra?', k, history);
  assert.equal(t.policy.contextualInheritance, true, 'unknown type preserves the user words as a new option');
});

test('AD3: explicit heterogeneous set is preserved (user truth wins)', () => {
  const sessionId = sid();
  const history = [];
  const k = bradleyKnowledge;
  runTurn(null, sessionId, 'Compare ProjectHub and JavaScript.', k, history);
  const alts = (sessionState.getState(sessionId).discourseFrame?.alternatives || []).map(a => a.name);
  assert.deepEqual(alts, ['ProjectHub', 'JavaScript'],
    'an explicitly constructed mixed set is never "corrected"');
});

// ---------------------------------------------------------------------------
// AE. Fuzzy resolution cannot create silent high-confidence verification.
// ---------------------------------------------------------------------------
test('AE1: low-confidence fuzzy resolution is not promoted to VERIFIED', () => {
  const { buildRelationshipGraph } = require(path.join(ROOT, 'lib/relationship-graph'));
  const g = buildRelationshipGraph(bradleyKnowledge);
  const a = assessEntityEvidence(g, 'data structures');
  assert.notEqual(a.status, 'VERIFIED',
    'fuzzy match onto a certification name is not high-confidence verification');
  assert.equal(a.resolution?.confidence, 'low');
});

test('AE2: exact and alias resolution carry high confidence', () => {
  const { buildRelationshipGraph } = require(path.join(ROOT, 'lib/relationship-graph'));
  const g = buildRelationshipGraph(bradleyKnowledge);
  const exact = assessEntityEvidence(g, 'JavaScript');
  assert.equal(exact.resolution?.confidence, 'high');
  const alias = assessEntityEvidence(g, 'ProjectHub');
  assert.equal(alias.resolution?.confidence, 'high');
  assert.equal(alias.resolution?.method, 'alias');
});
