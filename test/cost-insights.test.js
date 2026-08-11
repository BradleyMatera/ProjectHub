const test = require('node:test');
const assert = require('node:assert');
const { buildInsights, projectMonthEnd, detectAnomalies, ewma, fmtBytes } = require('../lib/cost-insights');

test('ewma follows recent values', () => {
  assert.ok(Math.abs(ewma([10, 10, 10, 10]) - 10) < 0.001);
  assert.ok(ewma([0, 0, 0, 100]) > 20);
});

test('month projection roughly doubles mid-month linear usage', () => {
  const projected = projectMonthEnd(500, [], Date.parse('2026-07-16T00:00:00Z'));
  assert.ok(projected > 950 && projected < 1100);
});

test('anomaly detector flags an Ollama request spike', () => {
  const hours = {};
  for (let hour = 0; hour < 24; hour++) {
    hours[`2026-07-15T${String(hour).padStart(2, '0')}`] = { ollama: { calls: 2 } };
  }
  hours['2026-07-16T00'] = { ollama: { calls: 20 } };
  const anomalies = detectAnomalies(hours);
  assert.strictEqual(anomalies.length, 1);
  assert.strictEqual(anomalies[0].source, 'ollama');
});

test('free snapshot reports zero actual cost', () => {
  const insights = buildInsights({
    generatedAt: Date.parse('2026-07-15T12:00:00Z'),
    free: true,
    shadowCost: { monthUsd: '0.001234', monthMicroUsd: 1234 },
    headroom: [],
    days: {},
    hours: {}
  });
  const headline = insights.find(insight => insight.tag === 'free-status');
  assert.ok(headline.text.includes('$0.000000'));
  assert.strictEqual(headline.severity, 0);
});

test('exceeded hosting allowance produces an alert', () => {
  const insights = buildInsights({
    generatedAt: Date.parse('2026-07-15T12:00:00Z'),
    free: false,
    shadowCost: { monthUsd: '0.100000' },
    headroom: [{ source: 'gcp-egress', metric: 'egressBytesPerMonth', used: 1200, limit: 1000, pct: 120 }],
    days: {},
    hours: {}
  });
  assert.ok(insights.some(insight => insight.severity === 2 && /EXCEEDED/.test(insight.text)));
});

test('byte formatting is stable', () => {
  assert.strictEqual(fmtBytes(512), '512 B');
  assert.strictEqual(fmtBytes(2048), '2.0 KB');
  assert.strictEqual(fmtBytes(1073741824), '1.00 GB');
});
