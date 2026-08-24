'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scrubPublicPhoneNumbers,
  estimateCloudflareNeurons,
  summarizeGenerationCalls,
  recordScoutUsage,
  getScoutUsageState
} = require('../logic');

global.window = {};

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

test('Cloudflare neuron estimate uses exact-model pricing; -fast has no published rate', () => {
  assert.equal(estimateCloudflareNeurons('@cf/meta/llama-3.1-8b-instruct-fp8-fast', 1_000_000, 0), 4119);
  assert.equal(estimateCloudflareNeurons('@cf/meta/llama-3.1-8b-instruct-fp8-fast', 0, 1_000_000), 34868);
  assert.equal(estimateCloudflareNeurons('@cf/meta/llama-3.1-8b-instruct-fp8-fast', 1_000_000, 1_000_000), 38987);
  assert.equal(estimateCloudflareNeurons('@cf/meta/llama-3.1-8b-instruct-fast', 1_000_000, 0), null);
  assert.equal(estimateCloudflareNeurons('@cf/meta/llama-3.1-8b-instruct-fast', 0, 1_000_000), null);
  assert.equal(estimateCloudflareNeurons('@cf/meta/llama-3.1-8b-instruct-fast', 1_000_000, 1_000_000), null);
});

test('-fast model with tokens but no actual/estimated neurons reports unknown', () => {
  const summary = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: {
      generationCalls: [
        { inputTokens: 1000, outputTokens: 200 }
      ]
    }
  });

  assert.equal(summary.calls, 1);
  assert.strictEqual(summary.actualNeurons, null);
  assert.strictEqual(summary.estimatedNeurons, null);
  assert.strictEqual(summary.neurons, null);
});

test('-fast model with actual provider neurons preserves actual value', () => {
  const summary = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: {
      generationCalls: [
        { inputTokens: 1000, outputTokens: 200, actualNeurons: 4 }
      ]
    }
  });

  assert.strictEqual(summary.actualNeurons, 4);
  assert.strictEqual(summary.estimatedNeurons, null);
  assert.strictEqual(summary.neurons, 4);
});

test('-fp8-fast model with no actual neurons falls back to a model estimate', () => {
  const summary = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    agent: {
      generationCalls: [
        { inputTokens: 1_000_000, outputTokens: 0, estimatedNeurons: 4119 }
      ]
    }
  });

  assert.strictEqual(summary.actualNeurons, null);
  assert.strictEqual(summary.estimatedNeurons, 4119);
  assert.strictEqual(summary.neurons, 4119);
});

test('multiple calls all actual-known sum correctly', () => {
  const summary = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: {
      generationCalls: [
        { inputTokens: 100, outputTokens: 50, actualNeurons: 4 },
        { inputTokens: 200, outputTokens: 100, actualNeurons: 5 }
      ]
    }
  });

  assert.strictEqual(summary.actualNeurons, 9);
  assert.strictEqual(summary.neurons, 9);
});

test('multiple calls with one unknown keep total unknown, not a partial sum', () => {
  const summary = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: {
      generationCalls: [
        { inputTokens: 100, outputTokens: 50, actualNeurons: 4 },
        { inputTokens: 200, outputTokens: 100 }
      ]
    }
  });

  assert.strictEqual(summary.actualNeurons, null);
  assert.strictEqual(summary.estimatedNeurons, null);
  assert.strictEqual(summary.neurons, null);
});

test('session state stays unknown after an unknown-neuron request', () => {
  window.__PROJECTHUB_USAGE__ = undefined;
  const request = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: {
      generationCalls: [
        { inputTokens: 100, outputTokens: 50 }
      ]
    }
  });
  const session = recordScoutUsage({ model: '@cf/meta/llama-3.1-8b-instruct-fast' }, request);

  assert.strictEqual(session.neurons, null);
  assert.strictEqual(session.neuronsComplete, false);
});

test('A: unknown then known keeps session total unknown', () => {
  window.__PROJECTHUB_USAGE__ = undefined;
  const unknown = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: { generationCalls: [{ inputTokens: 100, outputTokens: 50 }] }
  });
  const known = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: { generationCalls: [{ inputTokens: 100, outputTokens: 50, actualNeurons: 4 }] }
  });

  recordScoutUsage({ model: '@cf/meta/llama-3.1-8b-instruct-fast' }, unknown);
  const session = recordScoutUsage({ model: '@cf/meta/llama-3.1-8b-instruct-fast' }, known);

  assert.strictEqual(session.neurons, null);
  assert.strictEqual(session.neuronsComplete, false);
  assert.strictEqual(session.providerCalls, 2);
});

test('B: known then unknown then known keeps session total unknown', () => {
  window.__PROJECTHUB_USAGE__ = undefined;
  const known4 = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: { generationCalls: [{ inputTokens: 100, outputTokens: 50, actualNeurons: 4 }] }
  });
  const unknown = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: { generationCalls: [{ inputTokens: 100, outputTokens: 50 }] }
  });
  const known5 = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: { generationCalls: [{ inputTokens: 100, outputTokens: 50, actualNeurons: 5 }] }
  });

  recordScoutUsage({ model: '@cf/meta/llama-3.1-8b-instruct-fast' }, known4);
  recordScoutUsage({ model: '@cf/meta/llama-3.1-8b-instruct-fast' }, unknown);
  const session = recordScoutUsage({ model: '@cf/meta/llama-3.1-8b-instruct-fast' }, known5);

  assert.strictEqual(session.neurons, null);
  assert.strictEqual(session.neuronsComplete, false);
  assert.strictEqual(session.providerCalls, 3);
});

test('C: all known requests sum correctly', () => {
  window.__PROJECTHUB_USAGE__ = undefined;
  const known4 = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: { generationCalls: [{ inputTokens: 100, outputTokens: 50, actualNeurons: 4 }] }
  });
  const known5 = summarizeGenerationCalls({
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    agent: { generationCalls: [{ inputTokens: 100, outputTokens: 50, actualNeurons: 5 }] }
  });

  recordScoutUsage({ model: '@cf/meta/llama-3.1-8b-instruct-fast' }, known4);
  const session = recordScoutUsage({ model: '@cf/meta/llama-3.1-8b-instruct-fast' }, known5);

  assert.strictEqual(session.neurons, 9);
  assert.strictEqual(session.neuronsComplete, true);
  assert.strictEqual(session.providerCalls, 2);
});

test('D: three estimated-from-exact-model requests sum correctly', () => {
  window.__PROJECTHUB_USAGE__ = undefined;
  const model = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
  const make = () => summarizeGenerationCalls({
    provider: 'cloudflare',
    model,
    agent: { generationCalls: [{ inputTokens: 1_000_000, outputTokens: 0, estimatedNeurons: 4119 }] }
  });

  recordScoutUsage({ model }, make());
  recordScoutUsage({ model }, make());
  const session = recordScoutUsage({ model }, make());

  assert.strictEqual(session.neurons, 4119 * 3);
  assert.strictEqual(session.neuronsComplete, true);
  assert.strictEqual(session.providerCalls, 3);
});

test('E: no provider/model call is not confused with verified zero', () => {
  window.__PROJECTHUB_USAGE__ = undefined;
  const directKb = summarizeGenerationCalls({
    agent: { generationCalls: [] }
  });
  const session = recordScoutUsage({ proseSource: 'DIRECT_KB' }, directKb);

  assert.strictEqual(session.providerCalls, 0);
  assert.strictEqual(session.neurons, null);
  assert.strictEqual(session.neuronsComplete, true);
  assert.notStrictEqual(session.neurons, 0);
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
