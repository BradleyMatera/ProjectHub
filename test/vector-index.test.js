'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VectorIndex } = require('../lib/vector-index');

test('VectorIndex loads from data and computes cosine similarity', () => {
  const mockData = {
    knowledgeHash: 'abc123',
    model: 'test-model',
    dim: 4,
    vectors: [
      { idx: 0, tag: 'identity', text: 'Bradley is a junior engineer', embedding: [1, 0, 0, 0] },
      { idx: 1, tag: 'skills', text: 'JavaScript and React skills', embedding: [0, 1, 0, 0] },
      { idx: 2, tag: 'experience', text: 'AWS Lambda experience', embedding: [0, 0, 1, 0] },
    ],
  };
  const index = new VectorIndex(mockData);
  assert.equal(index.size, 3);

  // Query vector aligned with skills chunk
  const results = index.search([0, 1, 0, 0], 3);
  assert.equal(results[0].tag, 'skills');
  assert.ok(results[0].score > 0.99);
});

test('VectorIndex returns empty for no matches (orthogonal vectors)', () => {
  const mockData = {
    knowledgeHash: 'abc',
    model: 'test',
    dim: 4,
    vectors: [
      { idx: 0, tag: 'a', text: 'test', embedding: [1, 0, 0, 0] },
    ],
  };
  const index = new VectorIndex(mockData);
  // Orthogonal query → cosine sim = 0 → filtered out
  const results = index.search([0, 0, 0, 1], 3);
  assert.equal(results.length, 0);
});

test('VectorIndex handles empty data', () => {
  const index = new VectorIndex({ vectors: [], dim: 4 });
  assert.equal(index.size, 0);
  const results = index.search([1, 0, 0, 0], 3);
  assert.equal(results.length, 0);
});

test('VectorIndex isStale detects hash mismatch', () => {
  const index = new VectorIndex({ knowledgeHash: 'old', vectors: [], dim: 4 });
  assert.ok(index.isStale('new'));
  assert.ok(!index.isStale('old'));
});

test('VectorIndex ranks by similarity', () => {
  const mockData = {
    knowledgeHash: 'test',
    model: 'test',
    dim: 3,
    vectors: [
      { idx: 0, tag: 'a', text: 'a', embedding: [0.9, 0.1, 0] },
      { idx: 1, tag: 'b', text: 'b', embedding: [0.3, 0.7, 0] },
      { idx: 2, tag: 'c', text: 'c', embedding: [0.1, 0.1, 0.8] },
    ],
  };
  const index = new VectorIndex(mockData);
  // Query closer to b
  const results = index.search([0.2, 0.8, 0], 3);
  assert.equal(results[0].tag, 'b');
  assert.equal(results[1].tag, 'a');
});
