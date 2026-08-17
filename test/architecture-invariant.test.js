'use strict';

// Architecture Invariant Regression Test
//
// Verifies that every normal conversational visible reply from runLiteAgent
// is generative (has generationCalls.length >= 1) and that visibleReplySource
// is one of the canonical generative sources.
//
// A technical failure is allowed to have zero generation calls only if
// inference never actually started.
//
// No normal conversational result may use STATIC, TEMPLATE, DETERMINISTIC,
// or HARDCODED as a final visible prose source.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// We need to stub the router before requiring lite-agent
const router = require('../lib/local-model-router');

// Use the actual recruiter knowledge base so the grounding validator has real entities
const knowledge = require('../data/recruiter-knowledge.json');

const { buildRecoveryContract, buildRecoveryPrompt, buildTerseYesNoContract, buildTerseAdversarialContract, detectAdversarialContract } = require('../lib/recovery-contract');
const { normalizeSourceVoice } = require('../lib/source-preparation');

const CANONICAL_SOURCES = ['GENERATED_PRIMARY', 'GENERATED_REPAIR', 'GENERATED_RECOVERY', 'CACHE_HIT_GENERATED', 'TECHNICAL_FAILURE', 'ARCHITECTURE_VIOLATION'];
const FORBIDDEN_SOURCES = ['STATIC', 'TEMPLATE', 'DETERMINISTIC', 'HARDCODED'];
const ALLOWED_PROSE_SOURCES = new Set(['DIRECT_KB', 'MODEL_GENERATION', 'TECHNICAL_ERROR', null]);

function makeStubResult(text, opts = {}) {
  return {
    ok: true,
    text: JSON.stringify({ answer: text }),
    usage: {
      provider: 'stub',
      promptEvalCount: 50,
      evalCount: 20,
      estimatedNeurons: 10,
      actualNeurons: opts.actualNeurons ?? 10,
    },
    latencyMs: 100,
    startedAt: Date.now(),
    endedAt: Date.now() + 100,
    model: 'stub-model',
    providerTraceId: 'stub-trace-001',
    providerTraceType: 'stub',
  };
}

function classifyVisibleReplySource(result) {
  if (!result || !result.reply) return null;
  const calls = result.generationCalls || [];
  if (calls.length === 0) return 'ARCHITECTURE_VIOLATION';
  const accepted = calls.find(c => c.accepted);
  if (!accepted) return 'ARCHITECTURE_VIOLATION';
  if (accepted.attemptType === 'PRIMARY') return 'GENERATED_PRIMARY';
  if (accepted.attemptType === 'COMPLETENESS_REPAIR' || accepted.attemptType === 'TARGETED_REPAIR') return 'GENERATED_REPAIR';
  if (accepted.attemptType === 'RECOVERY') return 'GENERATED_RECOVERY';
  return 'ARCHITECTURE_VIOLATION';
}

function runWithStub(stubFn) {
  const origGenerate = router.generate;
  router.generate = stubFn;
  let providerCallCount = 0;
  const countingStub = async function(...args) {
    providerCallCount++;
    return stubFn(...args);
  };
  router.generate = countingStub;
  const { runLiteAgent } = require('../lib/lite-agent');
  return { runLiteAgent, restore: () => { router.generate = origGenerate; }, getProviderCallCount: () => providerCallCount };
}

test('greeting produces generative reply with generationCalls >= 1', async () => {
  const { runLiteAgent, restore } = runWithStub(async () => makeStubResult('Hello Sarah, welcome to ProjectHub. What would you like to know about Bradley work?'));
  try {
    const result = await runLiteAgent({
      question: 'Hi, I am Sarah',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'test-1',
      deadlineAt: Date.now() + 15000,
    });
    const source = classifyVisibleReplySource(result);
    assert.ok(result.generationCalls.length >= 1, 'greeting must have at least 1 generation call');
    assert.ok(CANONICAL_SOURCES.includes(source), `visibleReplySource must be canonical, got: ${source}`);
    assert.ok(!FORBIDDEN_SOURCES.includes(source), 'visibleReplySource must not be a forbidden deterministic source');
    assert.ok(ALLOWED_PROSE_SOURCES.has(result.proseSource), `proseSource must be canonical, got: ${result.proseSource}`);
  } finally {
    restore();
  }
});

test('identity question produces generative reply with generationCalls >= 1', async () => {
  const { runLiteAgent, restore } = runWithStub(async () => makeStubResult('Hello Sarah, welcome to ProjectHub. What would you like to know about Bradley work?'));
  try {
    const result = await runLiteAgent({
      question: 'Who are you?',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'test-2',
      deadlineAt: Date.now() + 15000,
    });
    // Even if the reply is null (all calls rejected), generationCalls must be >= 1
    assert.ok(result.generationCalls.length >= 1, 'identity question must have at least 1 generation call');
    if (result.reply) {
      const source = classifyVisibleReplySource(result);
      assert.ok(CANONICAL_SOURCES.includes(source), `visibleReplySource must be canonical, got: ${source}`);
    }
    assert.ok(ALLOWED_PROSE_SOURCES.has(result.proseSource), `proseSource must be canonical, got: ${result.proseSource}`);
  } finally {
    restore();
  }
});

test('factual question produces generative reply with generationCalls >= 1', async () => {
  const { runLiteAgent, restore } = runWithStub(async () => makeStubResult('Hello Sarah, welcome to ProjectHub. What would you like to know about Bradley work?'));
  try {
    const result = await runLiteAgent({
      question: 'What is Bradley tech stack?',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'test-3',
      deadlineAt: Date.now() + 15000,
    });
    assert.ok(result.generationCalls.length >= 1, 'factual question must have at least 1 generation call');
    if (result.reply) {
      const source = classifyVisibleReplySource(result);
      assert.ok(CANONICAL_SOURCES.includes(source), `visibleReplySource must be canonical, got: ${source}`);
    }
    assert.ok(ALLOWED_PROSE_SOURCES.has(result.proseSource), `proseSource must be canonical, got: ${result.proseSource}`);
  } finally {
    restore();
  }
});

test('adversarial/negative question produces generative reply with generationCalls >= 1', async () => {
  const { runLiteAgent, restore } = runWithStub(async () => makeStubResult('Hello Sarah, welcome to ProjectHub. What would you like to know about Bradley work?'));
  try {
    const result = await runLiteAgent({
      question: 'He worked at Microsoft, right?',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'test-4',
      deadlineAt: Date.now() + 15000,
    });
    assert.ok(result.generationCalls.length >= 1, 'adversarial question must have at least 1 generation call');
    if (result.reply) {
      const source = classifyVisibleReplySource(result);
      assert.ok(CANONICAL_SOURCES.includes(source), `visibleReplySource must be canonical, got: ${source}`);
    }
    assert.ok(ALLOWED_PROSE_SOURCES.has(result.proseSource), `proseSource must be canonical, got: ${result.proseSource}`);
  } finally {
    restore();
  }
});

test('actualProviderCalls equals generationCalls.length for normal reply', async () => {
  const { runLiteAgent, restore } = runWithStub(async () => makeStubResult('Hello Sarah, welcome to ProjectHub. What would you like to know about Bradley work?'));
  try {
    const result = await runLiteAgent({
      question: 'What technologies does Bradley use?',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'test-5',
      deadlineAt: Date.now() + 15000,
    });
    assert.ok(result.actualProviderCalls != null, 'actualProviderCalls must be present');
    assert.equal(result.actualProviderCalls, result.generationCalls.length,
      `actualProviderCalls (${result.actualProviderCalls}) must equal generationCalls.length (${result.generationCalls.length})`);
  } finally {
    restore();
  }
});

test('no normal conversational result uses forbidden deterministic prose source', async () => {
  const { runLiteAgent, restore } = runWithStub(async () => makeStubResult('Hello Sarah, welcome to ProjectHub. What would you like to know about Bradley work?'));
  try {
    const result = await runLiteAgent({
      question: 'Tell me about Bradley skills',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'test-6',
      deadlineAt: Date.now() + 15000,
    });
    if (result.reply) {
      const source = classifyVisibleReplySource(result);
      assert.ok(!FORBIDDEN_SOURCES.includes(source),
        `visibleReplySource must not be STATIC/TEMPLATE/DETERMINISTIC/HARDCODED, got: ${source}`);
    }
    assert.ok(ALLOWED_PROSE_SOURCES.has(result.proseSource), `proseSource must be canonical, got: ${result.proseSource}`);
    // Even with no visible reply, generationCalls must be >= 1 (the model was called)
    assert.ok(result.generationCalls.length >= 1, 'must have at least 1 generation call even if all rejected');
  } finally {
    restore();
  }
});

test('recovery contract keyFacts are raw fact objects, not composed prose', () => {
  const toolResult = { found: true, project: { name: 'ProjectHub', tech: ['JavaScript', 'React'], description: 'A project search widget.' } };
  const contract = buildRecoveryContract(toolResult, { operation: 'get_project' }, 'What tech does ProjectHub use?', '', knowledge, 'What tech does ProjectHub use?');
  assert.ok(contract, 'buildRecoveryContract should return a contract');
  assert.ok(contract.keyFacts && contract.keyFacts.length > 0, 'contract should have keyFacts');
  assert.ok(contract.keyFacts.every(f => typeof f === 'object' && f !== null && typeof f.type === 'string'),
    'all keyFacts should be raw fact objects with a type field');
});

test('buildRecoveryPrompt renders raw fact objects generically', () => {
  const contract = {
    intent: 'PROJECT_TECH',
    directAnswer: null,
    instructions: 'Name the technologies.',
    boundary: null,
    keyFacts: [
      { type: 'project', value: 'ProjectHub', technology: ['JavaScript', 'React'] }
    ],
    responseShape: { minSentences: 1, maxSentences: 2 }
  };
  const prompt = buildRecoveryPrompt(contract, 'What tech does ProjectHub use?', knowledge);
  assert.ok(prompt.systemPrompt.includes('KEY_FACTS'), 'prompt should contain KEY_FACTS section');
  assert.ok(prompt.systemPrompt.includes('project: ProjectHub'), 'prompt should render raw fact generically');
});

test('terse adversarial contract keyFacts are raw fact objects', () => {
  const contract = buildTerseAdversarialContract('No', 'He has 10 years of experience, right?', knowledge);
  if (contract) {
    assert.ok(contract.keyFacts.every(f => typeof f === 'object' && f !== null && typeof f.type === 'string'),
      'terse adversarial keyFacts should be raw fact objects');
  }
});

test('normalizeSourceVoice lives in generic source-preparation module and transforms first person', () => {
  const firstPerson = 'I am early in my career, but I learn quickly.';
  const normalized = normalizeSourceVoice(firstPerson, knowledge);
  assert.ok(!/\bI\b/.test(normalized), 'First person "I" should be converted');
  assert.ok(/\b(He|She|They) is\b/.test(normalized), 'Subject should be third-person singular');
});
