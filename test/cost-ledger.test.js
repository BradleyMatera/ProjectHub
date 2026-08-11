const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CostLedger, priceEventMicroUsd, loadRegistry } = require('../lib/cost-ledger');

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

test('unknown sources cost zero', () => {
  assert.strictEqual(priceEventMicroUsd('unknown', { tokensIn: 1000 }, registry), 0);
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
