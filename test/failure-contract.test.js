'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Final Failure Contract Tests
// Proves that when all generation attempts fail, the system returns a typed
// technical failure — NOT deterministic chatbot prose.

describe('Final Failure Contract', () => {

  it('FC1: All generation failures return null reply with inferenceUnavailable', async () => {
    const { runLiteAgent } = require('../lib/lite-agent');
    const router = require('../lib/local-model-router');

    const origGenerate = router.generate;
    router.generate = async function() {
      return { ok: false, text: '', error: 'Connection refused', latencyMs: 100, usage: {} };
    };

    try {
      const result = await runLiteAgent({
        question: 'What projects has the candidate built?',
        conversationState: { turns: [] },
        evidence: [],
        knowledge: { projects: [], skills: {}, identity: { name: 'Test' } },
        sessionId: 'test-failure-1',
        deadlineAt: Date.now() + 15000
      });

      // Must NOT have a reply — no deterministic prose
      assert.equal(result.reply, null, 'Failed generation must return null reply, not deterministic prose');

      // Must signal inference unavailable
      assert.ok(result.inferenceUnavailable, 'Failed generation must set inferenceUnavailable=true');

      // Must have generation calls tracked
      assert.ok(result.generationCalls.length >= 1, 'Failed generation must track generationCalls');

      // Telemetry invariant must hold
      assert.equal(result.actualProviderCalls, result.generationCalls.length,
        'Telemetry invariant must hold even on failure');
    } finally {
      router.generate = origGenerate;
    }
  });

  it('FC2: Deadline exceeded returns null reply with typed outcome', async () => {
    const { runLiteAgent } = require('../lib/lite-agent');
    const router = require('../lib/local-model-router');

    const origGenerate = router.generate;
    router.generate = async function() {
      // Simulate a very slow response
      await new Promise(r => setTimeout(r, 200));
      return { ok: true, text: '{"answer":"test"}', latencyMs: 200, usage: {} };
    };

    try {
      // Set deadline in the past to force deadline exceeded
      const result = await runLiteAgent({
        question: 'What projects has the candidate built?',
        conversationState: { turns: [] },
        evidence: [],
        knowledge: { projects: [], skills: {}, identity: { name: 'Test' } },
        sessionId: 'test-deadline-1',
        deadlineAt: Date.now() - 1 // Already exceeded
      });

      assert.equal(result.reply, null, 'Deadline exceeded must return null reply');
      assert.ok(result.inferenceUnavailable || result.outcome === 'deadline_exceeded',
        'Deadline exceeded must set inferenceUnavailable or outcome=deadline_exceeded');
    } finally {
      router.generate = origGenerate;
    }
  });

  it('FC3: All recovery attempts failing returns null reply', async () => {
    const { runLiteAgent } = require('../lib/lite-agent');
    const router = require('../lib/local-model-router');

    let callCount = 0;
    const origGenerate = router.generate;
    // First call returns invalid answer, subsequent calls (recovery) all fail
    router.generate = async function() {
      callCount++;
      if (callCount === 1) {
        return { ok: true, text: '{"answer":"yes"}', latencyMs: 100, usage: {} };
      }
      return { ok: false, text: '', error: 'timeout', latencyMs: 50, usage: {} };
    };

    try {
      const result = await runLiteAgent({
        question: 'Did the candidate work at Google?',
        conversationState: { turns: [] },
        evidence: [],
        knowledge: { projects: [], skills: {}, identity: { name: 'Test' } },
        sessionId: 'test-recovery-fail-1',
        deadlineAt: Date.now() + 15000
      });

      // Recovery should have been attempted and failed
      assert.equal(result.reply, null, 'All recovery failing must return null reply');
      assert.ok(result.inferenceUnavailable, 'Must set inferenceUnavailable');
      assert.ok(result.generationCalls.length >= 1, 'Must track all generation calls');
      assert.equal(result.actualProviderCalls, result.generationCalls.length,
        'Telemetry invariant must hold');
    } finally {
      router.generate = origGenerate;
    }
  });

  it('FC4: No deterministic fallback prose in any failure path', async () => {
    const { runLiteAgent } = require('../lib/lite-agent');
    const router = require('../lib/local-model-router');

    const origGenerate = router.generate;
    router.generate = async function() {
      return { ok: false, text: '', error: 'service unavailable', latencyMs: 0, usage: {} };
    };

    try {
      const result = await runLiteAgent({
        question: 'What is the candidate\'s strongest skill?',
        conversationState: { turns: [] },
        evidence: [],
        knowledge: { projects: [], skills: {}, identity: { name: 'Test' } },
        sessionId: 'test-no-prose-1',
        deadlineAt: Date.now() + 15000
      });

      // Check that reply is null, not a hardcoded string
      assert.equal(result.reply, null, 'No deterministic prose in failure path');

      // Check that fallback flag is set but no reply
      assert.ok(result.fallback || result.inferenceUnavailable,
        'Fallback flag should be set on failure');

      // Verify no hardcoded conversational strings
      const resultStr = JSON.stringify(result);
      const DETERMINISTIC_PHRASES = [
        'I can help you with',
        'Let me tell you about',
        'Based on the information',
        'The candidate has',
        'I\'m sorry, I can\'t',
        'I am unable to'
      ];
      for (const phrase of DETERMINISTIC_PHRASES) {
        if (result.reply) {
          assert.ok(!result.reply.includes(phrase),
            `Failure reply must not contain deterministic phrase: "${phrase}"`);
        }
      }
    } finally {
      router.generate = origGenerate;
    }
  });

  it('FC5: Generation calls tracked even when all fail', async () => {
    const { runLiteAgent } = require('../lib/lite-agent');
    const router = require('../lib/local-model-router');

    const origGenerate = router.generate;
    let calls = 0;
    router.generate = async function() {
      calls++;
      return { ok: false, text: '', error: `error-${calls}`, latencyMs: 10, usage: {} };
    };

    try {
      const result = await runLiteAgent({
        question: 'What projects are in the portfolio?',
        conversationState: { turns: [] },
        evidence: [],
        knowledge: { projects: [], skills: {}, identity: { name: 'Test' } },
        sessionId: 'test-tracking-1',
        deadlineAt: Date.now() + 15000
      });

      // Every call must be tracked
      assert.equal(result.actualProviderCalls, calls,
        `actualProviderCalls (${result.actualProviderCalls}) must equal actual router.generate calls (${calls})`);
      assert.equal(result.generationCalls.length, calls,
        `generationCalls.length (${result.generationCalls.length}) must equal actual calls (${calls})`);

      // All calls must be marked as not accepted
      for (const gc of result.generationCalls) {
        assert.equal(gc.accepted, false, 'Failed generation calls must have accepted=false');
      }
    } finally {
      router.generate = origGenerate;
    }
  });
});
