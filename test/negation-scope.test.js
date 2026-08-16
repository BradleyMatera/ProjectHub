'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  stripDiscourseMarker,
  splitClauses,
  classifyClauses,
  getNegatedClauses,
  isTokenNegated,
  hasNegation,
} = require('../lib/negation-scope');

// =========================================================
// Synthetic tests with unrelated fixtures — no Bradley, no
// ProjectHub, no benchmark-specific strings.
// =========================================================

// --- stripDiscourseMarker ---

test('stripDiscourseMarker strips leading "No," discourse marker', () => {
  const result = stripDiscourseMarker('No, Maria attended Stanford.');
  assert.equal(result.hadDiscourseMarker, true);
  assert.equal(result.markerType, 'no');
  assert.equal(result.text, 'Maria attended Stanford.');
});

test('stripDiscourseMarker strips leading "Yes," discourse marker', () => {
  const result = stripDiscourseMarker('Yes, Maria attended Stanford.');
  assert.equal(result.hadDiscourseMarker, true);
  assert.equal(result.markerType, 'yes');
  assert.equal(result.text, 'Maria attended Stanford.');
});

test('stripDiscourseMarker returns false when no discourse marker', () => {
  const result = stripDiscourseMarker('Maria attended Stanford.');
  assert.equal(result.hadDiscourseMarker, false);
  assert.equal(result.markerType, null);
  assert.equal(result.text, 'Maria attended Stanford.');
});

// --- classifyClauses ---

test('classifyClauses: "No, Maria attended Stanford." → discourse + positive', () => {
  const clauses = classifyClauses('No, Maria attended Stanford.');
  assert.equal(clauses.length, 2);
  assert.equal(clauses[0].polarity, 'discourse');
  assert.equal(clauses[0].isNegated, false);
  assert.equal(clauses[1].polarity, 'positive');
  assert.equal(clauses[1].isNegated, false);
});

test('classifyClauses: "No, Maria did not attend Stanford." → discourse + negated', () => {
  const clauses = classifyClauses('No, Maria did not attend Stanford.');
  assert.equal(clauses.length, 2);
  assert.equal(clauses[0].polarity, 'discourse');
  assert.equal(clauses[1].polarity, 'negated');
  assert.equal(clauses[1].isNegated, true);
});

test('classifyClauses: "No, Maria did not use React, but she used Vue." → discourse + negated + positive', () => {
  const clauses = classifyClauses('No, Maria did not use React, but she used Vue.');
  assert.equal(clauses.length, 3);
  assert.equal(clauses[0].polarity, 'discourse');
  assert.equal(clauses[1].polarity, 'negated');
  assert.equal(clauses[1].isNegated, true);
  assert.equal(clauses[2].polarity, 'positive');
  assert.equal(clauses[2].isNegated, false);
});

test('classifyClauses: "No evidence shows Maria worked at Acme." → negated', () => {
  const clauses = classifyClauses('No evidence shows Maria worked at Acme.');
  // "No evidence" is a negation phrase, not a discourse marker
  // because it's followed by "evidence" not a comma
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0].polarity, 'negated');
  assert.equal(clauses[0].isNegated, true);
});

test('classifyClauses: "No, Maria worked at Acme." → discourse + positive', () => {
  const clauses = classifyClauses('No, Maria worked at Acme.');
  assert.equal(clauses.length, 2);
  assert.equal(clauses[0].polarity, 'discourse');
  assert.equal(clauses[1].polarity, 'positive');
  assert.equal(clauses[1].isNegated, false);
});

test('classifyClauses: "Maria did not work at Acme; she worked at Nebula Labs." → negated + positive', () => {
  const clauses = classifyClauses('Maria did not work at Acme; she worked at Nebula Labs.');
  assert.equal(clauses.length, 2);
  assert.equal(clauses[0].polarity, 'negated');
  assert.equal(clauses[0].isNegated, true);
  assert.equal(clauses[1].polarity, 'positive');
  assert.equal(clauses[1].isNegated, false);
});

// --- isTokenNegated (the key integration test) ---

test('isTokenNegated: "No, Maria attended Stanford." → Stanford is NOT negated', () => {
  const text = 'No, Maria attended Stanford.';
  assert.equal(isTokenNegated(text, 'Stanford'), false);
});

test('isTokenNegated: "No, Maria did not attend Stanford." → Stanford IS negated', () => {
  const text = 'No, Maria did not attend Stanford.';
  assert.equal(isTokenNegated(text, 'Stanford'), true);
});

test('isTokenNegated: "No, Maria did not use React, but she used Vue." → React negated, Vue NOT negated', () => {
  const text = 'No, Maria did not use React, but she used Vue.';
  assert.equal(isTokenNegated(text, 'React'), true);
  assert.equal(isTokenNegated(text, 'Vue'), false);
});

test('isTokenNegated: "No evidence shows Maria worked at Acme." → Acme IS negated', () => {
  const text = 'No evidence shows Maria worked at Acme.';
  assert.equal(isTokenNegated(text, 'Acme'), true);
});

test('isTokenNegated: "No, Maria worked at Acme." → Acme is NOT negated', () => {
  const text = 'No, Maria worked at Acme.';
  assert.equal(isTokenNegated(text, 'Acme'), false);
});

test('isTokenNegated: "Maria did not work at Acme; she worked at Nebula Labs." → Acme negated, Nebula NOT negated', () => {
  const text = 'Maria did not work at Acme; she worked at Nebula Labs.';
  assert.equal(isTokenNegated(text, 'Acme'), true);
  assert.equal(isTokenNegated(text, 'Nebula'), false);
  assert.equal(isTokenNegated(text, 'Nebula Labs'), false);
});

// --- hasNegation ---

test('hasNegation: "No, Maria attended Stanford." → false (discourse marker stripped)', () => {
  assert.equal(hasNegation('No, Maria attended Stanford.'), false);
});

test('hasNegation: "Maria did not attend Stanford." → true', () => {
  assert.equal(hasNegation('Maria did not attend Stanford.'), true);
});

test('hasNegation: "Maria attended Stanford." → false', () => {
  assert.equal(hasNegation('Maria attended Stanford.'), false);
});

// --- getNegatedClauses ---

test('getNegatedClauses: returns only negated clause texts', () => {
  const text = 'No, Maria did not use React, but she used Vue.';
  const negated = getNegatedClauses(text);
  assert.equal(negated.length, 1);
  assert.ok(negated[0].includes('react'));
  assert.ok(!negated[0].includes('vue'));
});

test('getNegatedClauses: returns empty for all-positive text', () => {
  const text = 'Maria attended Stanford and used React.';
  const negated = getNegatedClauses(text);
  assert.equal(negated.length, 0);
});
