'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groqModelPolicy } = require('../lib/model-policy');

test('blocks the August 16 Llama models even when an old environment names them', () => {
  for (const model of ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']) {
    assert.deepEqual(groqModelPolicy(model), {
      allowed: false,
      model,
      reason: 'retired-model',
      shutdownDate: '2026-08-16'
    });
  }
});

test('requires an explicit Groq model instead of silently selecting a replacement', () => {
  assert.deepEqual(groqModelPolicy(''), {
    allowed: false,
    model: '',
    reason: 'model-not-configured',
    shutdownDate: null
  });
});

test('allows an explicitly configured non-retired model', () => {
  assert.deepEqual(groqModelPolicy('qwen/qwen3.6-27b'), {
    allowed: true,
    model: 'qwen/qwen3.6-27b',
    reason: null,
    shutdownDate: null
  });
});
