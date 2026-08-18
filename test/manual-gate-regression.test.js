'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RAW_PATH = path.join(__dirname, '..', 'data', 'parity-run-68-raw.json');
const AUDIT_PATH = path.join(__dirname, '..', 'data', 'manual-audit-68.json');

function maybeLoad(jsonPath) {
  if (!fs.existsSync(jsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

const raw = maybeLoad(RAW_PATH);
const audit = maybeLoad(AUDIT_PATH);

describe('Manual 68-Answer Gate Regression', () => {
  test('MG1: parity-run-68-raw.json and manual-audit-68.json are present', () => {
    assert.ok(raw, 'data/parity-run-68-raw.json must be present for the manual gate');
    assert.ok(audit, 'data/manual-audit-68.json must be present for the manual gate');
  });

  test('MG2: manual audit total matches raw total', () => {
    assert.equal(audit.total, raw.total, 'manual-audit total must match raw total');
    assert.equal(audit.results.length, raw.results.length, 'manual-audit result count must match raw result count');
  });

  test('MG3: every raw question has a manual label', () => {
    for (const r of audit.results) {
      assert.ok(r.manualLabel, `Result ${r.id} must have a manualLabel`);
      assert.ok(typeof r.reason === 'string', `Result ${r.id} must have a reason string`);
    }
  });

  test('MG4: manual audit confusion matrix adds up', () => {
    const m = audit.summary.confusionMatrix;
    const total = m.autoGoodManualGood + m.autoGoodManualBad + m.autoBadManualGood + m.autoBadManualBad;
    assert.equal(total, audit.total, 'confusion matrix cells must sum to total');
  });

  test('MG5: manual audit metrics are consistent with confusion matrix', () => {
    const { autoGoodManualGood, autoGoodManualBad } = audit.summary.confusionMatrix;
    const totalAutoGood = autoGoodManualGood + autoGoodManualBad;
    const expectedPrecision = totalAutoGood > 0 ? (autoGoodManualGood / totalAutoGood) * 100 : 0;
    assert.ok(
      Math.abs(audit.summary.metrics.precision - expectedPrecision) < 0.01,
      `precision ${audit.summary.metrics.precision} must match confusion matrix`
    );
  });

  test('MG6: manual gate thresholds are not regressed', () => {
    // These thresholds are the current audited baseline. They allow future improvements
    // (lower falseGoodRate / higher manualGoodRate) but fail if quality regresses.
    const metrics = audit.summary.metrics;
    const baseline = {
      falseGoodRate: 13.79,
      manualGoodRate: 58.82
    };
    assert.ok(
      metrics.falseGoodRate <= baseline.falseGoodRate,
      `falseGoodRate ${metrics.falseGoodRate}% must not exceed baseline ${baseline.falseGoodRate}%`
    );
    assert.ok(
      metrics.manualGoodRate >= baseline.manualGoodRate,
      `manualGoodRate ${metrics.manualGoodRate}% must not drop below baseline ${baseline.manualGoodRate}%`
    );
  });

  test('MG7: manual audit labels are in the allowed set', () => {
    const allowed = new Set(['GOOD', 'SAFE_FALLBACK', 'CORRECT_BUT_TERSE', 'CORRECT_BUT_GENERIC', 'FACTUALLY_WRONG', 'PERSONA_CONFUSION', 'WRONG_RELATIONSHIP', 'FOLLOWUP_CONTEXT_ERROR', 'WRONG_ENTITY']);
    for (const r of audit.results) {
      assert.ok(allowed.has(r.manualLabel), `Result ${r.id} has unexpected manualLabel ${r.manualLabel}`);
    }
  });
});
