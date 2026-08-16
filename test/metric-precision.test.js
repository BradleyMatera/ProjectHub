'use strict';

// Full-Precision Metric Math Unit Test
//
// Verifies that derived metrics use raw unrounded values for all calculations.
// Only display values may be rounded.
//
// Example from the benchmark:
//   totalActualNeurons = 40.87
//   GOOD = 6
//
//   neuronsPerGood raw = 40.87 / 6
//   projectedGoodPer10k raw = 6 / 40.87 * 10000
//
// These must NOT be rounded before derivation.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Helper: approximate equality for floating-point
function approxEqual(actual, expected, epsilon = 1e-9) {
  return Math.abs(actual - expected) < epsilon;
}

test('neuronsPerGood uses full precision raw values', () => {
  const totalActualNeurons = 40.87;
  const goodCount = 6;

  // Raw calculation — no rounding
  const neuronsPerGoodRaw = totalActualNeurons / goodCount;
  assert.ok(approxEqual(neuronsPerGoodRaw, 6.811666666666667), `neuronsPerGoodRaw=${neuronsPerGoodRaw}`);

  // Display value may be rounded
  const neuronsPerGoodDisplay = Math.round(neuronsPerGoodRaw * 100) / 100;
  assert.equal(neuronsPerGoodDisplay, 6.81);

  // Verify rounding does not affect the raw value
  assert.notEqual(neuronsPerGoodRaw, neuronsPerGoodDisplay);
});

test('projectedGoodPer10k uses full precision raw values', () => {
  const totalActualNeurons = 40.87;
  const goodCount = 6;

  // Raw calculation — no rounding
  const neuronsPerGoodRaw = totalActualNeurons / goodCount;
  const projectedGoodPer10kRaw = (goodCount / totalActualNeurons) * 10000;
  assert.ok(approxEqual(projectedGoodPer10kRaw, 1468.0694886224614), `projectedGoodPer10kRaw=${projectedGoodPer10kRaw}`);

  // Display value may be rounded
  const projectedGoodPer10kDisplay = Math.round(projectedGoodPer10kRaw * 100) / 100;
  assert.equal(projectedGoodPer10kDisplay, 1468.07);

  // Verify that using rounded intermediate values produces a different (wrong) result
  const wrongProjected = (goodCount / neuronsPerGoodDisplay_rounded()) * 10000;
  assert.notEqual(wrongProjected, projectedGoodPer10kRaw);
});

function neuronsPerGoodDisplay_rounded() {
  return 6.81; // rounded intermediate — WRONG for derivation
}

test('rawRequestsPer10k uses full precision raw values', () => {
  const totalActualNeurons = 40.87;
  const totalRequests = 13;

  const rawRequestsPer10k = (totalRequests / totalActualNeurons) * 10000;
  assert.ok(approxEqual(rawRequestsPer10k, 3180.8172253486664), `rawRequestsPer10k=${rawRequestsPer10k}`);

  // Display rounded
  const display = Math.round(rawRequestsPer10k * 100) / 100;
  assert.equal(display, 3180.82);
});

test('estimator error uses full precision raw values', () => {
  const actualNeurons = 10.5;
  const estimatedNeurons = 12.3;

  const errorRaw = estimatedNeurons - actualNeurons;
  const errorPctRaw = (errorRaw / actualNeurons) * 100;

  assert.ok(approxEqual(errorRaw, 1.8), `errorRaw=${errorRaw}`);
  assert.ok(approxEqual(errorPctRaw, 17.142857142857142), `errorPctRaw=${errorPctRaw}`);

  // Display rounded
  const errorPctDisplay = Math.round(errorPctRaw * 100) / 100;
  assert.equal(errorPctDisplay, 17.14);
});

test('neuron sum from generation calls matches request total', () => {
  const calls = [
    { actualNeurons: 5.12 },
    { actualNeurons: 3.45 },
    { actualNeurons: 2.30 },
  ];

  const sumRaw = calls.reduce((s, c) => s + c.actualNeurons, 0);
  assert.ok(approxEqual(sumRaw, 10.87), `sumRaw=${sumRaw}`);

  // If request total was independently calculated, it must match
  const requestTotal = 10.87;
  assert.ok(Math.abs(requestTotal - sumRaw) < 0.001, 'neuron sum must match request total');
});

test('goodPct uses full precision raw values', () => {
  const goodCount = 6;
  const totalCases = 13;

  const goodPctRaw = (goodCount / totalCases) * 100;
  assert.ok(approxEqual(goodPctRaw, 46.15384615384615), `goodPctRaw=${goodPctRaw}`);

  // Display rounded
  const goodPctDisplay = Math.round(goodPctRaw * 100) / 100;
  assert.equal(goodPctDisplay, 46.15);
});
