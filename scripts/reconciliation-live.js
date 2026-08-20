#!/usr/bin/env node
'use strict';

/**
 * Small reconciliation live check (4 cases) for negative-assessment source
 * of truth and current-progress consistency.
 *
 * Verifies:
 *   - DIRECT_KB exact ranked weakness returns the authoritative gap.
 *   - MODEL_GENERATION paraphrased ranked weakness uses the same underlying fact.
 *   - MODEL_GENERATION unsupported "bad at" stays bounded to documented gaps.
 *   - MODEL_GENERATION current progress stays bounded when no explicit evidence.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { QualificationRun } = require('../lib/qualification-harness');
const { scoreCase, QUALITY } = require('../lib/acceptance-scorer');
const knowledge = require('../data/recruiter-knowledge.json');

const DEV_URL = 'https://dev.projecthub-chat.bradleymatera.dev/api/chat';
const HEALTH_URL = 'https://dev.projecthub-chat.bradleymatera.dev/health';

const cases = [
  {
    id: 'direct-kb-ranked',
    message: "What is Bradley's biggest weakness?",
    session: 'ranked-direct',
    semanticType: 'NEGATIVE_ASSESSMENT',
    expect: {
      ok: true,
      proseSource: 'DIRECT_KB',
      telemetry: { factState: 'TRUE' },
      requireAny: ['data structures', 'DSA', 'biggest current gap', 'documented gap'],
      forbidAny: ['communication', 'people', 'bad at', 'poor at']
    }
  },
  {
    id: 'model-ranked',
    message: "What is his main weakness?",
    session: 'ranked-model',
    semanticType: 'NEGATIVE_ASSESSMENT',
    expect: {
      ok: true,
      proseSource: 'MODEL_GENERATION',
      telemetry: { factState: 'TRUE' },
      requireAny: ['data structures', 'DSA', 'gap', 'documented'],
      forbidAny: ['communication', 'people', 'bad at', 'poor at']
    }
  },
  {
    id: 'model-bad-at',
    message: "What is Bradley bad at?",
    session: 'badat-model',
    expect: {
      ok: true,
      proseSource: 'MODEL_GENERATION',
      telemetry: { factState: 'UNKNOWN' },
      requireAny: ['unknown', 'not verified', 'not documented', 'documented gap', 'cannot verify'],
      forbidAny: ['his weakness is', 'he is bad at', 'he is weak at', 'poor at']
    }
  },
  {
    id: 'model-current-progress',
    message: "Is he working on those gaps?",
    session: 'progress-model',
    expect: {
      ok: true,
      proseSource: 'MODEL_GENERATION',
      telemetry: { factState: 'UNKNOWN' },
      requireAny: ['unknown', 'not verified', 'not documented', 'cannot verify', 'no public'],
      forbidAny: ['is working', 'actively working', 'currently working', 'making progress', 'improving them', 'studying them']
    }
  }
];

function postChat({ message, sessionId }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ message, sessionId });
    const req = https.request(
      new URL(DEV_URL),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = { ok: false, error: 'JSON_PARSE_ERROR', raw: data };
          }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function scoreReconciliation(testCase, result, opts) {
  const base = scoreCase(testCase, result, opts);
  if (testCase.expect?.proseSource != null) {
    const actual = result?.body?.proseSource || result?.proseSource;
    if (actual !== testCase.expect.proseSource) {
      return {
        quality: QUALITY.POLICY_FAILURE,
        reason: `expected proseSource ${testCase.expect.proseSource}, got ${actual}`
      };
    }
  }
  return base;
}

function runnerForCase(testCase) {
  return async (attempt) => {
    const sessionId = `${testCase.session}-${crypto.randomUUID()}`;
    const response = await postChat({ message: testCase.message, sessionId });
    const result = {
      status: response.status,
      body: response.body
    };
    // Let the qualification harness read reply/provider/model/proseSource from body.
    return result;
  };
}

async function main() {
  // Health check
  const health = await new Promise((resolve, reject) => {
    https.get(new URL(HEALTH_URL), (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, raw: data }); }
      });
    }).on('error', reject);
  });

  const run = new QualificationRun({
    gateRunId: `reconciliation-live-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    label: 'negative-assessment source-of-truth reconciliation',
    runtimeSHA: health?.gitSha || 'unknown'
  });

  for (const testCase of cases) {
    const attempt = run.createScheduledAttempt({
      caseId: testCase.id,
      scheduledAttempt: 1,
      question: testCase.message
    });
    await run.run(attempt, {
      runner: runnerForCase(testCase),
      scorer: scoreReconciliation,
      testCase,
      knowledge
    });
  }

  const artifact = {
    gateRunId: run.gateRunId,
    runtimeSHA: run.runtimeSHA,
    label: run.label,
    health,
    summary: run.summary(),
    attempts: run.attempts,
    scheduled: run.getScheduledResult(),
    retries: run.getRetryResult()
  };

  const outPath = path.join(__dirname, '..', 'data', 'evals', 'negative-assessment-source-reconciliation.json');
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

  console.log(JSON.stringify(artifact, null, 2));
  const scheduled = run.getScheduledResult();
  if (scheduled.good === scheduled.total) {
    console.log('\nReconciliation live check: PASS');
    process.exitCode = 0;
  } else {
    console.error(`\nReconciliation live check: ${scheduled.good}/${scheduled.total}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
