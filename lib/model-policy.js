'use strict';

const RETIRED_GROQ_MODELS = new Map([
  ['llama-3.1-8b-instant', '2026-08-16'],
  ['llama-3.3-70b-versatile', '2026-08-16'],
  ['qwen/qwen3-32b', '2026-07-17'],
  ['meta-llama/llama-4-scout-17b-16e-instruct', '2026-07-17']
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

module.exports = { RETIRED_GROQ_MODELS, groqModelPolicy };
