'use strict';

// Cloudflare Workers AI Provider — zero-cost hosted inference adapter.
//
// This module implements the same generate() interface as local-model-router.js
// but routes requests to Cloudflare's Workers AI REST API instead of a local
// Ollama instance. It is designed to be swappable: the lite-agent and
// agent-engine call router.generate() and do not know which provider answered.
//
// Free-tier constraints:
//   * 10,000 neurons/day on Workers Free plan
//   * No credit card required
//   * Requests fail with 429 (error 3036) when allocation exhausted
//   * No automatic fallback to paid providers
//
// API format:
//   POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model}
//   Authorization: Bearer {API_TOKEN}
//   Body: { messages: [...], max_tokens, temperature, top_p, stream: false }
//   Response: { result: { response: "..." }, success: true, errors: [], messages: [] }
//   Or OpenAI-compatible: { result: { choices: [{message: {content: "..."}}] } }

const CF_BASE_URL = 'https://api.cloudflare.com/client/v4';

// Per-model neuron pricing (neurons per million tokens).
// Source: https://developers.cloudflare.com/workers-ai/platform/pricing/
// Updated Aug 7, 2026.
const MODEL_NEURON_PRICING = {
  '@cf/meta/llama-3.2-1b-instruct': { input: 2457, output: 18252 },
  '@cf/meta/llama-3.2-3b-instruct': { input: 4625, output: 30475 },
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast': { input: 4119, output: 34868 },
  '@cf/meta/llama-3.1-8b-instruct-fp8': { input: 13778, output: 26128 },
  '@cf/zai-org/glm-4.7-flash': { input: 5500, output: 36400 },
};

// Models that require Workers Paid plan (must never be used on free).
const PAID_ONLY_MODELS = new Set([
  '@cf/moonshotai/kimi-k2.6',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/zai-org/glm-5.2',
]);

const FREE_DAILY_NEURON_LIMIT = 10000;

function isConfigured() {
  return !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
}

function configuredModel() {
  return process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';
}

function isPaidOnly(model) {
  return PAID_ONLY_MODELS.has(model);
}

function neuronPricing(model) {
  return MODEL_NEURON_PRICING[model] || null;
}

// Estimate neuron consumption for a request.
// Returns the raw floating-point value — callers that need integer display
// should round explicitly. This preserves maximum precision for accounting.
function estimateNeurons(model, inputTokens, outputTokens) {
  const pricing = neuronPricing(model);
  if (!pricing) return null;
  const inputNeurons = (inputTokens / 1_000_000) * pricing.input;
  const outputNeurons = (outputTokens / 1_000_000) * pricing.output;
  return inputNeurons + outputNeurons;
}

// Estimate daily request capacity at 10,000 neurons.
function estimateDailyCapacity(model, avgInputTokens, avgOutputTokens) {
  const neuronsPerRequest = estimateNeurons(model, avgInputTokens, avgOutputTokens);
  if (!neuronsPerRequest || neuronsPerRequest <= 0) return null;
  return Math.floor(FREE_DAILY_NEURON_LIMIT / neuronsPerRequest);
}

// Generate via Cloudflare Workers AI REST API.
// Returns { ok, text, usage, latencyMs, model, error } — same shape as local-model-router.generate().
// options: { temperature, topP, numPredict, timeoutMs, abortSignal, raw }
async function generate(model, messages, options = {}) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || '';

  if (!accountId || !apiToken) {
    return { ok: false, text: '', usage: null, latencyMs: 0, startedAt: Date.now(), endedAt: Date.now(), model: model || configuredModel(), error: 'cloudflare_not_configured' };
  }

  const targetModel = model || configuredModel();

  if (isPaidOnly(targetModel)) {
    return { ok: false, text: '', usage: null, latencyMs: 0, startedAt: Date.now(), endedAt: Date.now(), model: targetModel, error: 'paid_only_model' };
  }

  const timeoutMs = Math.max(1000, Math.min(options.timeoutMs || 12000, 60000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Link external abort signal to internal controller
  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      controller.abort();
    } else {
      options.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  const startedAt = Date.now();
  const url = `${CF_BASE_URL}/accounts/${accountId}/ai/run/${targetModel}`;
  const body = {
    messages,
    stream: false,
    max_tokens: Math.max(1, Math.min(options.numPredict || 128, 512)),
    temperature: options.temperature !== undefined ? options.temperature : 0.2,
    top_p: options.topP !== undefined ? options.topP : 0.9,
  };
  // Handle JSON format request (lite agent uses format: 'json')
  if (options.format === 'json') {
    body.response_format = { type: 'json_object' };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errorMsg = `HTTP ${res.status}`;
      let errorType = `http_${res.status}`;

      // Parse Cloudflare error codes
      try {
        const errData = JSON.parse(errText);
        if (errData.errors && errData.errors.length > 0) {
          const cfErr = errData.errors[0];
          errorMsg = `CF ${cfErr.code}: ${cfErr.message || ''}`.slice(0, 200);
          if (cfErr.code === 3036) errorType = 'free_allocation_exhausted';
          else if (cfErr.code === 3040) errorType = 'out_of_capacity';
          else if (cfErr.code === 5035) errorType = 'paid_plan_required';
        }
      } catch {}

      return { ok: false, text: '', usage: null, latencyMs: Date.now() - startedAt, startedAt, endedAt: Date.now(), model: targetModel, error: errorMsg, errorType };
    }

    const data = await res.json();
    const cfRay = res.headers?.get('cf-ray') || null;
    const providerTraceId = cfRay;
    const providerTraceType = cfRay ? 'cf-ray' : null;

    // Cloudflare returns { result: { response: "..." } } for /ai/run/ endpoint
    // Or { result: { choices: [{ message: { content: "..." } }] } } for OpenAI-compatible
    // When response_format json_object is used, result.response may be an object
    // (not a string) — in that case, prefer choices[0].message.content (string)
    // or JSON.stringify the response object.
    // Reasoning models (e.g. GLM-4.7-flash) may put output in reasoning_content
    // when content is empty due to token limits.
    let text = '';
    let reasoningText = '';
    if (data.result) {
      if (data.result.choices && data.result.choices.length > 0) {
        const choice = data.result.choices[0];
        text = String(choice.message?.content || choice.text || '');
        reasoningText = String(choice.message?.reasoning_content || '');
      } else if (data.result.response) {
        // response can be a string or an object (JSON mode)
        const resp = data.result.response;
        text = typeof resp === 'string' ? resp : JSON.stringify(resp);
      }
    }
    // If content is empty but reasoning_content exists, use reasoning_content
    // (happens with reasoning models when max_tokens is too low for final answer)
    if (!text && reasoningText) {
      text = reasoningText;
    }
    text = text.replace(/\s+/g, ' ').trim();

    // Extract usage if available
    const usage = {
      promptEvalCount: data.result?.usage?.prompt_tokens || data.result?.usage?.input_tokens || null,
      evalCount: data.result?.usage?.completion_tokens || data.result?.usage?.output_tokens || null,
      doneReason: data.result?.choices?.[0]?.finish_reason || data.result?.finish_reason || null,
      totalDurationNs: null,
      loadDurationNs: null,
      promptEvalDurationNs: null,
      evalDurationNs: null,
      provider: 'cloudflare',
      model: targetModel,
      estimatedNeurons: null,
      actualNeurons: data.result?.usage?.neurons != null ? data.result.usage.neurons : null,
    };

    // Estimate neuron consumption
    const inputTokens = usage.promptEvalCount || Math.ceil(messages.reduce((sum, m) => sum + String(m.content || '').length, 0) / 4);
    const outputTokens = usage.evalCount || Math.ceil(text.length / 4);
    usage.estimatedNeurons = estimateNeurons(targetModel, inputTokens, outputTokens);

    return { ok: true, text, usage, latencyMs: Date.now() - startedAt, startedAt, endedAt: Date.now(), model: targetModel, providerTraceId, providerTraceType };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    const requestAborted = aborted && options.abortSignal?.aborted;
    return {
      ok: false,
      text: '',
      usage: null,
      latencyMs: Date.now() - startedAt,
      startedAt,
      endedAt: Date.now(),
      model: targetModel,
      error: requestAborted ? 'request_deadline' : (aborted ? 'timeout' : String(error?.message || error).slice(0, 200)),
      errorType: requestAborted ? 'request_deadline' : (aborted ? 'timeout' : 'fetch_error'),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Health probe: verify Cloudflare Workers AI is reachable and token is valid.
// Returns { reachable, latencyMs, error }.
async function healthCheck(timeoutMs) {
  if (!isConfigured()) {
    return { reachable: false, latencyMs: 0, error: 'not_configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs || 5000, 10000));
  const startedAt = Date.now();

  try {
    // Use a minimal generate call as health check
    const result = await generate(configuredModel(), [
      { role: 'user', content: 'hi' },
    ], { numPredict: 1, timeoutMs: Math.min(timeoutMs || 5000, 10000) });

    return {
      reachable: result.ok,
      latencyMs: Date.now() - startedAt,
      error: result.ok ? null : result.error,
      errorType: result.errorType,
    };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: String(error?.message || error).slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  isConfigured,
  configuredModel,
  isPaidOnly,
  neuronPricing,
  estimateNeurons,
  estimateDailyCapacity,
  generate,
  healthCheck,
  MODEL_NEURON_PRICING,
  FREE_DAILY_NEURON_LIMIT,
};
