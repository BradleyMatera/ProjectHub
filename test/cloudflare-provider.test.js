'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Test the Cloudflare Workers AI provider adapter without real API calls.
// We mock fetch to verify request construction, response parsing, error handling,
// and neuron telemetry.

const cfProvider = require('../lib/cloudflare-provider');

function mockFetch(response) {
  global.fetch = async () => response;
}

function mockFetchJson(status, json) {
  global.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
    json: async () => json,
  });
}

test('isConfigured returns false when no env vars set', () => {
  // Explicitly unset for this test
  const origAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete require.cache[require.resolve('../lib/cloudflare-provider')];
  const cf = require('../lib/cloudflare-provider');
  assert.equal(cf.isConfigured(), false);
  // Restore
  if (origAccount) process.env.CLOUDFLARE_ACCOUNT_ID = origAccount;
  if (origToken) process.env.CLOUDFLARE_API_TOKEN = origToken;
  delete require.cache[require.resolve('../lib/cloudflare-provider')];
});

test('isPaidOnly correctly identifies paid-only models', () => {
  assert.equal(cfProvider.isPaidOnly('@cf/moonshotai/kimi-k2.6'), true);
  assert.equal(cfProvider.isPaidOnly('@cf/moonshotai/kimi-k2.7-code'), true);
  assert.equal(cfProvider.isPaidOnly('@cf/zai-org/glm-5.2'), true);
  assert.equal(cfProvider.isPaidOnly('@cf/meta/llama-3.2-3b-instruct'), false);
  assert.equal(cfProvider.isPaidOnly('@cf/zai-org/glm-4.7-flash'), false);
});

test('neuronPricing returns correct rates for known models', () => {
  const pricing1b = cfProvider.neuronPricing('@cf/meta/llama-3.2-1b-instruct');
  assert.equal(pricing1b.input, 2457);
  assert.equal(pricing1b.output, 18252);

  const pricing3b = cfProvider.neuronPricing('@cf/meta/llama-3.2-3b-instruct');
  assert.equal(pricing3b.input, 4625);
  assert.equal(pricing3b.output, 30475);

  const pricingGlm = cfProvider.neuronPricing('@cf/zai-org/glm-4.7-flash');
  assert.equal(pricingGlm.input, 5500);
  assert.equal(pricingGlm.output, 36400);
});

test('neuronPricing returns null for unknown model', () => {
  assert.equal(cfProvider.neuronPricing('@cf/unknown/model'), null);
});

test('estimateNeurons calculates correctly for llama-3.2-3b', () => {
  // 500 input tokens, 100 output tokens
  // input: (500/1M) * 4625 = 2.3125 neurons
  // output: (100/1M) * 30475 = 3.0475 neurons
  // total: 5.36 neurons (raw float, no rounding)
  const neurons = cfProvider.estimateNeurons('@cf/meta/llama-3.2-3b-instruct', 500, 100);
  assert.equal(neurons, 5.36);
});

test('estimateNeurons returns null for unknown model', () => {
  assert.equal(cfProvider.estimateNeurons('@cf/unknown/model', 500, 100), null);
});

test('estimateDailyCapacity calculates requests per day', () => {
  // For llama-3.2-3b with 500 input + 100 output = 5.36 neurons/request (raw float)
  // Math.floor(10000 / 5.36) = 1865 requests/day
  const capacity = cfProvider.estimateDailyCapacity('@cf/meta/llama-3.2-3b-instruct', 500, 100);
  assert.equal(capacity, 1865);
});

test('estimateDailyCapacity returns null for unknown model', () => {
  assert.equal(cfProvider.estimateDailyCapacity('@cf/unknown/model', 500, 100), null);
});

test('generate returns cloudflare_not_configured when no credentials', async () => {
  const origAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete require.cache[require.resolve('../lib/cloudflare-provider')];
  const cf = require('../lib/cloudflare-provider');
  const result = await cf.generate('@cf/meta/llama-3.2-3b-instruct', [
    { role: 'user', content: 'hi' }
  ], {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cloudflare_not_configured');
  // Restore
  if (origAccount) process.env.CLOUDFLARE_ACCOUNT_ID = origAccount;
  if (origToken) process.env.CLOUDFLARE_API_TOKEN = origToken;
  delete require.cache[require.resolve('../lib/cloudflare-provider')];
});

test('generate returns paid_only_model for restricted models', async () => {
  // Temporarily set env vars
  const origAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';

  try {
    // Re-require to pick up env vars
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
    const cfProviderWithCreds = require('../lib/cloudflare-provider');

    const result = await cfProviderWithCreds.generate('@cf/zai-org/glm-5.2', [
      { role: 'user', content: 'hi' }
    ], {});
    assert.equal(result.ok, false);
    assert.equal(result.error, 'paid_only_model');
  } finally {
    process.env.CLOUDFLARE_ACCOUNT_ID = origAccount;
    process.env.CLOUDFLARE_API_TOKEN = origToken;
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
  }
});

test('generate parses Cloudflare response format correctly', async () => {
  const origAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';

  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    assert.ok(url.includes('/accounts/test-account/ai/run/'));
    assert.ok(url.includes('@cf/meta/llama-3.2-3b-instruct'));
    assert.equal(opts.headers['Authorization'], 'Bearer test-token');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        success: true,
        errors: [],
        result: {
          response: 'Bradley uses JavaScript and React.',
          usage: { prompt_tokens: 150, completion_tokens: 12 },
        },
      }),
      json: async () => ({
        success: true,
        errors: [],
        result: {
          response: 'Bradley uses JavaScript and React.',
          usage: { prompt_tokens: 150, completion_tokens: 12 },
        },
      }),
    };
  };

  try {
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
    const cfProviderWithCreds = require('../lib/cloudflare-provider');

    const result = await cfProviderWithCreds.generate('@cf/meta/llama-3.2-3b-instruct', [
      { role: 'system', content: 'You are Scout.' },
      { role: 'user', content: 'What is his tech stack?' }
    ], { numPredict: 100, temperature: 0.3 });

    assert.equal(result.ok, true);
    assert.equal(result.text, 'Bradley uses JavaScript and React.');
    assert.equal(result.model, '@cf/meta/llama-3.2-3b-instruct');
    assert.equal(result.usage.promptEvalCount, 150);
    assert.equal(result.usage.evalCount, 12);
    assert.equal(result.usage.provider, 'cloudflare');
    assert.ok(result.usage.estimatedNeurons > 0);
  } finally {
    global.fetch = origFetch;
    process.env.CLOUDFLARE_ACCOUNT_ID = origAccount;
    process.env.CLOUDFLARE_API_TOKEN = origToken;
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
  }
});

test('generate parses OpenAI-compatible response format', async () => {
  const origAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';

  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      success: true,
      errors: [],
      result: {
        choices: [{ message: { content: 'Yes, he knows React.' } }],
        usage: { input_tokens: 80, output_tokens: 8 },
      },
    }),
    json: async () => ({
      success: true,
      errors: [],
      result: {
        choices: [{ message: { content: 'Yes, he knows React.' } }],
        usage: { input_tokens: 80, output_tokens: 8 },
      },
    }),
  });

  try {
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
    const cfProviderWithCreds = require('../lib/cloudflare-provider');

    const result = await cfProviderWithCreds.generate('@cf/meta/llama-3.2-3b-instruct', [
      { role: 'user', content: 'Does he know React?' }
    ], {});

    assert.equal(result.ok, true);
    assert.equal(result.text, 'Yes, he knows React.');
    assert.equal(result.usage.promptEvalCount, 80);
    assert.equal(result.usage.evalCount, 8);
  } finally {
    global.fetch = origFetch;
    process.env.CLOUDFLARE_ACCOUNT_ID = origAccount;
    process.env.CLOUDFLARE_API_TOKEN = origToken;
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
  }
});

test('generate handles free allocation exhausted error (3036)', async () => {
  const origAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';

  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({
      success: false,
      errors: [{ code: 3036, message: 'You have used up your daily free allocation of 10,000 neurons.' }],
    }),
    json: async () => ({
      success: false,
      errors: [{ code: 3036, message: 'You have used up your daily free allocation of 10,000 neurons.' }],
    }),
  });

  try {
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
    const cfProviderWithCreds = require('../lib/cloudflare-provider');

    const result = await cfProviderWithCreds.generate('@cf/meta/llama-3.2-3b-instruct', [
      { role: 'user', content: 'hi' }
    ], {});

    assert.equal(result.ok, false);
    assert.equal(result.errorType, 'free_allocation_exhausted');
    assert.ok(result.error.includes('3036'));
  } finally {
    global.fetch = origFetch;
    process.env.CLOUDFLARE_ACCOUNT_ID = origAccount;
    process.env.CLOUDFLARE_API_TOKEN = origToken;
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
  }
});

test('generate handles out of capacity error (3040)', async () => {
  const origAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';

  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({
      success: false,
      errors: [{ code: 3040, message: 'No more data centers to forward the request to' }],
    }),
    json: async () => ({
      success: false,
      errors: [{ code: 3040, message: 'No more data centers to forward the request to' }],
    }),
  });

  try {
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
    const cfProviderWithCreds = require('../lib/cloudflare-provider');

    const result = await cfProviderWithCreds.generate('@cf/meta/llama-3.2-3b-instruct', [
      { role: 'user', content: 'hi' }
    ], {});

    assert.equal(result.ok, false);
    assert.equal(result.errorType, 'out_of_capacity');
  } finally {
    global.fetch = origFetch;
    process.env.CLOUDFLARE_ACCOUNT_ID = origAccount;
    process.env.CLOUDFLARE_API_TOKEN = origToken;
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
  }
});

test('generate respects abortSignal', async () => {
  const origAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';

  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    // Simulate abort
    if (opts.signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    return {
      ok: true,
      status: 200,
      text: async () => '{}',
      json: async () => ({ result: { response: 'test' } }),
    };
  };

  try {
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
    const cfProviderWithCreds = require('../lib/cloudflare-provider');

    const controller = new AbortController();
    controller.abort();

    const result = await cfProviderWithCreds.generate('@cf/meta/llama-3.2-3b-instruct', [
      { role: 'user', content: 'hi' }
    ], { abortSignal: controller.signal });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'request_deadline');
    assert.equal(result.errorType, 'request_deadline');
  } finally {
    global.fetch = origFetch;
    process.env.CLOUDFLARE_ACCOUNT_ID = origAccount;
    process.env.CLOUDFLARE_API_TOKEN = origToken;
    delete require.cache[require.resolve('../lib/cloudflare-provider')];
  }
});

test('FREE_DAILY_NEURON_LIMIT is 10000', () => {
  assert.equal(cfProvider.FREE_DAILY_NEURON_LIMIT, 10000);
});
