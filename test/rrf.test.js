'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reciprocalRankFuse, searchBm25WithRrf } = require('../lib/rrf');

test('RRF rewards evidence appearing in multiple ranked views', () => {
  const a = { idx: 1, tag: 'skills', text: 'learning unfamiliar systems' };
  const b = { idx: 2, tag: 'summary', text: 'generic summary' };
  const c = { idx: 3, tag: 'project', text: 'debugging evidence' };
  const fused = reciprocalRankFuse([[b, a], [c, a]], { smoothing: 60, limit: 3 });

  assert.equal(fused[0].idx, 1);
  assert.deepEqual(fused[0].rrfRanks, [2, 2]);
  assert.ok(fused[0].rrfScore > fused[1].rrfScore);
});

test('RRF keeps documents from a single useful view', () => {
  const fused = reciprocalRankFuse([
    [{ idx: 1, tag: 'skills', text: 'JavaScript' }],
    [{ idx: 2, tag: 'experience', text: 'AWS internship' }],
  ], { limit: 2 });

  assert.equal(fused.length, 2);
  assert.deepEqual(new Set(fused.map(item => item.idx)), new Set([1, 2]));
});

test('local BM25 RRF deduplicates identical query variants', () => {
  const calls = [];
  const index = {
    search(query) {
      calls.push(query);
      return [{ idx: query === 'literal' ? 1 : 2, tag: 'fact', text: query }];
    },
  };
  const results = searchBm25WithRrf(index, ['literal', 'literal', 'context'], 2);

  assert.deepEqual(calls, ['literal', 'context']);
  assert.equal(results.length, 2);
});
