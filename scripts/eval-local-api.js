'use strict';

// Semantic acceptance harness for ProjectHub chat API.
// Uses lib/acceptance-scorer.js for strict, knowledge-driven scoring.
//
// Usage:
//   node scripts/eval-local-api.js
//   PROJECTHUB_API_URL=https://dev.projecthub-chat.bradleymatera.dev node scripts/eval-local-api.js
//   PROJECTHUB_EVAL_RESUME=1 node scripts/eval-local-api.js

const fs = require('fs');
const path = require('path');
const { scoreCase, QUALITY, loadDefaultKnowledge } = require('../lib/acceptance-scorer');
const { cases } = require('../lib/eval-cases');

const BASE_URL = process.env.PROJECTHUB_API_URL || 'http://127.0.0.1:3000';
const MAX_LATENCY_MS = Number(process.env.PROJECTHUB_MAX_LATENCY_MS || 60000);
const CASE_DELAY_MS = Number(process.env.PROJECTHUB_EVAL_INTERVAL_MS || 1200);
const MAX_RETRIES = Number(process.env.PROJECTHUB_EVAL_MAX_RETRIES || 3);
const RATE_LIMIT_BACKOFF_MS = Number(process.env.PROJECTHUB_RATE_LIMIT_BACKOFF_MS || 15000);
const RESUME = /^(1|true|yes)$/i.test(process.env.PROJECTHUB_EVAL_RESUME || '');
const STATE_FILE = process.env.PROJECTHUB_EVAL_STATE_FILE || path.join(__dirname, '..', 'data', 'eval-state.json');
const RESULT_FILE = process.env.PROJECTHUB_EVAL_RESULT_FILE || path.join(__dirname, '..', 'data', `eval-${Date.now()}.json`);

const knowledge = loadDefaultKnowledge();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function loadState() {
  if (!RESUME || !fs.existsSync(STATE_FILE)) return { completed: [], nextIndex: 0, startedAt: Date.now() };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { completed: [], nextIndex: 0, startedAt: Date.now() };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function ask(message, sessionId, retries = 0) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId })
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { _unparseable: text }; }

    if (response.status === 429) {
      if (retries < MAX_RETRIES) {
        await sleep(RATE_LIMIT_BACKOFF_MS * (retries + 1));
        return ask(message, sessionId, retries + 1);
      }
      return { status: 429, body: { ok: false, error: 'RATE_LIMIT' }, latencyMs, network: false };
    }
    return { status: response.status, body, latencyMs, network: false };
  } catch (error) {
    return { status: 0, body: { ok: false, error: 'NETWORK', detail: error.message }, latencyMs: Date.now() - startedAt, network: true };
  }
}

async function main() {
  const state = loadState();
  const results = [];
  const summary = { baseUrl: BASE_URL, startedAt: new Date().toISOString(), total: 0, good: 0, byQuality: {}, latencies: [], failedIds: [], details: [] };

  // Map sessions by id to keep conversational state for sessioned cases
  const sessions = {};
  for (const c of cases) {
    if (c.session) sessions[c.session] = sessions[c.session] || `eval-${Date.now()}-${c.session}`;
  }

  for (let i = 0; i < cases.length; i++) {
    if (i < state.nextIndex) {
      // already done
      continue;
    }
    const c = cases[i];
    const sessionId = c.session ? sessions[c.session] : `eval-${Date.now()}-${c.id}`;

    console.error(`[${i + 1}/${cases.length}] ${c.id}: ${c.message}`);
    const result = await ask(c.message, sessionId);
    const reply = String(result.body?.reply || '');
    const score = scoreCase(c, result, { knowledge });

    results.push({ id: c.id, message: c.message, status: result.status, latencyMs: result.latencyMs, provider: result.body?.provider, model: result.body?.model, proseSource: result.body?.proseSource, quality: score.quality, reason: score.reason, reply: reply.slice(0, 400), contract: result.body?.contract || result.body?.agent || null });

    summary.total++;
    summary.byQuality[score.quality] = (summary.byQuality[score.quality] || 0) + 1;
    summary.latencies.push(result.latencyMs);
    if (score.quality === QUALITY.GOOD) summary.good++;
    else summary.failedIds.push(c.id);

    state.completed.push(c.id);
    state.nextIndex = i + 1;
    saveState(state);

    await sleep(CASE_DELAY_MS + Math.floor(Math.random() * 300));
  }

  summary.completedAt = new Date().toISOString();
  summary.passRate = summary.total ? Math.round((summary.good / summary.total) * 1000) / 10 : 0;
  const sorted = [...summary.latencies].sort((a, b) => a - b);
  summary.latencyMs = { p50: sorted[Math.floor(sorted.length * 0.5)] || 0, p95: sorted[Math.floor(sorted.length * 0.95)] || 0, max: sorted[sorted.length - 1] || 0 };
  summary.results = results;

  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify({
    baseUrl: summary.baseUrl,
    total: summary.total,
    good: summary.good,
    passRate: `${summary.passRate}%`,
    byQuality: summary.byQuality,
    latencyMs: summary.latencyMs,
    failedIds: summary.failedIds,
    resultFile: RESULT_FILE,
    historical: 'scripts/eval-local-api.historical.js'
  }, null, 2));

  if (summary.failedIds.length) process.exit(1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { cases, scoreCase };
