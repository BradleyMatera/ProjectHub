// Run: node --test test/cost-insights.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buildInsights, projectMonthEnd, detectAnomalies, ewma, fmtBytes } = require('../lib/cost-insights');

test('ewma converges toward recent values', () => {
  const flat = ewma([10, 10, 10, 10]);
  assert.ok(Math.abs(flat - 10) < 0.001);
  const rising = ewma([0, 0, 0, 100]);
  assert.ok(rising > 20 && rising < 100);
});

test('projectMonthEnd: linear burn at mid-month roughly doubles usage', () => {
  const midMonth = Date.parse('2026-07-16T00:00:00Z'); // ~halfway through July
  const projected = projectMonthEnd(500, [], midMonth);
  assert.ok(projected > 950 && projected < 1100, `expected ~1000, got ${projected}`);
});

test('projectMonthEnd blends EWMA when enough daily history exists', () => {
  const midMonth = Date.parse('2026-07-16T00:00:00Z');
  // usage front-loaded: linear says high, recent days say zero -> blended lands between
  const linearOnly = projectMonthEnd(500, [], midMonth);
  const blended = projectMonthEnd(500, [0, 0, 0, 0, 0], midMonth);
  assert.ok(blended < linearOnly);
  assert.ok(blended > 500);
});

test('detectAnomalies flags 3x hourly baseline', () => {
  const hours = {};
  // 24 quiet hours at ~2 calls, then a spike of 20
  for (let i = 0; i < 24; i++) {
    hours[`2026-07-15T${String(i).padStart(2, '0')}`] = { groq: { calls: 2 } };
  }
  hours['2026-07-16T00'] = { groq: { calls: 20 } };
  const anomalies = detectAnomalies(hours);
  assert.strictEqual(anomalies.length, 1);
  assert.strictEqual(anomalies[0].source, 'groq');
  assert.ok(anomalies[0].factor >= 3);
});

test('detectAnomalies quiet traffic produces no flags', () => {
  const hours = {};
  for (let i = 0; i < 24; i++) {
    hours[`2026-07-15T${String(i).padStart(2, '0')}`] = { groq: { calls: 2 } };
  }
  hours['2026-07-16T00'] = { groq: { calls: 3 } };
  assert.strictEqual(detectAnomalies(hours).length, 0);
});

test('buildInsights: free snapshot leads with $0 proof and ok severity', () => {
  const snapshot = {
    generatedAt: Date.parse('2026-07-15T12:00:00Z'),
    free: true,
    shadowCost: { monthUsd: '0.001234', monthMicroUsd: 1234 },
    headroom: [{ source: 'github', metric: 'requestsPerDay', used: 10, limit: 150, pct: 7 }],
    days: {}, hours: {}
  };
  const insights = buildInsights(snapshot);
  const headline = insights.find(i => i.tag === 'free-status');
  assert.ok(headline.text.includes('$0.000000'));
  assert.strictEqual(headline.severity, 0);
});

test('buildInsights: exceeded quota produces alert severity', () => {
  const snapshot = {
    generatedAt: Date.parse('2026-07-15T12:00:00Z'),
    free: false,
    shadowCost: { monthUsd: '0.100000' },
    headroom: [{ source: 'cloudflare', metric: 'neuronsPerDay', used: 11000, limit: 10000, pct: 110 }],
    days: {}, hours: {}
  };
  const insights = buildInsights(snapshot);
  assert.ok(insights.some(i => i.severity === 2 && /EXCEEDED/.test(i.text)));
  // Alerts sort first
  assert.strictEqual(insights[0].severity, 2);
});

test('buildInsights: daily quota above 50% gets exhaustion pace watch', () => {
  const snapshot = {
    generatedAt: Date.parse('2026-07-15T12:00:00Z'),
    free: true,
    shadowCost: { monthUsd: '0.000100' },
    headroom: [{ source: 'cloudflare', metric: 'neuronsPerDay', used: 6100, limit: 10000, pct: 61 }],
    days: {}, hours: {}
  };
  const insights = buildInsights(snapshot);
  const watch = insights.find(i => i.tag === 'cloudflare');
  assert.ok(watch, 'expected a cloudflare insight');
  assert.ok(/WATCH/.test(watch.text));
  assert.ok(/exhaustion/.test(watch.text));
});

test('fmtBytes precision', () => {
  assert.strictEqual(fmtBytes(512), '512 B');
  assert.strictEqual(fmtBytes(2048), '2.0 KB');
  assert.strictEqual(fmtBytes(1073741824), '1.00 GB');
});
