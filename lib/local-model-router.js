'use strict';

// Local Model Router — Scout's only generative engine is self-hosted Ollama.
//
// Design goals:
//   * Scout owns and controls its generative capability. No hosted LLM is ever
//     routed as a generative fallback. If every configured local model is
//     unavailable, the caller falls back to a deterministic grounded response.
//   * The router is model-agnostic: we can change model, quantization, context
//     size, or generation settings without rewriting Scout.
//   * Every model in the primary network must be a downloadable/self-hosted
//     weight we can preserve ourselves. The router never reaches a hosted API.
//
// This module is the single surface through which server-gemini.js calls Ollama.
// It exposes:
//   * listLocalModels()         — health/tags probe
//   * generate(model, messages) — single structured generation
//   * chat(model, messages)     — streaming chat completion (returns full text)
//   * selectModel(task)         — task-aware local model selection
//
// All network calls target OLLAMA_URL only.

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = Math.max(2000, Math.min(parseInt(process.env.OLLAMA_TIMEOUT_MS || '12000', 10), 30000));

// Pinned, reproducible local models. Each entry records the exact tag, license,
// and hardware envelope so the environment can be recreated six months from now.
// Sizes/quantization are recorded from `ollama show` at pin time.
const LOCAL_MODELS = {
  'qwen2.5:0.5b': {
    family: 'qwen2.5',
    parameterSize: '0.5B',
    quantization: 'q4_K_M (default Ollama tag)',
    fileSizeMb: 397,
    minRamMb: 768,
    license: 'Apache 2.0 (Qwen2.5 weights). Self-hosted use permitted; no redistribution restrictions beyond notice.',
    contextWindow: 32768,
    notes: 'Primary production model on GCP e2-micro (1GB RAM + 2GB swap). Fast, low-RAM, reliable structured JSON with compact prompts.'
  },
  'qwen2.5:1.5b': {
    family: 'qwen2.5',
    parameterSize: '1.5B',
    quantization: 'q4_K_M (default Ollama tag)',
    fileSizeMb: 987,
    minRamMb: 1400,
    license: 'Apache 2.0 (Qwen2.5 weights). Self-hosted use permitted.',
    contextWindow: 32768,
    notes: 'Candidate for stronger reasoning where RAM allows. Slower on e2-micro; viable on dev Mac.'
  },
  'gemma3:1b': {
    family: 'gemma3',
    parameterSize: '1B',
    quantization: 'q4_K_M (default Ollama tag)',
    fileSizeMb: 815,
    minRamMb: 1200,
    license: 'Gemma Terms of Use (Google). Self-hosted use permitted; redistribution subject to Gemma terms.',
    contextWindow: 8192,
    notes: 'Candidate. Good instruction following; narrower context window.'
  }
};

// Task routing: different local models may serve different task complexity.
// Only enabled when OLLAMA_TASK_ROUTING=true; otherwise the default model is used
// for everything. This avoids premature routing complexity.
const TASK_MODELS = {
  classify: null,   // use default (cheap, fast)
  tool_select: null,
  reason: null,
  synthesize: null,
  judge: null
};

function configuredOllamaUrl() {
  return String(process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/$/, '');
}

function defaultModel() {
  return process.env.OLLAMA_MODEL || process.env.GEN_MODEL || 'qwen2.5:0.5b';
}

function agentModel() {
  return process.env.OLLAMA_AGENT_MODEL || defaultModel();
}

function selectModel(task) {
  if (process.env.OLLAMA_TASK_ROUTING !== 'true') return agentModel();
  const mapped = TASK_MODELS[task];
  return mapped || agentModel();
}

function modelInfo(name) {
  return LOCAL_MODELS[name] || null;
}

function listPinnedModels() {
  return Object.entries(LOCAL_MODELS).map(([name, info]) => ({ name, ...info }));
}

// Health probe: returns { reachable, models, latencyMs }.
async function listLocalModels(timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs || 3000, 5000));
  try {
    const res = await fetch(`${configuredOllamaUrl()}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { reachable: false, models: [], latencyMs: Date.now() - startedAt, error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map(m => m.name || m.model).filter(Boolean);
    return { reachable: true, models, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { reachable: false, models: [], latencyMs: Date.now() - startedAt, error: String(error?.message || error).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

// Single non-streaming generation. Returns { ok, text, usage, latencyMs, model, error }.
// options: { temperature, topP, numCtx, numPredict, numThread, repeatPenalty, keepAlive, timeoutMs, raw }
async function generate(model, messages, options = {}) {
  const url = configuredOllamaUrl();
  const timeoutMs = Math.max(1000, Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, 30000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const body = {
    model: model || defaultModel(),
    messages,
    stream: false,
    keep_alive: options.keepAlive !== undefined ? options.keepAlive : (process.env.OLLAMA_KEEP_ALIVE || -1),
    options: {
      temperature: options.temperature !== undefined ? options.temperature : 0.2,
      top_p: options.topP !== undefined ? options.topP : 0.9,
      num_ctx: Math.max(512, Math.min(options.numCtx || parseInt(process.env.OLLAMA_AGENT_CONTEXT || '2048', 10), 8192)),
      num_predict: Math.max(1, Math.min(options.numPredict || 128, 512)),
      repeat_penalty: options.repeatPenalty !== undefined ? options.repeatPenalty : 1.1,
      num_thread: options.numThread || parseInt(process.env.OLLAMA_NUM_THREAD || '2', 10)
    }
  };
  if (options.raw) body.raw = true;
  if (options.format) body.format = options.format; // e.g. 'json'
  try {
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, text: '', usage: null, latencyMs: Date.now() - startedAt, model: body.model, error: `HTTP ${res.status} ${errText.slice(0, 200)}` };
    }
    const data = await res.json();
    const text = String(data.message?.content || data.response || '').replace(/\s+/g, ' ').trim();
    const usage = {
      promptEvalCount: Number.isFinite(data.prompt_eval_count) ? data.prompt_eval_count : null,
      evalCount: Number.isFinite(data.eval_count) ? data.eval_count : null,
      doneReason: data.done_reason || null,
      totalDurationNs: data.total_duration || null,
      loadDurationNs: data.load_duration || null,
      promptEvalDurationNs: data.prompt_eval_duration || null,
      evalDurationNs: data.eval_duration || null
    };
    return { ok: true, text, usage, latencyMs: Date.now() - startedAt, model: body.model };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return { ok: false, text: '', usage: null, latencyMs: Date.now() - startedAt, model: body.model, error: aborted ? 'timeout' : String(error?.message || error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

// Streaming chat completion. Calls onToken(text) as tokens arrive, returns final
// { ok, text, usage, latencyMs, model, error, aborted }. Used by the agent loop
// so we can abort early when a forbidden pattern is detected mid-generation.
async function chat(model, messages, options = {}, onToken) {
  const url = configuredOllamaUrl();
  const timeoutMs = Math.max(1000, Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, 30000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const body = {
    model: model || defaultModel(),
    messages,
    stream: true,
    keep_alive: options.keepAlive !== undefined ? options.keepAlive : (process.env.OLLAMA_KEEP_ALIVE || -1),
    options: {
      temperature: options.temperature !== undefined ? options.temperature : 0.2,
      top_p: options.topP !== undefined ? options.topP : 0.9,
      num_ctx: Math.max(512, Math.min(options.numCtx || parseInt(process.env.OLLAMA_AGENT_CONTEXT || '2048', 10), 8192)),
      num_predict: Math.max(1, Math.min(options.numPredict || 128, 512)),
      repeat_penalty: options.repeatPenalty !== undefined ? options.repeatPenalty : 1.1,
      num_thread: options.numThread || parseInt(process.env.OLLAMA_NUM_THREAD || '2', 10)
    }
  };
  if (options.format) body.format = options.format;
  let accumulated = '';
  let usage = null;
  let abortedByPattern = false;
  try {
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, text: '', usage: null, latencyMs: Date.now() - startedAt, model: body.model, error: `HTTP ${res.status} ${errText.slice(0, 200)}` };
    }
    if (!res.body) {
      // Non-streaming fallback
      const data = await res.json();
      const text = String(data.message?.content || '').replace(/\s+/g, ' ').trim();
      return { ok: true, text, usage: { promptEvalCount: data.prompt_eval_count, evalCount: data.eval_count, doneReason: data.done_reason }, latencyMs: Date.now() - startedAt, model: body.model };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed);
          if (chunk.done) {
            usage = {
              promptEvalCount: Number.isFinite(chunk.prompt_eval_count) ? chunk.prompt_eval_count : null,
              evalCount: Number.isFinite(chunk.eval_count) ? chunk.eval_count : null,
              doneReason: chunk.done_reason || null,
              totalDurationNs: chunk.total_duration || null,
              loadDurationNs: chunk.load_duration || null
            };
          }
          const content = chunk.message?.content || chunk.response || '';
          if (content) {
            accumulated += content;
            if (typeof onToken === 'function') {
              const decision = onToken(accumulated);
              if (decision === 'abort') {
                abortedByPattern = true;
                controller.abort();
                break;
              }
            }
          }
        } catch {
          // ignore malformed JSON lines
        }
      }
      if (abortedByPattern) break;
    }
    return { ok: true, text: accumulated.replace(/\s+/g, ' ').trim(), usage, latencyMs: Date.now() - startedAt, model: body.model, aborted: abortedByPattern };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    if (abortedByPattern) {
      return { ok: true, text: accumulated.replace(/\s+/g, ' ').trim(), usage, latencyMs: Date.now() - startedAt, model: body.model, aborted: true };
    }
    return { ok: false, text: accumulated, usage: null, latencyMs: Date.now() - startedAt, model: body.model, error: aborted ? 'timeout' : String(error?.message || error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  LOCAL_MODELS,
  configuredOllamaUrl,
  defaultModel,
  agentModel,
  selectModel,
  modelInfo,
  listPinnedModels,
  listLocalModels,
  generate,
  chat
};
