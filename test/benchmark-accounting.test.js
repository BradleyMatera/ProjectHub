'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Immutable artifact; if missing (e.g. fresh checkout), the accounting suite
// cannot run and should not fail the local test run.
const RESULTS_FILE = path.join(__dirname, '..', 'benchmark', 'results', 'cf-qualification-2026-08-15T04-01-05-506Z.json');

if (!fs.existsSync(RESULTS_FILE)) {
  test('A0: benchmark artifact missing, skipping accounting assertions', () => {
    console.log(`[benchmark-accounting] Skipped: ${RESULTS_FILE} not found.`);
  });
  return;
}

const raw = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
const cases = raw.results[0].results;

// =========================================================
// Accounting Assertion Tests
// =========================================================

// 1. Sum of case-level neurons must equal reported total
test('A1: sum(case.totalActualNeurons) === reported totalActualNeurons', () => {
  const caseSum = cases.reduce((acc, cr) => {
    return acc + (cr.neuronSummary?.totalActualNeurons || 0);
  }, 0);
  const reportedTotal = raw.results[0].capacity?.raw?.totalActualNeurons || 0;
  assert.ok(Math.abs(caseSum - reportedTotal) < 0.001,
    `Case sum ${caseSum.toFixed(6)} must equal reported total ${reportedTotal.toFixed(6)} within FP tolerance`);
});

// 2. Sum of attempt-type neurons must equal total
test('A2: sum(attempt-type neurons) === total neurons', () => {
  const byType = {};
  for (const cr of cases) {
    if (!cr.generationCalls) continue;
    for (const gc of cr.generationCalls) {
      const t = gc.attemptType || 'UNKNOWN';
      if (!byType[t]) byType[t] = { calls: 0, neurons: 0 };
      byType[t].calls++;
      byType[t].neurons += gc.actualNeurons || 0;
    }
  }
  const attemptSum = Object.values(byType).reduce((a, v) => a + v.neurons, 0);
  const caseSum = cases.reduce((acc, cr) => acc + (cr.neuronSummary?.totalActualNeurons || 0), 0);
  assert.ok(Math.abs(attemptSum - caseSum) < 0.001,
    `Attempt-type sum ${attemptSum.toFixed(6)} must equal case sum ${caseSum.toFixed(6)}`);
});

// 3. Sum of attempt-type calls must equal total calls
test('A3: sum(attempt-type calls) === 45', () => {
  let totalCalls = 0;
  for (const cr of cases) {
    if (!cr.generationCalls) continue;
    totalCalls += cr.generationCalls.length;
  }
  assert.equal(totalCalls, 45, 'Total generation calls must equal 45');
});

// 4. False-GOOD case neuron sum (Cases 3, 4, 9, 10)
test('A4: false-GOOD cases (3,4,9,10) total 23.086729 neurons', () => {
  const falseGoodIds = [3, 4, 9, 10];
  const falseGoodNeurons = cases
    .filter(cr => falseGoodIds.includes(cr.caseId))
    .reduce((acc, cr) => acc + (cr.neuronSummary?.totalActualNeurons || 0), 0);
  // 2.694232 + 5.808589 + 8.825595 + 5.758313 = 23.086729
  assert.ok(Math.abs(falseGoodNeurons - 23.086729) < 0.001,
    `False-GOOD neuron total ${falseGoodNeurons.toFixed(6)} must equal 23.086729`);
});

// 5. Audited neurons/GOOD from raw values
test('A5: audited neurons/GOOD = 46.207788 (92.415576 / 2)', () => {
  const totalNeurons = cases.reduce((acc, cr) => acc + (cr.neuronSummary?.totalActualNeurons || 0), 0);
  const strictGood = 2; // Cases 1 and 2 only
  const npg = totalNeurons / strictGood;
  assert.ok(Math.abs(npg - 46.207788) < 0.001,
    `Neurons/GOOD ${npg.toFixed(6)} must equal 46.207788`);
});
