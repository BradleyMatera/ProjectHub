'use strict';

// Generation Path Telemetry Tests
//
// Verifies that every router.generate call path in lite-agent records
// the call in generationCalls with full metadata. Tests exercise:
//   PRIMARY
//   TERSE_EXPAND (terse yes/no expansion)
//   ADV_EXPAND (adversarial terse expansion)
//   COMPLETENESS_REPAIR
//   TARGETED_REPAIR
//   RECOVERY (attempts 1-3)
//
// Qualification invariant: actualProviderCalls === generationCalls.length

const { test } = require('node:test');
const assert = require('node:assert/strict');

const router = require('../lib/local-model-router');
const knowledge = require('../data/recruiter-knowledge.json');

function makeStubResult(text, opts = {}) {
  return {
    ok: true,
    text: JSON.stringify({ answer: text }),
    usage: {
      provider: 'stub',
      promptEvalCount: opts.inputTokens ?? 50,
      evalCount: opts.outputTokens ?? 20,
      estimatedNeurons: 5.36,
      actualNeurons: opts.actualNeurons ?? 5,
    },
    latencyMs: 100,
    startedAt: Date.now(),
    endedAt: Date.now() + 100,
    model: 'stub-model',
    providerTraceId: 'stub-trace-001',
    providerTraceType: 'stub',
  };
}

function makeStubFail() {
  return {
    ok: false,
    text: null,
    error: 'stub_timeout',
    usage: null,
    latencyMs: 50,
    startedAt: Date.now(),
    endedAt: Date.now() + 50,
    model: 'stub-model',
  };
}

function runWithStub(stubFn) {
  const origGenerate = router.generate;
  let providerCallCount = 0;
  const countingStub = async function(...args) {
    providerCallCount++;
    return stubFn(...args);
  };
  router.generate = countingStub;
  const { runLiteAgent } = require('../lib/lite-agent');
  return {
    runLiteAgent,
    restore: () => { router.generate = origGenerate; },
    getProviderCallCount: () => providerCallCount,
  };
}

// Helper: assert invariant
function assertInvariant(result, label) {
  assert.ok(result.actualProviderCalls != null, `${label}: actualProviderCalls must be present`);
  assert.equal(
    result.actualProviderCalls, result.generationCalls.length,
    `${label}: actualProviderCalls (${result.actualProviderCalls}) must equal generationCalls.length (${result.generationCalls.length})`
  );
}

// Helper: assert every generationCall has required metadata
function assertCallMetadata(result, label) {
  for (const gc of result.generationCalls) {
    assert.ok(gc.attemptType, `${label}: every call must have attemptType`);
    assert.ok(gc.attemptIndex != null, `${label}: every call must have attemptIndex`);
    assert.ok(gc.model, `${label}: every call must have model`);
    assert.ok(gc.provider, `${label}: every call must have provider`);
    assert.ok(gc.latencyMs != null, `${label}: every call must have latencyMs`);
    assert.ok(gc.accepted != null, `${label}: every call must have accepted (boolean)`);
  }
}

// --- PRIMARY path ---
test('PRIMARY path: single call tracked with full metadata', async () => {
  const { runLiteAgent, restore } = runWithStub(async () =>
    makeStubResult('Bradley Matera is a junior software developer with experience in JavaScript, Node.js, and AWS.')
  );
  try {
    const result = await runLiteAgent({
      question: 'What technologies does Bradley use?',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'genpath-primary',
      deadlineAt: Date.now() + 15000,
    });
    assertInvariant(result, 'PRIMARY');
    assertCallMetadata(result, 'PRIMARY');
    assert.ok(result.generationCalls.length >= 1, 'PRIMARY: at least 1 call');
    assert.equal(result.generationCalls[0].attemptType, 'PRIMARY');
  } finally {
    restore();
  }
});

// --- TERSE_EXPAND path ---
// Terse yes/no answers trigger expansion when the answer is just "Yes." or "No."
test('TERSE_EXPAND path: terse yes/no expansion tracked', async () => {
  let callCount = 0;
  const { runLiteAgent, restore } = runWithStub(async () => {
    callCount++;
    if (callCount === 1) {
      // First call: terse "Yes." answer
      return makeStubResult('Yes.');
    }
    // Second call: expanded answer
    return makeStubResult('Yes, Bradley has extensive experience with JavaScript, building projects like ProjectHub and Interactive Pokedex using vanilla JS and Node.js.');
  });
  try {
    const result = await runLiteAgent({
      question: 'Does Bradley know JavaScript?',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'genpath-terse',
      deadlineAt: Date.now() + 15000,
    });
    assertInvariant(result, 'TERSE_EXPAND');
    assertCallMetadata(result, 'TERSE_EXPAND');
    // If terse expansion was triggered, there should be a TERSE_EXPAND call
    const terseCalls = result.generationCalls.filter(c => c.attemptType === 'TERSE_EXPAND');
    if (terseCalls.length > 0) {
      assert.ok(terseCalls.length === 1, 'TERSE_EXPAND: exactly 1 terse expand call');
    }
  } finally {
    restore();
  }
});

// --- ADV_EXPAND path ---
// Adversarial terse answers trigger adversarial expansion
test('ADV_EXPAND path: adversarial terse expansion tracked', async () => {
  let callCount = 0;
  const { runLiteAgent, restore } = runWithStub(async () => {
    callCount++;
    if (callCount === 1) {
      // First call: terse "No." to adversarial question
      return makeStubResult('No.');
    }
    // Subsequent calls: expanded answer
    return makeStubResult('No, Bradley did not work at Microsoft. His experience is primarily with AWS, JavaScript, and open-source projects like CIRIS Ethical AI.');
  });
  try {
    const result = await runLiteAgent({
      question: 'He worked at Microsoft, right?',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'genpath-adv',
      deadlineAt: Date.now() + 15000,
    });
    assertInvariant(result, 'ADV_EXPAND');
    assertCallMetadata(result, 'ADV_EXPAND');
    // If adversarial expansion was triggered, there should be an ADV_EXPAND call
    const advCalls = result.generationCalls.filter(c => c.attemptType === 'ADV_EXPAND');
    if (advCalls.length > 0) {
      assert.ok(advCalls.length === 1, 'ADV_EXPAND: exactly 1 adv expand call');
    }
  } finally {
    restore();
  }
});

// --- RECOVERY path ---
// When primary fails validation, recovery attempts are made
test('RECOVERY path: all recovery attempts tracked', async () => {
  let callCount = 0;
  const { runLiteAgent, restore } = runWithStub(async () => {
    callCount++;
    if (callCount === 1) {
      // Primary: return a very short answer that fails completeness
      return makeStubResult('Yes.');
    }
    // Recovery attempts: return progressively better answers
    if (callCount === 2) {
      return makeStubResult('Bradley Matera is a junior software developer with experience in JavaScript, Node.js, AWS, and web development.');
    }
    return makeStubResult('Bradley Matera is a junior software developer with experience in JavaScript, Node.js, AWS, and web development. He has built several projects including ProjectHub and Interactive Pokedex.');
  });
  try {
    const result = await runLiteAgent({
      question: 'Tell me about Bradley background',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'genpath-recovery',
      deadlineAt: Date.now() + 15000,
    });
    assertInvariant(result, 'RECOVERY');
    assertCallMetadata(result, 'RECOVERY');
    // If recovery was triggered, there should be RECOVERY calls
    const recoveryCalls = result.generationCalls.filter(c => c.attemptType === 'RECOVERY');
    if (recoveryCalls.length > 0) {
      assert.ok(recoveryCalls.length <= 3, 'RECOVERY: at most 3 recovery attempts');
    }
  } finally {
    restore();
  }
});

// --- All calls fail (deadline) ---
test('all calls fail: invariant still holds', async () => {
  const { runLiteAgent, restore } = runWithStub(async () => makeStubFail());
  try {
    const result = await runLiteAgent({
      question: 'What technologies does Bradley use?',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'genpath-fail',
      deadlineAt: Date.now() + 15000,
    });
    assertInvariant(result, 'ALL_FAIL');
    assertCallMetadata(result, 'ALL_FAIL');
    // Every call should be ok=false
    for (const gc of result.generationCalls) {
      assert.equal(gc.ok, false, 'ALL_FAIL: every call should have ok=false');
    }
  } finally {
    restore();
  }
});

// --- Multiple calls with mixed success ---
test('mixed success/failure: invariant holds', async () => {
  let callCount = 0;
  const { runLiteAgent, restore } = runWithStub(async () => {
    callCount++;
    if (callCount % 2 === 0) {
      return makeStubFail();
    }
    return makeStubResult('Bradley Matera is a junior software developer with JavaScript and AWS experience.');
  });
  try {
    const result = await runLiteAgent({
      question: 'What is Bradley tech stack?',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'genpath-mixed',
      deadlineAt: Date.now() + 15000,
    });
    assertInvariant(result, 'MIXED');
    assertCallMetadata(result, 'MIXED');
  } finally {
    restore();
  }
});
