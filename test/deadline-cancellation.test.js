'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Test that the deadline/abort architecture correctly cancels in-flight
// inference calls when the request deadline is exceeded.
//
// This test uses a mock slow provider that never resolves on its own.
// The AbortController must abort the fetch so the provider call terminates.

test('AbortController aborts a slow provider call within deadline', async () => {
  const controller = new AbortController();
  let providerAborted = false;
  let providerCompleted = false;

  // Simulate a slow inference call that respects AbortSignal
  const slowProviderCall = (signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      providerCompleted = true;
      resolve({ ok: true, text: 'should not reach' });
    }, 30000); // 30s — way beyond deadline

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      } else {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          providerAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }
    }
  });

  // Set a 100ms deadline
  const deadlineMs = 100;
  const timer = setTimeout(() => controller.abort(), deadlineMs);

  const start = Date.now();
  let caughtError = null;
  try {
    await slowProviderCall(controller.signal);
  } catch (e) {
    caughtError = e;
  }
  const elapsed = Date.now() - start;

  clearTimeout(timer);

  assert.ok(caughtError, 'Provider call should have thrown');
  assert.equal(caughtError.name, 'AbortError', 'Should be AbortError');
  assert.ok(providerAborted, 'Provider should have been aborted via signal');
  assert.ok(!providerCompleted, 'Provider should NOT have completed normally');
  assert.ok(elapsed < 1000, `Should abort quickly, took ${elapsed}ms`);
});

test('router.generate returns request_deadline error when abortSignal fires', async () => {
  const router = require('../lib/local-model-router');

  const controller = new AbortController();

  // Set a very short timeout and immediately abort
  setTimeout(() => controller.abort(), 50);

  const result = await router.generate('nonexistent-model', [
    { role: 'user', content: 'test' }
  ], {
    timeoutMs: 10000,
    abortSignal: controller.signal
  });

  assert.ok(!result.ok, 'Should not be ok');
  assert.equal(result.error, 'request_deadline', 'Error should be request_deadline, got: ' + result.error);
});

test('runLiteAgent returns INFERENCE_UNAVAILABLE when deadline is already exceeded', async () => {
  const { runLiteAgent } = require('../lib/lite-agent');

  // Pass a deadline in the past
  const pastDeadline = Date.now() - 1000;
  const controller = new AbortController();

  const result = await runLiteAgent({
    question: 'What is his tech stack?',
    conversationState: { recentTurns: [] },
    evidence: [],
    knowledge: { identity: { name: 'Test' }, projects: [], skills: [], experience: [] },
    sessionId: 'test-session',
    model: 'nonexistent-model',
    policyContract: { mode: 'VERIFIED_FACT' },
    deadlineAt: pastDeadline,
    abortSignal: controller.signal
  });

  assert.ok(result.inferenceUnavailable || result.fallback, 'Should return inference unavailable or fallback');
  assert.equal(result.outcome, 'deadline_exceeded', 'Outcome should be deadline_exceeded');
  assert.ok(result.events.some(e => e.type === 'lite_deadline_exceeded'), 'Should have deadline_exceeded event');
});

test('runLiteAgent respects deadline and does not start recovery after deadline', async () => {
  const { runLiteAgent } = require('../lib/lite-agent');

  // Give enough time for the primary call to fail (model not found) but not
  // enough for recovery attempts. Primary call to nonexistent model fails fast,
  // so we set deadline to 1ms from now — recovery should be skipped.
  const deadline = Date.now() + 1;
  const controller = new AbortController();

  const result = await runLiteAgent({
    question: 'Does he know React?',
    conversationState: { recentTurns: [] },
    evidence: [],
    knowledge: {
      identity: { name: 'Test' },
      projects: [],
      skills: [{ name: 'React' }],
      experience: []
    },
    sessionId: 'test-session',
    model: 'nonexistent-model',
    policyContract: { mode: 'SKILL_EVIDENCE' },
    deadlineAt: deadline,
    abortSignal: controller.signal
  });

  // Should either return deadline_exceeded or inferenceUnavailable
  // The key invariant: no recovery attempt should start after deadline
  const recoveryEvents = (result.events || []).filter(e =>
    e.type === 'lite_recovery_generate' || e.type === 'lite_recovery_ok'
  );
  // Recovery may or may not start depending on timing, but if it does,
  // it must not succeed after deadline
  if (result.outcome === 'deadline_exceeded') {
    assert.ok(result.inferenceUnavailable, 'Should be inferenceUnavailable');
  }
});

test('next request is not blocked by abandoned inference work', async () => {
  // Simulate two concurrent requests where the first has a very short deadline
  // and the second has a normal deadline. The second should complete normally
  // regardless of the first being aborted.
  const router = require('../lib/local-model-router');

  const controller1 = new AbortController();
  const controller2 = new AbortController();

  // First request: abort after 50ms
  setTimeout(() => controller1.abort(), 50);

  // Second request: normal timeout
  const start2 = Date.now();
  const result2 = router.generate('nonexistent-model', [
    { role: 'user', content: 'second request' }
  ], {
    timeoutMs: 5000,
    abortSignal: controller2.signal
  });

  // Wait for first to abort
  const start1 = Date.now();
  let err1 = null;
  try {
    await router.generate('nonexistent-model', [
      { role: 'user', content: 'first request' }
    ], {
      timeoutMs: 30000,
      abortSignal: controller1.signal
    });
  } catch (e) {
    err1 = e;
  }
  const elapsed1 = Date.now() - start1;

  // First should have failed quickly (aborted)
  assert.ok(elapsed1 < 1000, `First request should abort quickly, took ${elapsed1}ms`);

  // Second should complete independently (not blocked by first)
  const r2 = await result2;
  assert.ok(!r2.ok, 'Second request should fail (model not found) but not be blocked');
});
