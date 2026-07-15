// Run: node --test test/cost-ledger.test.js
const test = require('node:test');
const assert = require('node:assert');
const { CostLedger, priceEventMicroUsd, loadRegistry, dayKey, monthKey } = require('../lib/cost-ledger');

const registry = loadRegistry();

function makeLedger(nowFn) {
  return new CostLedger({ registry, stateFile: null, now: nowFn || (() => Date.parse('2026-07-15T12:00:00Z')) });
}

test('micro-USD pricing: LLM tokens round up, never undercount', () => {
  // groq: input 50000 micro-USD per 1M tokens -> 100 tokens = ceil(100*50000/1e6) = ceil(5) = 5
  const micro = priceEventMicroUsd('groq', { tokensIn: 100, tokensOut: 0 }, registry);
  assert.strictEqual(micro, 5);
  // 1 token must cost at least 1 micro-USD (ceil), not 0
  const tiny = priceEventMicroUsd('groq', { tokensIn: 1 }, registry);
  assert.strictEqual(tiny, 1);
});

test('micro-USD pricing: cloudflare neurons', () => {
  // 11000 micro-USD per 1000 neurons -> 12 neurons = ceil(12*11000/1000) = 132
  const micro = priceEventMicroUsd('cloudflare', { neurons: 12 }, registry);
  assert.strictEqual(micro, 132);
});

test('micro-USD pricing: egress applies overhead factor', () => {
  // 1 GB with 1.08 factor at 120000 micro-USD/GB = ceil(1.08 * 120000) = 129600
  const micro = priceEventMicroUsd('gcp-egress', { bytes: 1073741824 }, registry);
  assert.strictEqual(micro, Math.ceil(1.08 * 120000));
});

test('micro-USD pricing: unknown source is zero', () => {
  assert.strictEqual(priceEventMicroUsd('nope', { tokensIn: 1000 }, registry), 0);
});

test('record aggregates across all windows', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'groq', kind: 'llm', tokensIn: 200, tokensOut: 100 });
  ledger.record({ source: 'groq', kind: 'llm', tokensIn: 300, tokensOut: 150 });
  const day = ledger.state.days['2026-07-15'].groq;
  assert.strictEqual(day.calls, 2);
  assert.strictEqual(day.tokensIn, 500);
  assert.strictEqual(day.tokensOut, 250);
  const month = ledger.state.months['2026-07'].groq;
  assert.strictEqual(month.calls, 2);
  assert.strictEqual(ledger.state.allTime.groq.calls, 2);
});

test('UTC day rollover splits windows correctly', () => {
  let t = Date.parse('2026-07-15T23:59:59Z');
  const ledger = makeLedger(() => t);
  ledger.record({ source: 'groq', tokensIn: 10 });
  t = Date.parse('2026-07-16T00:00:01Z');
  ledger.record({ source: 'groq', tokensIn: 10 });
  assert.strictEqual(ledger.state.days['2026-07-15'].groq.calls, 1);
  assert.strictEqual(ledger.state.days['2026-07-16'].groq.calls, 1);
  assert.strictEqual(ledger.state.months['2026-07'].groq.calls, 2);
});

test('month boundary rollover', () => {
  let t = Date.parse('2026-07-31T23:59:59Z');
  const ledger = makeLedger(() => t);
  ledger.record({ source: 'gcp-egress', bytes: 1000 });
  t = Date.parse('2026-08-01T00:00:01Z');
  ledger.record({ source: 'gcp-egress', bytes: 2000 });
  assert.strictEqual(ledger.state.months['2026-07']['gcp-egress'].bytes, 1000);
  assert.strictEqual(ledger.state.months['2026-08']['gcp-egress'].bytes, 2000);
});

test('headroom percentages', () => {
  const ledger = makeLedger();
  // github free limit: 150 requests/day -> 15 calls = 10%
  for (let i = 0; i < 15; i++) ledger.record({ source: 'github', tokensIn: 10, tokensOut: 10 });
  const h = ledger.headroom().find(x => x.source === 'github' && x.metric === 'requestsPerDay');
  assert.strictEqual(h.used, 15);
  assert.strictEqual(h.pct, 10);
});

test('snapshot reports free=true within limits and correct USD string', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'groq', tokensIn: 1000, tokensOut: 500 });
  const snap = ledger.snapshot();
  assert.strictEqual(snap.free, true);
  assert.strictEqual(snap.shadowCost.actualUsd, '0.000000');
  assert.match(snap.shadowCost.monthUsd, /^\d+\.\d{6}$/);
  assert.ok(snap.shadowCost.monthMicroUsd > 0);
});

test('snapshot flips free=false when a quota is exceeded', () => {
  const ledger = makeLedger();
  for (let i = 0; i < 151; i++) ledger.record({ source: 'github', tokensIn: 1 });
  const snap = ledger.snapshot();
  assert.strictEqual(snap.free, false);
  assert.strictEqual(snap.shadowCost.actualUsd, null);
});

test('estimated flag propagates', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'cloudflare', neurons: 12, estimated: true });
  const h = ledger.headroom().find(x => x.source === 'cloudflare' && x.metric === 'neuronsPerDay');
  assert.strictEqual(h.estimated, true);
});

test('recent events ring buffer caps at 100', () => {
  const ledger = makeLedger();
  for (let i = 0; i < 150; i++) ledger.record({ source: 'groq', tokensIn: 1 });
  assert.strictEqual(ledger.state.recentEvents.length, 100);
});

test('window trimming keeps bounded history', () => {
  let t = Date.parse('2026-01-01T00:00:00Z');
  const ledger = makeLedger(() => t);
  for (let d = 0; d < 90; d++) {
    ledger.record({ source: 'groq', tokensIn: 1 });
    t += 24 * 60 * 60 * 1000;
  }
  assert.ok(Object.keys(ledger.state.days).length <= 60);
  assert.ok(Object.keys(ledger.state.hours).length <= 48);
  assert.ok(Object.keys(ledger.state.months).length <= 12);
});
