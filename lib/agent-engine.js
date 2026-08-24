'use strict';

// Scout Agent Engine — a bounded generative agent loop powered by self-hosted
// Ollama. This is the heart of Scout's generative intelligence.
//
// Lifecycle:
//   user message
//     -> context assembly (retrieval + conversation state + tools)
//     -> Ollama reasoning decision (structured JSON)
//     -> Scout validates the decision
//     -> Scout executes the requested tool (if any)
//     -> observation returned to Ollama
//     -> Ollama continuation (synthesize or request another tool)
//     -> grounding validation
//     -> grounded answer OR deterministic fallback
//
// Bounds:
//   * max 3 reasoning/tool iterations for normal public traffic
//   * duplicate tool calls rejected
//   * malformed JSON: one cheap repair attempt, then fallback
//   * unknown tools / bad arguments rejected
//   * oversized arguments/observations truncated
//   * model timeout/error -> deterministic fallback
//   * every step emits a real agent event for the engineering console
//
// Ollama REASONS here. It selects tools, decomposes questions, synthesizes
// evidence, and writes the final answer. Scout validates and executes.

const router = require('./local-model-router');
const { executeAgentTool, TOOL_DEFINITIONS, selectAgentToolNames } = require('./agent-tools');
const { buildReasoningPacket, buildSynthesisPacket, buildRepairPacket } = require('./context-packet');
const { validateAnswer, validateToolDecision, attemptJsonRepair, extractCompleteSentences, cleanText } = require('./grounding-validator');

const MAX_STEPS = parseInt(process.env.SCOUT_MAX_STEPS || '3', 10);
const STEP_TIMEOUT_MS = Math.max(2000, Math.min(parseInt(process.env.SCOUT_STEP_TIMEOUT_MS || '6000', 10), 60000));
const TOTAL_BUDGET_MS = Math.max(4000, Math.min(parseInt(process.env.SCOUT_TOTAL_BUDGET_MS || '15000', 10), 120000));
const MAX_TOOL_ARGS_CHARS = 500;
const MAX_OBSERVATION_CHARS = 1200;

// All tools are available to the model by default. The harness validates and
// executes; the model only requests.
function allToolNames() {
  return TOOL_DEFINITIONS.map(t => t.function.name);
}

// Truncate tool arguments to prevent oversized inputs.
function clampArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (typeof value === 'string') {
      out[key] = value.slice(0, MAX_TOOL_ARGS_CHARS);
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 6).map(v => typeof v === 'string' ? v.slice(0, 200) : v);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Truncate tool observations to prevent context bloat.
function clampObservation(result) {
  const text = JSON.stringify(result);
  if (text.length <= MAX_OBSERVATION_CHARS) return result;
  return { truncated: true, preview: text.slice(0, MAX_OBSERVATION_CHARS - 20) + '…' };
}

// Parse the model's structured JSON output. One repair attempt, then give up.
function parseDecision(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || '').trim());
  } catch {
    parsed = attemptJsonRepair(raw);
  }
  return parsed;
}

// Run one reasoning step: ask Ollama for a structured decision.
// Returns { ok, decision, raw, latencyMs, model, error }
async function reasoningStep({ model, packet, allowedTools, timeoutMs }) {
  const result = await router.generate(model, [
    { role: 'system', content: packet.systemPrompt },
    { role: 'user', content: packet.userPrompt }
  ], {
    timeoutMs: timeoutMs || STEP_TIMEOUT_MS,
    temperature: 0,
    topP: 0.85,
    numPredict: 200,
    format: 'json'
  });
  if (!result.ok) return { ok: false, decision: null, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: result.error };
  const parsed = parseDecision(result.text);
  if (!parsed) return { ok: false, decision: null, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: 'unparseable_json' };
  const validation = validateToolDecision(parsed, allowedTools);
  if (!validation.valid) return { ok: false, decision: null, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: validation.error };
  return { ok: true, decision: validation.decision, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: null };
}

// Run the synthesis step: ask Ollama to write the final grounded answer from
// evidence + tool observations.
async function synthesisStep({ model, packet, timeoutMs }) {
  const result = await router.generate(model, [
    { role: 'system', content: packet.systemPrompt },
    { role: 'user', content: packet.userPrompt }
  ], {
    timeoutMs: timeoutMs || STEP_TIMEOUT_MS,
    temperature: 0,
    topP: 0.9,
    numPredict: 150,
    format: 'json'
  });
  if (!result.ok) return { ok: false, answer: null, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: result.error };
  const parsed = parseDecision(result.text);
  if (!parsed) return { ok: false, answer: null, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: 'unparseable_json' };
  let answer = String(parsed.answer || '').trim();
  if (answer.length < 10) return { ok: false, answer: null, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: 'answer_too_short' };
  // Extract complete sentences to enforce brevity and structure
  const sentences = extractCompleteSentences(answer, 3);
  if (sentences && sentences.length >= 20) answer = sentences;
  return { ok: true, answer, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: null };
}

// Run one repair step: send the rejection reasons back to the model and ask
// it to rewrite. This is a targeted retry, not a full re-prompt.
async function repairStep({ model, packet, timeoutMs }) {
  const result = await router.generate(model, [
    { role: 'system', content: packet.systemPrompt },
    { role: 'user', content: packet.userPrompt }
  ], {
    timeoutMs: timeoutMs || STEP_TIMEOUT_MS,
    temperature: 0,
    topP: 0.85,
    numPredict: 150,
    format: 'json'
  });
  if (!result.ok) return { ok: false, answer: null, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: result.error };
  const parsed = parseDecision(result.text);
  if (!parsed) return { ok: false, answer: null, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: 'unparseable_json' };
  let answer = String(parsed.answer || '').trim();
  if (answer.length < 10) return { ok: false, answer: null, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: 'answer_too_short' };
  const sentences = extractCompleteSentences(answer, 3);
  if (sentences && sentences.length >= 20) answer = sentences;
  return { ok: true, answer, raw: result.text, latencyMs: result.latencyMs, model: result.model, error: null };
}

// Main entry point: run the bounded agent loop.
// Returns { reply, provider, model, steps, toolResults, events, contextTokens, latencyMs, fallback }
async function runAgentLoop({ question, conversationState, evidence, knowledge, sessionId, model, rules }) {
  const startedAt = Date.now();
  const selectedModel = model || router.agentModel();
  const allowedTools = allToolNames();
  const events = [];
  const steps = [];
  const toolResults = [];
  const seenToolCalls = new Set();
  let contextTokens = 0;
  let totalOllamaLatencyMs = 0;

  function emit(type, data) {
    events.push({ ts: Date.now() - startedAt, type, ...data });
  }

  emit('agent_start', { model: selectedModel, maxSteps: MAX_STEPS, evidenceCount: (evidence || []).length });

  // Compute deterministic tool hint for the first step (helps the small model
  // select the right tool without removing its ability to choose differently)
  const hintTools = selectAgentToolNames(question, knowledge);
  const firstToolHint = hintTools.length > 1 ? hintTools[hintTools.length - 1] : null;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
      emit('budget_exceeded', { elapsedMs: Date.now() - startedAt });
      break;
    }

    // Build reasoning packet for this step
    const packet = buildReasoningPacket({
      question,
      conversationState,
      evidence,
      toolNames: allowedTools,
      rules,
      phase: step === 0 ? 'reason' : 'continue',
      toolHint: step === 0 ? firstToolHint : null
    });
    contextTokens = Math.max(contextTokens, packet.estimatedTokens);

    const remainingBudget = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    const stepTimeout = Math.min(STEP_TIMEOUT_MS, remainingBudget);

    emit('reasoning_call', { step, model: selectedModel, contextTokens: packet.estimatedTokens, evidenceCount: packet.evidenceCount });

    const reasonResult = await reasoningStep({ model: selectedModel, packet, allowedTools, timeoutMs: stepTimeout });
    totalOllamaLatencyMs += reasonResult.latencyMs;

    if (!reasonResult.ok) {
      emit('reasoning_failed', { step, error: reasonResult.error, latencyMs: reasonResult.latencyMs });
      break;
    }

    emit('reasoning_decision', { step, decision: reasonResult.decision, latencyMs: reasonResult.latencyMs, toolHint: step === 0 ? firstToolHint : null });

    // If the model decides to answer directly, validate and return.
    if (reasonResult.decision.action === 'answer') {
      const sourceText = buildSourceText(evidence, toolResults);
      const validation = validateAnswer(reasonResult.decision.answer, sourceText, question, knowledge);
      emit('validation', { verdict: validation.verdict, reasons: validation.reasons });
      if (validation.valid) {
        emit('agent_complete', { step, totalLatencyMs: Date.now() - startedAt, ollamaLatencyMs: totalOllamaLatencyMs, outcome: 'accepted' });
        return {
          reply: validation.cleaned,
          proseSource: 'MODEL_GENERATION',
          provider: 'ollama-agent',
          model: selectedModel,
          steps,
          toolResults,
          events,
          contextTokens,
          latencyMs: Date.now() - startedAt,
          fallback: false,
          validation: validation,
          outcome: 'accepted'
        };
      }
      // Validation failed — try synthesis with explicit grounding instead
      emit('direct_answer_rejected', { reasons: validation.reasons, rejectionDetails: validation.rejectionDetails });
      if (toolResults.length > 0 || evidence.length > 0) {
        // Fall through to the tool/synthesis loop with existing evidence
      } else {
        break;
      }
    }

    // The model requested a tool. Validate, execute, observe.
    const { tool, arguments: args } = reasonResult.decision;
    const callKey = `${tool}:${JSON.stringify(args)}`;
    if (seenToolCalls.has(callKey)) {
      emit('duplicate_tool_rejected', { tool, args });
      // Instead of breaking, synthesize with the evidence we already have.
      if (toolResults.length > 0) {
        const synthPacket = buildSynthesisPacket({
          question,
          conversationState,
          evidence,
          toolObservations: toolResults,
          rules
        });
        const synthRemaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
        const synthTimeout = Math.min(STEP_TIMEOUT_MS, synthRemaining);
        const synthResult = await synthesisStep({ model: selectedModel, packet: synthPacket, timeoutMs: synthTimeout });
        totalOllamaLatencyMs += synthResult.latencyMs;
        if (synthResult.ok) {
          const sourceText = buildSourceText(evidence, toolResults);
          const validation = validateAnswer(synthResult.answer, sourceText, question, knowledge);
          emit('validation', { verdict: validation.verdict, reasons: validation.reasons });
          if (validation.valid) {
            emit('agent_complete', { step, totalLatencyMs: Date.now() - startedAt, ollamaLatencyMs: totalOllamaLatencyMs, outcome: 'accepted' });
            return {
              reply: validation.cleaned,
              proseSource: 'MODEL_GENERATION',
              provider: 'ollama-agent',
              model: selectedModel,
              steps,
              toolResults,
              events,
              contextTokens,
              latencyMs: Date.now() - startedAt,
              fallback: false,
              validation,
              outcome: 'accepted'
            };
          }
        }
      }
      break;
    }
    seenToolCalls.add(callKey);

    const clampedArgs = clampArgs(args);
    emit('tool_execute', { step, tool, args: clampedArgs });

    const toolStart = Date.now();
    let toolResult;
    try {
      toolResult = executeAgentTool(tool, clampedArgs, knowledge);
    } catch (error) {
      toolResult = { error: `tool_execution_failed: ${String(error?.message || error).slice(0, 100)}` };
    }
    const toolLatencyMs = Date.now() - toolStart;
    const clampedResult = clampObservation(toolResult);

    steps.push({ round: step, tool, status: 'completed', latencyMs: toolLatencyMs });
    toolResults.push({ tool, status: 'completed', result: clampedResult, latencyMs: toolLatencyMs });
    emit('tool_result', { step, tool, latencyMs: toolLatencyMs, resultKeys: Object.keys(clampedResult || {}).slice(0, 5) });

    // After a tool executes, ask Ollama to synthesize the answer (or request
    // another tool in the next iteration).
    const synthPacket = buildSynthesisPacket({
      question,
      conversationState,
      evidence,
      toolObservations: toolResults,
      rules
    });
    contextTokens = Math.max(contextTokens, synthPacket.estimatedTokens);
    emit('synthesis_call', { step, model: selectedModel, contextTokens: synthPacket.estimatedTokens });

    const synthRemaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    const synthTimeout = Math.min(STEP_TIMEOUT_MS, synthRemaining);
    const synthResult = await synthesisStep({ model: selectedModel, packet: synthPacket, timeoutMs: synthTimeout });
    totalOllamaLatencyMs += synthResult.latencyMs;

    if (!synthResult.ok) {
      emit('synthesis_failed', { step, error: synthResult.error, latencyMs: synthResult.latencyMs });
      // Continue to next iteration (may try another tool) or break at step limit
      continue;
    }

    emit('synthesis_result', { step, latencyMs: synthResult.latencyMs, answerPreview: synthResult.answer.slice(0, 80) });

    const sourceText = buildSourceText(evidence, toolResults);
    const validation = validateAnswer(synthResult.answer, sourceText, question, knowledge);
    emit('validation', { verdict: validation.verdict, reasons: validation.reasons });

    if (validation.valid) {
      emit('agent_complete', { step, totalLatencyMs: Date.now() - startedAt, ollamaLatencyMs: totalOllamaLatencyMs, outcome: 'accepted' });
      return {
        reply: validation.cleaned,
        proseSource: 'MODEL_GENERATION',
        provider: 'ollama-agent',
        model: selectedModel,
        steps,
        toolResults,
        events,
        contextTokens,
        latencyMs: Date.now() - startedAt,
        fallback: false,
        validation,
        outcome: 'accepted'
      };
    }

    emit('synthesis_rejected', { step, reasons: validation.reasons, rejectionDetails: validation.rejectionDetails });

    // Validation-guided repair: ONE targeted retry with rejection reasons.
    // This is where generative AI can correct itself cheaply.
    if (validation.rejectionDetails && validation.rejectionDetails.length > 0) {
      const repairPacket = buildRepairPacket({
        question,
        conversationState,
        evidence,
        toolObservations: toolResults,
        rejectionDetails: validation.rejectionDetails
      });
      contextTokens = Math.max(contextTokens, repairPacket.estimatedTokens);
      emit('repair_call', { step, contextTokens: repairPacket.estimatedTokens, reasons: validation.rejectionDetails.map(r => r.reason) });

      const repairRemaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      const repairTimeout = Math.min(STEP_TIMEOUT_MS, repairRemaining);
      const repairResult = await repairStep({ model: selectedModel, packet: repairPacket, timeoutMs: repairTimeout });
      totalOllamaLatencyMs += repairResult.latencyMs;

      if (repairResult.ok) {
        const repairValidation = validateAnswer(repairResult.answer, sourceText, question, knowledge);
        emit('repair_result', { step, verdict: repairValidation.verdict, reasons: repairValidation.reasons, latencyMs: repairResult.latencyMs });
        if (repairValidation.valid) {
          emit('agent_complete', { step, totalLatencyMs: Date.now() - startedAt, ollamaLatencyMs: totalOllamaLatencyMs, outcome: 'repaired' });
          return {
            reply: repairValidation.cleaned,
            proseSource: 'MODEL_GENERATION',
            provider: 'ollama-agent',
            model: selectedModel,
            steps,
            toolResults,
            events,
            contextTokens,
            latencyMs: Date.now() - startedAt,
            fallback: false,
            validation: repairValidation,
            outcome: 'repaired'
          };
        }
      } else {
        emit('repair_failed', { step, error: repairResult.error, latencyMs: repairResult.latencyMs });
      }
    }

    // If validation failed on the last step, we'll break out of the loop and
    // the caller falls back to the deterministic grounded answer.
  }

  emit('agent_fallback', { reason: 'loop_exhausted_or_validation_failed', totalLatencyMs: Date.now() - startedAt, ollamaLatencyMs: totalOllamaLatencyMs });
  return {
    reply: null,
    proseSource: 'TECHNICAL_ERROR',
    provider: 'ollama-agent',
    model: selectedModel,
    steps,
    toolResults,
    events,
    contextTokens,
    latencyMs: Date.now() - startedAt,
    fallback: true,
    validation: null,
    outcome: 'fallback'
  };
}

function buildSourceText(evidence, toolResults) {
  const parts = [];
  for (const item of (evidence || [])) {
    parts.push(JSON.stringify(item));
  }
  for (const tr of (toolResults || [])) {
    parts.push(JSON.stringify(tr.result));
  }
  return parts.join(' ');
}

// Probe: is the local model reachable and can it produce structured JSON?
// Used by the health endpoint and the no-cloud test.
async function probeAgent(model) {
  const startedAt = Date.now();
  const probeTimeoutMs = parseInt(process.env.OLLAMA_PROBE_TIMEOUT_MS || '5000', 10);
  const probe = await router.generate(model || router.agentModel(), [
    { role: 'system', content: 'Return JSON: {"ok":true}' },
    { role: 'user', content: 'Reply with the JSON.' }
  ], { timeoutMs: probeTimeoutMs, numPredict: 16, format: 'json', temperature: 0 });
  const parsed = probe.ok ? parseDecision(probe.text) : null;
  return {
    reachable: probe.ok,
    model: probe.model,
    latencyMs: Date.now() - startedAt,
    structuredOk: !!(parsed && parsed.ok === true),
    error: probe.error
  };
}

module.exports = {
  MAX_STEPS,
  STEP_TIMEOUT_MS,
  TOTAL_BUDGET_MS,
  runAgentLoop,
  probeAgent,
  parseDecision,
  clampArgs,
  clampObservation,
  allToolNames
};
