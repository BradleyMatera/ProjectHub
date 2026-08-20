'use strict';

/**
 * Qualification harness with immutable scheduled-attempt accounting.
 *
 * Each scheduled case/run becomes an attempt record. Retries are stored
 * separately and never overwrite the original scheduled result. The gate
 * score uses the original scheduled attempts only.
 */

const crypto = require('crypto');

const VALID_QUALITIES = new Set(['GOOD', 'BAD', 'ERROR', 'TIMEOUT', 'INCOMPLETE', 'UNRATED']);

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createAttempt({
  caseId,
  scheduledAttempt,
  gateRunId,
  runtimeSHA,
  isRetry = false,
  retryOfAttemptId = null,
  question = null
}) {
  return {
    attemptId: generateId(),
    caseId,
    scheduledAttempt,
    gateRunId: gateRunId || null,
    runtimeSHA: runtimeSHA || null,
    timestamp: new Date().toISOString(),
    isRetry,
    retryOfAttemptId,
    question,
    status: 'pending',
    provider: null,
    model: null,
    reply: null,
    quality: null,
    failureReason: null,
    proseSource: null,
    contract: null,
    generationCalls: null,
    raw: null
  };
}

async function runAttempt(attempt, options = {}) {
  const { runner, scorer, testCase, knowledge } = options;
  if (!runner) throw new Error('runner is required');

  const runnerResult = await runner(attempt);
  attempt.status = 'completed';
  attempt.raw = runnerResult;

  // Extract standard fields if available.
  if (runnerResult && typeof runnerResult === 'object') {
    attempt.reply = runnerResult.reply || runnerResult.body?.reply || null;
    attempt.provider = runnerResult.provider || runnerResult.body?.provider || null;
    attempt.model = runnerResult.model || runnerResult.body?.model || null;
    attempt.proseSource = runnerResult.proseSource || runnerResult.body?.proseSource || null;
    attempt.contract = runnerResult.contract || runnerResult.body?.contract || null;
    attempt.generationCalls = runnerResult.pipeline || runnerResult.body?.pipeline || null;

    if (runnerResult.technicalError || runnerResult.inferenceUnavailable || runnerResult.error) {
      attempt.quality = 'ERROR';
      attempt.failureReason = runnerResult.error || 'TECHNICAL_ERROR';
    } else if (scorer && testCase) {
      const score = scorer(testCase, runnerResult, { knowledge });
      attempt.quality = score.quality || 'UNRATED';
      attempt.failureReason = score.reason || null;
    } else if (runnerResult.quality) {
      attempt.quality = runnerResult.quality;
      attempt.failureReason = runnerResult.reason || null;
    } else {
      attempt.quality = 'UNRATED';
    }
  } else {
    attempt.quality = 'ERROR';
    attempt.failureReason = 'RUNNER_RETURNED_NO_RESULT';
  }

  return attempt;
}

function scoreScheduled(run) {
  const scheduled = run.attempts.filter(a => !a.isRetry);
  const good = scheduled.filter(a => a.quality === 'GOOD');
  return { good: good.length, total: scheduled.length };
}

function scoreRetries(run) {
  const retries = run.attempts.filter(a => a.isRetry);
  const good = retries.filter(a => a.quality === 'GOOD');
  return { good: good.length, total: retries.length };
}

class QualificationRun {
  constructor({ gateRunId, runtimeSHA, label } = {}) {
    this.gateRunId = gateRunId || generateId();
    this.runtimeSHA = runtimeSHA || null;
    this.label = label || null;
    this.attempts = [];
  }

  createScheduledAttempt({ caseId, scheduledAttempt, question }) {
    const attempt = createAttempt({
      caseId,
      scheduledAttempt,
      gateRunId: this.gateRunId,
      runtimeSHA: this.runtimeSHA,
      isRetry: false,
      question
    });
    this.attempts.push(attempt);
    return attempt;
  }

  createRetry({ originalAttemptId, question }) {
    const original = this.attempts.find(a => a.attemptId === originalAttemptId);
    if (!original) throw new Error(`Original attempt ${originalAttemptId} not found`);
    const attempt = createAttempt({
      caseId: original.caseId,
      scheduledAttempt: original.scheduledAttempt,
      gateRunId: this.gateRunId,
      runtimeSHA: this.runtimeSHA,
      isRetry: true,
      retryOfAttemptId: originalAttemptId,
      question: question || original.question
    });
    this.attempts.push(attempt);
    return attempt;
  }

  async run(attempt, options) {
    return runAttempt(attempt, options);
  }

  getScheduledResult() {
    return scoreScheduled(this);
  }

  getRetryResult() {
    return scoreRetries(this);
  }

  getAllAttempts() {
    return this.attempts;
  }

  summary() {
    const scheduled = this.getScheduledResult();
    const retries = this.getRetryResult();
    return {
      gateRunId: this.gateRunId,
      runtimeSHA: this.runtimeSHA,
      label: this.label,
      scheduled: `${scheduled.good}/${scheduled.total}`,
      retries: `${retries.good}/${retries.total}`,
      actualAttempts: this.attempts.length
    };
  }

  toJSON() {
    return {
      gateRunId: this.gateRunId,
      runtimeSHA: this.runtimeSHA,
      label: this.label,
      attempts: this.attempts,
      scheduled: this.getScheduledResult(),
      retries: this.getRetryResult()
    };
  }
}

module.exports = {
  createAttempt,
  runAttempt,
  scoreScheduled,
  scoreRetries,
  QualificationRun,
  VALID_QUALITIES
};
