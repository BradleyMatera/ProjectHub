'use strict';

const RETIRED_GROQ_MODELS = new Map([
  ['llama-3.1-8b-instant', '2026-08-16'],
  ['llama-3.3-70b-versatile', '2026-08-16'],
  ['qwen/qwen3-32b', '2026-07-17'],
  ['meta-llama/llama-4-scout-17b-16e-instruct', '2026-07-17']
]);

const RETIRED_PROVIDERS = new Map([
  ['github', '2026-07-30']
]);

function groqModelPolicy(model) {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) {
    return { allowed: false, model: '', reason: 'model-not-configured', shutdownDate: null };
  }
  const shutdownDate = RETIRED_GROQ_MODELS.get(normalized) || null;
  if (shutdownDate) {
    return { allowed: false, model: normalized, reason: 'retired-model', shutdownDate };
  }
  return { allowed: true, model: normalized, reason: null, shutdownDate: null };
}

function providerPolicy(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  const shutdownDate = RETIRED_PROVIDERS.get(normalized) || null;
  if (shutdownDate) {
    return { allowed: false, provider: normalized, reason: 'retired-provider', shutdownDate };
  }
  return { allowed: true, provider: normalized, reason: null, shutdownDate: null };
}

module.exports = { RETIRED_GROQ_MODELS, RETIRED_PROVIDERS, groqModelPolicy, providerPolicy };
