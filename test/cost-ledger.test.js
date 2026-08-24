const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CostLedger, priceEventMicroUsd, loadRegistry } = require('../lib/cost-ledger');
const { buildInsights } = require('../lib/cost-insights');

const registry = loadRegistry();
const makeLedger = now => new CostLedger({
  registry,
  stateFile: null,
  now: now || (() => Date.parse('2026-07-15T12:00:00Z'))
});

test('local Ollama tokens have zero shadow model cost', () => {
  assert.strictEqual(priceEventMicroUsd('ollama', { tokensIn: 500, tokensOut: 200 }, registry), 0);
});

test('egress pricing includes the safety overhead factor', () => {
  const micro = priceEventMicroUsd('gcp-egress', { bytes: 1073741824 }, registry);
  assert.strictEqual(micro, Math.ceil(1.08 * 120000));
});

test('unknown sources are unpriced', () => {
  assert.strictEqual(priceEventMicroUsd('unknown', { tokensIn: 1000 }, registry), null);
});

test('known priced source produces a numeric shadow cost', () => {
  const micro = priceEventMicroUsd('gcp-egress', { bytes: 1073741824 }, registry);
  assert.strictEqual(micro, Math.ceil(1.08 * 120000));
});

test('known zero-cost source is legitimately 0 when explicitly configured', () => {
  assert.strictEqual(priceEventMicroUsd('ollama', { tokensIn: 1000, tokensOut: 500 }, registry), 0);
  assert.strictEqual(priceEventMicroUsd('agent-local-tools', { tokensIn: 1000 }, registry), 0);
});

test('unpriced source is marked unknown instead of $0', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'cloudflare', kind: 'llm', tokensIn: 1000, tokensOut: 200 });
  const snapshot = ledger.snapshot();
  assert.strictEqual(snapshot.shadowCost.monthComplete, false);
  assert.deepStrictEqual(snapshot.shadowCost.unpricedSources, ['cloudflare']);
  assert.strictEqual(snapshot.bySourceMonth.cloudflare.unpriced, true);
  assert.deepStrictEqual(snapshot.bySourceMonth.cloudflare.unpricedSources, ['cloudflare']);
  // Shadow value is unknown, not $0; the numeric bucket stays 0 for known costs.
  assert.strictEqual(snapshot.bySourceMonth.cloudflare.shadowMicroUsd, 0);
});

test('mixed known and unpriced sources preserve known subtotal and mark total incomplete', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'gcp-egress', kind: 'egress', bytes: 1073741824 });
  ledger.record({ source: 'cloudflare', kind: 'llm', tokensIn: 1000, tokensOut: 200 });
  const snapshot = ledger.snapshot();
  assert.strictEqual(snapshot.shadowCost.monthMicroUsd, Math.ceil(1.08 * 120000));
  assert.strictEqual(snapshot.shadowCost.monthComplete, false);
  assert.deepStrictEqual(snapshot.shadowCost.unpricedSources, ['cloudflare']);
});

test('records aggregate local inference across windows', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'ollama', kind: 'llm', tokensIn: 200, tokensOut: 100 });
  ledger.record({ source: 'ollama', kind: 'llm', tokensIn: 300, tokensOut: 150 });
  assert.strictEqual(ledger.state.days['2026-07-15'].ollama.calls, 2);
  assert.strictEqual(ledger.state.days['2026-07-15'].ollama.tokensIn, 500);
  assert.strictEqual(ledger.state.months['2026-07'].ollama.tokensOut, 250);
});

test('UTC day rollover splits windows correctly', () => {
  let now = Date.parse('2026-07-15T23:59:59Z');
  const ledger = makeLedger(() => now);
  ledger.record({ source: 'ollama', tokensIn: 10 });
  now = Date.parse('2026-07-16T00:00:01Z');
  ledger.record({ source: 'ollama', tokensIn: 10 });
  assert.strictEqual(ledger.state.days['2026-07-15'].ollama.calls, 1);
  assert.strictEqual(ledger.state.days['2026-07-16'].ollama.calls, 1);
});

test('snapshot stays free within hosting limits', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'ollama', tokensIn: 120, tokensOut: 40 });
  const snapshot = ledger.snapshot();
  assert.strictEqual(snapshot.free, true);
  assert.strictEqual(snapshot.shadowCost.actualUsd, '0.000000');
});

test('snapshot detects exceeded network allowance', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'gcp-egress', bytes: 1073741825 });
  const snapshot = ledger.snapshot();
  assert.strictEqual(snapshot.free, false);
  assert.strictEqual(snapshot.shadowCost.actualUsd, null);
});

test('recent event buffer and historical windows stay bounded', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const ledger = makeLedger(() => now);
  for (let day = 0; day < 150; day++) {
    ledger.record({ source: 'ollama', tokensIn: 1 });
    now += 24 * 60 * 60 * 1000;
  }
  assert.strictEqual(ledger.state.recentEvents.length, 100);
  assert.ok(Object.keys(ledger.state.days).length <= 60);
  assert.ok(Object.keys(ledger.state.hours).length <= 48);
  assert.ok(Object.keys(ledger.state.months).length <= 12);
});

test('loading persisted state drops sources not present in the local registry', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'projecthub-ledger-'));
  const stateFile = path.join(directory, 'costs.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    allTime: { ollama: { calls: 1 }, legacyHostedModel: { calls: 4 } },
    hours: {}, days: {}, months: {},
    recentEvents: [{ source: 'ollama' }, { source: 'legacyHostedModel' }]
  }));
  const ledger = new CostLedger({ registry, stateFile, now: () => Date.parse('2026-07-15T12:00:00Z') });
  assert.ok(ledger.state.allTime.ollama);
  assert.equal(ledger.state.allTime.legacyHostedModel, undefined);
  assert.deepEqual(ledger.state.recentEvents.map(event => event.source), ['ollama']);
  fs.rmSync(directory, { recursive: true, force: true });
});

// ---- Free-tier completeness regression tests ----

test('A: Cloudflare usage with unverified neuron pricing makes free-tier status unknown', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'cloudflare', kind: 'llm', tokensIn: 1000, tokensOut: 200 });
  const snapshot = ledger.snapshot();
  assert.strictEqual(snapshot.free, null);
  assert.strictEqual(snapshot.freeStatusComplete, false);
  assert.strictEqual(snapshot.shadowCost.actualUsd, null);
  const cf = snapshot.headroom.find(h => h.source === 'cloudflare' && h.metric === 'neuronsPerDay');
  assert.ok(cf, 'expected Cloudflare neuronsPerDay headroom');
  assert.strictEqual(cf.used, null);
  assert.strictEqual(cf.limit, 10000);
  assert.strictEqual(cf.pct, null);
  assert.strictEqual(cf.complete, false);
});

test('B: known measurable limits within bounds keep free status verified and true', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'ollama', tokensIn: 120, tokensOut: 40 });
  const snapshot = ledger.snapshot();
  assert.strictEqual(snapshot.free, true);
  assert.strictEqual(snapshot.freeStatusComplete, true);
  assert.strictEqual(snapshot.shadowCost.actualUsd, '0.000000');
});

test('C: exceeded known limit keeps free status false', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'gcp-egress', kind: 'egress', bytes: 1073741825 });
  const snapshot = ledger.snapshot();
  assert.strictEqual(snapshot.free, false);
  assert.strictEqual(snapshot.freeStatusComplete, true);
  assert.strictEqual(snapshot.shadowCost.actualUsd, null);
});

test('D: mixed known-within-limits and unmeasurable Cloudflare leaves free status unknown', () => {
  const ledger = makeLedger();
  // 989,000,000 bytes * 1.08 overhead rounds to 99% and stays under the 1 GiB free limit
  ledger.record({ source: 'gcp-egress', kind: 'egress', bytes: 989000000 });
  ledger.record({ source: 'cloudflare', kind: 'llm', tokensIn: 1000 });
  const snapshot = ledger.snapshot();
  assert.strictEqual(snapshot.free, null);
  assert.strictEqual(snapshot.freeStatusComplete, false);
  assert.strictEqual(snapshot.shadowCost.monthComplete, false);
  assert.ok(snapshot.headroom.some(h => h.source === 'cloudflare' && h.metric === 'neuronsPerDay' && h.complete === false));
  assert.strictEqual(snapshot.shadowCost.actualUsd, null);
});

test('E: cost-insights does not claim "All usage inside free tiers" when completeness is unknown', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'cloudflare', kind: 'llm', tokensIn: 1000 });
  const insights = buildInsights(ledger.snapshot());
  const status = insights.find(i => i.tag === 'free-status');
  assert.ok(status, 'expected a free-status insight');
  assert.ok(!status.text.includes('All usage inside free tiers'), 'should not claim all usage inside free tiers');
  assert.ok(status.text.includes('unverified'), 'should mention unverified status');
});

test('F: actualUsd is unknown when free-tier status is unknown', () => {
  const ledger = makeLedger();
  ledger.record({ source: 'cloudflare', kind: 'llm', tokensIn: 1000 });
  const snapshot = ledger.snapshot();
  assert.strictEqual(snapshot.free, null);
  assert.strictEqual(snapshot.shadowCost.actualUsd, null);
});
