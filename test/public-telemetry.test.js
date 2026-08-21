'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scrubPublicPhoneNumbers,
  estimateCloudflareNeurons,
  summarizeGenerationCalls
} = require('../logic');

test('public phone scrub preserves only the approved public number', () => {
  assert.equal(
    scrubPublicPhoneNumbers('Call (608) 313-5373.'),
    'Call (608) 313-5373.'
  );
  assert.equal(
    scrubPublicPhoneNumbers('Call (555) 222-1212.'),
    'Call [phone withheld].'
  );
  assert.equal(
    scrubPublicPhoneNumbers('Approved: 608-313-5373; private: 555.222.1212'),
    'Approved: (608) 313-5373; private: [phone withheld]'
  );
});

test('Cloudflare neuron estimate uses the configured Llama 3.1 8B Instruct Fast rates', () => {
  assert.equal(estimateCloudflareNeurons(1_000_000, 0), 4119);
  assert.equal(estimateCloudflareNeurons(0, 1_000_000), 34868);
  assert.equal(estimateCloudflareNeurons(1_000_000, 1_000_000), 38987);
});

test('generation-call summary reports real call count and token/neuron totals', () => {
  const summary = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: {
      actualProviderCalls: 2,
      generationCalls: [
        {
          attemptIndex: 1,
          attemptType: 'PRIMARY',
          inputTokens: 600,
          outputTokens: 60,
          actualNeurons: 4,
          estimatedNeurons: 4.6,
          latencyMs: 500
        },
        {
          attemptIndex: 2,
          attemptType: 'FACTUAL_REPAIR',
          inputTokens: 650,
          outputTokens: 50,
          actualNeurons: 5,
          estimatedNeurons: 5.2,
          latencyMs: 450
        }
      ]
    }
  });

  assert.equal(summary.calls, 2);
  assert.equal(summary.inputTokens, 1250);
  assert.equal(summary.outputTokens, 110);
  assert.equal(summary.actualNeurons, 9);
  assert.equal(summary.estimatedNeurons, 9.8);
  assert.equal(summary.latencyMs, 950);
  assert.equal(summary.repairs, 1);
  assert.equal(summary.provider, 'cloudflare');
  assert.equal(summary.model, '@cf/meta/llama-3.1-8b-instruct-fast');
});
