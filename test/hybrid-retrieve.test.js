'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  reciprocalRankFusion,
  maximalMarginalRelevance,
  hybridRetrieve,
  textSimilarity,
  applyTagBoosts,
} = require('../lib/hybrid-retrieve');

test('RRF fuses two rankings', () => {
  const bm25 = [
    { idx: 0, tag: 'identity', text: 'A', score: 5 },
    { idx: 1, tag: 'skills', text: 'B', score: 3 },
    { idx: 2, tag: 'experience', text: 'C', score: 1 },
  ];
  const dense = [
    { idx: 1, tag: 'skills', text: 'B', score: 0.9 },
    { idx: 2, tag: 'experience', text: 'C', score: 0.8 },
    { idx: 0, tag: 'identity', text: 'A', score: 0.7 },
  ];
  const fused = reciprocalRankFusion([bm25, dense]);
  // idx 1 appears at rank 1 in both → highest RRF score
  assert.equal(fused[0].idx, 1);
  assert.ok(fused[0].score > fused[1].score);
});

test('RRF with single ranking preserves order', () => {
  const ranking = [
    { idx: 0, text: 'A', score: 5 },
    { idx: 1, text: 'B', score: 3 },
  ];
  const fused = reciprocalRankFusion([ranking]);
  assert.equal(fused[0].idx, 0);
  assert.equal(fused[1].idx, 1);
});

test('textSimilarity computes word overlap', () => {
  assert.ok(textSimilarity('JavaScript React Node', 'JavaScript React TypeScript') > 0.5);
  assert.equal(textSimilarity('completely different words', 'other random stuff'), 0);
});

test('MMR selects diverse results', () => {
  const candidates = [
    { idx: 0, text: 'Bradley knows JavaScript and React', score: 10 },
    { idx: 1, text: 'Bradley knows JavaScript and React', score: 9 }, // duplicate
    { idx: 2, text: 'AWS Lambda and DynamoDB experience', score: 8 },
    { idx: 3, text: 'Army veteran combat medic', score: 7 },
  ];
  const selected = maximalMarginalRelevance(candidates, 3);
  assert.equal(selected.length, 3);
  // First pick is always the top
  assert.equal(selected[0].idx, 0);
  // Should not pick the near-duplicate (idx 1) over diverse options
  assert.ok(!selected.every(s => s.idx === 0 || s.idx === 1));
});

test('applyTagBoosts boosts relevant tags for intent', () => {
  const chunks = [
    { tag: 'faq', text: 'A', score: 1.0 },
    { tag: 'identity', text: 'B', score: 1.0 },
  ];
  const boosted = applyTagBoosts(chunks, 'role-fit');
  assert.ok(boosted[0].score > boosted[1].score); // faq boosted for role-fit
});

test('hybridRetrieve combines BM25 + dense with RRF + MMR', () => {
  const bm25 = [
    { idx: 0, tag: 'identity', text: 'Bradley is a junior engineer', score: 5 },
    { idx: 1, tag: 'skills', text: 'JavaScript React TypeScript', score: 3 },
    { idx: 2, tag: 'experience', text: 'AWS Lambda DynamoDB', score: 2 },
  ];
  const dense = [
    { idx: 1, tag: 'skills', text: 'JavaScript React TypeScript', score: 0.9 },
    { idx: 2, tag: 'experience', text: 'AWS Lambda DynamoDB', score: 0.8 },
  ];
  const results = hybridRetrieve({ bm25Results: bm25, denseResults: dense, intent: 'factual-lookup', k: 3 });
  assert.ok(results.length <= 3);
  assert.ok(results.length > 0);
});

test('hybridRetrieve handles empty inputs', () => {
  assert.equal(hybridRetrieve({}).length, 0);
  assert.equal(hybridRetrieve({ bm25Results: [], denseResults: [] }).length, 0);
});

test('hybridRetrieve works with BM25 only', () => {
  const bm25 = [
    { idx: 0, tag: 'identity', text: 'A', score: 5 },
    { idx: 1, tag: 'skills', text: 'B', score: 3 },
  ];
  const results = hybridRetrieve({ bm25Results: bm25, denseResults: null, k: 2 });
  assert.equal(results.length, 2);
});
