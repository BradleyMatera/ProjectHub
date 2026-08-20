'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { QualificationRun, VALID_QUALITIES } = require('../lib/qualification-harness');

function fakeRunner(attempt) {
  const quality = attempt.caseId === 'fail' ? 'ERROR' :
    attempt.question === 'bad' ? 'ERROR' :
    'GOOD';
  return {
    reply: `reply-${attempt.attemptId}`,
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.2-3b-instruct',
    quality
  };
}

function fakeScorer(testCase, result) {
  return { quality: result.quality, reason: result.quality === 'ERROR' ? 'TECHNICAL_ERROR' : null };
}

test('five scheduled GOOD attempts = 5/5', async () => {
  const run = new QualificationRun({ gateRunId: 't1', runtimeSHA: 'abc' });
  for (let i = 1; i <= 5; i++) {
    const a = run.createScheduledAttempt({ caseId: 'good', scheduledAttempt: i, question: 'good' });
    await run.run(a, { runner: fakeRunner, scorer: fakeScorer, testCase: {} });
  }
  assert.deepEqual(run.getScheduledResult(), { good: 5, total: 5 });
  assert.deepEqual(run.getRetryResult(), { good: 0, total: 0 });
});

test('four GOOD + one TECHNICAL_ERROR + one successful retry = 4/5 scheduled and 1/1 diagnostic', async () => {
  const run = new QualificationRun({ gateRunId: 't2', runtimeSHA: 'abc' });
  const attempts = [];
  for (let i = 1; i <= 5; i++) {
    const q = i === 4 ? 'bad' : 'good';
    const a = run.createScheduledAttempt({ caseId: 'mixed', scheduledAttempt: i, question: q });
    attempts.push(a);
    await run.run(a, { runner: fakeRunner, scorer: fakeScorer, testCase: {} });
  }

  const failed = attempts[3];
  assert.equal(failed.quality, 'ERROR');
  assert.equal(failed.failureReason, 'TECHNICAL_ERROR');

  const retry = run.createRetry({ originalAttemptId: failed.attemptId, question: 'good' });
  await run.run(retry, { runner: fakeRunner, scorer: fakeScorer, testCase: {} });

  assert.deepEqual(run.getScheduledResult(), { good: 4, total: 5 });
  assert.deepEqual(run.getRetryResult(), { good: 1, total: 1 });
});

test('retry cannot mutate the original attempt', async () => {
  const run = new QualificationRun({ gateRunId: 't3', runtimeSHA: 'abc' });
  const a = run.createScheduledAttempt({ caseId: 'mutate', scheduledAttempt: 1, question: 'bad' });
  await run.run(a, { runner: fakeRunner, scorer: fakeScorer, testCase: {} });
  const originalQuality = a.quality;
  const originalAttemptId = a.attemptId;

  const retry = run.createRetry({ originalAttemptId: a.attemptId, question: 'good' });
  await run.run(retry, { runner: fakeRunner, scorer: fakeScorer, testCase: {} });

  assert.equal(a.quality, originalQuality, 'original attempt quality was mutated');
  assert.equal(a.attemptId, originalAttemptId);
  assert.ok(retry.isRetry);
  assert.equal(retry.retryOfAttemptId, a.attemptId);
  assert.notEqual(retry.attemptId, a.attemptId);
});

test('23x5 scheduled denominator is 115 and retries are excluded', async () => {
  const run = new QualificationRun({ gateRunId: 't4', runtimeSHA: 'abc' });
  for (let i = 1; i <= 23; i++) {
    for (let j = 1; j <= 5; j++) {
      const a = run.createScheduledAttempt({ caseId: `case-${i}`, scheduledAttempt: j, question: 'good' });
      await run.run(a, { runner: fakeRunner, scorer: fakeScorer, testCase: {} });
    }
  }
  // Add a retry for one failure to show it does not change the scheduled denominator.
  const a = run.createScheduledAttempt({ caseId: 'case-24', scheduledAttempt: 1, question: 'bad' });
  await run.run(a, { runner: fakeRunner, scorer: fakeScorer, testCase: {} });
  const retry = run.createRetry({ originalAttemptId: a.attemptId, question: 'good' });
  await run.run(retry, { runner: fakeRunner, scorer: fakeScorer, testCase: {} });

  assert.equal(run.getScheduledResult().total, 116, 'scheduled attempts are 23*5+1');
  assert.equal(run.getScheduledResult().good, 115, 'only scheduled GOOD counts');
  assert.equal(run.getRetryResult().total, 1, 'retry is separate');
});

test('every run preserves raw results even after retries', async () => {
  const run = new QualificationRun({ gateRunId: 't5', runtimeSHA: 'abc' });
  const a = run.createScheduledAttempt({ caseId: 'preserve', scheduledAttempt: 1, question: 'bad' });
  await run.run(a, { runner: fakeRunner, scorer: fakeScorer, testCase: {} });
  const originalRaw = JSON.stringify(a.raw);

  const retry = run.createRetry({ originalAttemptId: a.attemptId, question: 'good' });
  await run.run(retry, { runner: fakeRunner, scorer: fakeScorer, testCase: {} });

  assert.equal(JSON.stringify(a.raw), originalRaw, 'original raw result was not overwritten by retry');
  assert.notEqual(a.raw.quality, retry.raw.quality);
});
