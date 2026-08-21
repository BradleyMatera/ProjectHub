'use strict';

// RAG-first Scout agent.
//
// For normal substantive questions the model context is built FIRST from the
// BM25/RRF evidence already retrieved by the server. Deterministic tools may
// still run, but their output is treated as optional enrichment, not the
// primary answer source.

const router = require('./local-model-router');
const { executeAgentTool } = require('./agent-tools');
const { validateAnswer } = require('./grounding-validator');
const { extractCompleteSentences } = require('./local-conversation');
const { resolveReferents } = require('./session-state');
const { buildConversationState, resolveReferent } = require('./conversation-resolver');
const { preRoute, rewriteQuery, formatResponseContract } = require('./lite-agent');
const { buildResponseContract } = require('./response-contract');
const scoutIdentity = require('./scout-identity');
const knowledgeAccess = require('./knowledge-access');

const ESTIMATED_CHARS_PER_TOKEN = 4;
const RAG_MAX_TOKENS = parseInt(process.env.SCOUT_RAG_MAX_TOKENS || '320', 10);
const RAG_TIMEOUT_MS = Math.max(3000, Math.min(parseInt(process.env.SCOUT_RAG_TIMEOUT_MS || '15000', 10), 30000));
const RAG_REPAIR_TIMEOUT_MS = Math.max(2000, Math.min(parseInt(process.env.SCOUT_RAG_REPAIR_TIMEOUT_MS || '8000', 10), 15000));
const RAG_NUM_CTX = parseInt(process.env.SCOUT_RAG_NUM_CTX || '1024', 10);
const RAG_NUM_PREDICT = parseInt(process.env.SCOUT_RAG_NUM_PREDICT || '220', 10);
const RAG_ENABLE_REPAIR = process.env.SCOUT_RAG_ENABLE_REPAIR !== 'false';
const RAG_EVIDENCE_MAX_CHARS = parseInt(process.env.SCOUT_RAG_EVIDENCE_MAX_CHARS || '900', 10);
const RAG_EVIDENCE_MAX_ITEMS = parseInt(process.env.SCOUT_RAG_EVIDENCE_MAX_ITEMS || '8', 10);
const CONTROL_MODES = new Set(['GREETING', 'USER_PROFILE_UPDATE', 'USER_PROFILE_QUERY', 'THANKS', 'FAREWELL', 'HELP', 'CONVERSATIONAL', 'SMALL_TALK', 'REQUEST_TO_SAY', 'CLARIFY_PREVIOUS_ASSISTANT', 'OUT_OF_SCOPE', 'REFUSAL', 'META']);

function estimatedInputTokens(text) {
  const str = String(text || '');
  const words = str.split(/\s+/).filter(Boolean).length;
  const punct = (str.match(/[.,;:!?()[\]{ }"'`/\\@#$%^&*+=|<>~]/g) || []).length;
  return Math.ceil((words * 1.3 + punct * 0.5) * 1.15);
}

function truncate(text, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars - 1).trimEnd() + '…';
}

function dedupeEvidence(evidence) {
  const seen = new Set();
  return evidence.filter(item => {
    const key = `${item.kind || ''}|${item.name || ''}|${(item.description || '').slice(0, 120)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildRagEvidenceText(evidence, maxChars = RAG_EVIDENCE_MAX_CHARS, maxItems = RAG_EVIDENCE_MAX_ITEMS) {
  const tagBoost = {
    identity: 1.6,
    pitch: 1.5,
    summary: 1.5,
    'what-he-does': 1.4,
    'looking-for': 1.4,
    'target-roles': 1.3,
    education: 1.2,
    experience: 1.2,
    skills: 1.1,
    project: 1.1,
    faq: 1.0,
    story: 1.0,
    blog: 1.0,
    source: 1.0,
    boundaries: 0.7,
    'direct-answer': 0.9
  };
  const sorted = [...evidence]
    .filter(e => e && (e.description || e.text))
    .map(e => {
      const boost = tagBoost[e.kind] || tagBoost[e.tag] || 1.0;
      return { ...e, boostedScore: (e.evidenceScore || 0) * boost };
    })
    .sort((a, b) => b.boostedScore - a.boostedScore);
  const deduped = dedupeEvidence(sorted);
  const selected = deduped.slice(0, maxItems);

  let budget = maxChars;
  const parts = [];
  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    const tag = item.kind || item.tag || 'evidence';
    const name = item.name || item.title || '';
    const source = name ? `${tag}:${name}` : tag;
    const text = truncate(item.description || item.text, Math.min(320, Math.floor(budget * 0.6)));
    const formatted = `FACT ${i + 1} [${source}]\n${text}`;
    if (formatted.length > budget) break;
    parts.push(formatted);
    budget -= formatted.length + 2;
  }
  return parts.join('\n\n');
}

function formatToolEnrichment(toolName, toolResult, maxChars) {
  if (!toolResult || toolName === 'no_tool') return '';
  if (toolName === 'search_portfolio') {
    // RAG already covers portfolio search; skip redundant enrichment.
    return '';
  }
  if (toolName === 'compare_projects' && Array.isArray(toolResult.projects)) {
    const lines = toolResult.projects.map(p => `- ${p.name}: ${truncate(p.description || '', 80)}${p.tech?.length ? ` Tech: ${p.tech.slice(0, 4).join(',')}.` : ''}`);
    return truncate(lines.join('\n'), maxChars);
  }
  if (toolName === 'match_role' && toolResult) {
    const parts = [];
    if (toolResult.role) parts.push(`Role: ${toolResult.role}`);
    if (Array.isArray(toolResult.strong)) parts.push(`Strong: ${toolResult.strong.slice(0, 4).map(s => s.skill).join(', ')}`);
    if (Array.isArray(toolResult.partial)) parts.push(`Partial: ${toolResult.partial.slice(0, 4).map(p => p.skill).join(', ')}`);
    if (Array.isArray(toolResult.gaps)) parts.push(`Gaps: ${toolResult.gaps.slice(0, 3).map(g => g.skill).join(', ')}`);
    return truncate(parts.join('. '), maxChars);
  }
  if (toolName === 'get_skill_evidence') {
    const skill = toolResult.skill || 'this technology';
    const evidence = toolResult.evidence || 'unknown';
    const details = (toolResult.details || []).slice(0, 2).map(d => typeof d === 'string' ? d : d.description || d.summary || '').filter(Boolean).join('; ');
    return truncate(`${skill}: ${evidence}${details ? `. ${details}` : ''}`, maxChars);
  }
  if (toolName === 'get_project' && toolResult.found && toolResult.project) {
    const p = toolResult.project;
    const parts = [`Project: ${p.name}`, truncate(p.description || '', 120)];
    if (p.tech?.length) parts.push(`Tech: ${p.tech.slice(0, 6).join(', ')}`);
    return truncate(parts.join('. '), maxChars);
  }
  if (toolName === 'get_candidate_profile' && toolResult.data) {
    return truncate(JSON.stringify(toolResult.data).slice(0, maxChars), maxChars);
  }
  if (toolName === 'build_recruiter_brief' && toolResult) {
    const parts = [];
    if (toolResult.headline) parts.push(`Headline: ${toolResult.headline}`);
    if (Array.isArray(toolResult.topSkills)) parts.push(`Skills: ${toolResult.topSkills.slice(0, 5).map(s => s.skill).join(', ')}`);
    if (Array.isArray(toolResult.topProjects)) parts.push(`Projects: ${toolResult.topProjects.slice(0, 3).map(p => p.name).join(', ')}`);
    return truncate(parts.join('. '), maxChars);
  }
  return truncate(JSON.stringify(toolResult).slice(0, maxChars), maxChars);
}

function buildGuardrails(responseContract, policyContract, question) {
  const rails = [];
  const q = (question || '').toLowerCase();

  if (policyContract?.mode === 'OUT_OF_SCOPE' || policyContract?.mode === 'REFUSAL') {
    rails.push('This question is outside your scope. Decline politely and offer to discuss the candidate\'s professional background.');
  }

  if (policyContract?.answerStance === 'AFFIRM_NEGATION' || responseContract?.answerStance === 'AFFIRM_NEGATION') {
    rails.push('Start your answer with "Yes" to confirm the negation. Do NOT start with "No".');
  }

  if (responseContract?.directAnswer) {
    const da = String(responseContract.directAnswer).toLowerCase();
    if (da === 'yes' || da === 'no' || da === 'unknown') {
      rails.push(`Direct answer stance: ${da}.`);
    }
  }

  if (Array.isArray(responseContract?.forbiddenClaims) && responseContract.forbiddenClaims.length) {
    rails.push(`DO NOT AFFIRM: ${responseContract.forbiddenClaims.slice(0, 5).join('; ')}`);
  }

  if (responseContract?.subIntent === 'FUTURE_CAPABILITY' || /\b(?:learn|future|could he|would he|potential|capable of)\b/i.test(q)) {
    rails.push('This is a future/potential question. Do NOT start with "No". State current relevant skills, then say the subject could learn or grow into the target.');
  }

  if (responseContract?.subIntent === 'NEGATIVE_ASSESSMENT' || /\b(?:weakness|bad at|worst at|weakest at|gap|needs to learn)\b/i.test(q)) {
    if (responseContract?.factState === 'TRUE') {
      rails.push('The verified profile explicitly documents this gap/learning area. State it from FACTS in 1-2 sentences. Do not rank it as a personal weakness unless the question asks.');
    } else {
      rails.push('A documented learning/gap area is not automatically a personal weakness. Do not rank or label a gap as the subject\'s weakness unless explicitly verified.');
    }
  }

  return rails.join('\n');
}

function buildRagPrimaryPacket({ question, ragEvidence, enrichment, guardrails, conversationState, maxTokens }) {
  const budget = (maxTokens || RAG_MAX_TOKENS) * ESTIMATED_CHARS_PER_TOKEN;
  const systemBudget = Math.floor(budget * 0.9);
  const userBudget = Math.floor(budget * 0.1);

  const conversationLines = [];
  const history = conversationState?.recentTurns || [];
  for (const turn of history.slice(-3)) {
    if (turn.user) conversationLines.push(`User: ${turn.user}`);
    if (turn.assistant) conversationLines.push(`Assistant: ${turn.assistant}`);
  }

  const systemLines = [
    `You are ${scoutIdentity.getAssistantName() || 'Scout'}, ${scoutIdentity.getSubjectName()}'s portfolio assistant.`,
    'Answer the user\'s question naturally using ONLY the supplied evidence.',
    'You may synthesize information across multiple evidence items and cite specific project names, technologies, or roles.',
    'If the evidence does not establish a fact, say it is not verified or unknown.',
    'Do not invent employers, technologies, experience, project relationships, dates, current activity, or seniority.',
    'Talk about the candidate in third person (he/his). Never use I/my/me when talking about the subject.',
    'Use natural, complete sentences. For explanatory questions, write 2-4 concise sentences. For direct yes/no questions, start with Yes/No and add one sentence of context when the evidence supports it.',
    'No "as an AI" disclaimers or "would you like" offers.',
    conversationLines.length ? `CONVERSATION:\n${conversationLines.join('\n')}` : '',
    guardrails ? `GUARDRAILS:\n${guardrails}` : '',
    'EVIDENCE:',
    truncate(ragEvidence, systemBudget - 400 - (guardrails?.length || 0) - (conversationLines.length ? 150 : 0)),
    enrichment ? `ENRICHMENT:\n${truncate(enrichment, 250)}` : ''
  ];

  const system = systemLines.filter(line => line !== undefined && line !== '').join('\n\n');
  const user = `Q: ${truncate(question, userBudget - 40)}\nReturn JSON: {"answer":"<your answer>"}`;

  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: estimatedInputTokens(system) + estimatedInputTokens(user)
  };
}

function parseGeneratedAnswer(rawText) {
  let answer = '';
  try {
    const parsed = JSON.parse(rawText);
    answer = String(parsed.answer || '').trim();
  } catch {
    const m = String(rawText).match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) answer = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
  }
  return answer;
}

function isNonFactualReason(reason) {
  const nonFactual = /^(too_short|too_long|too_many_sentences|no_terminal_punctuation|insufficient_content_overlap|ai_slop|leaked_prompt_language|leaked_internal_language|leaked_relation_syntax|generic_vague|generic_filler)$/;
  return nonFactual.test(reason);
}

function filterValidation(validation) {
  const reasons = (validation?.reasons || []).filter(r => !isNonFactualReason(r));
  const hardReasons = (validation?.reasons || []).filter(r => !isNonFactualReason(r));
  return {
    valid: hardReasons.length === 0,
    verdict: hardReasons.length === 0 ? (validation?.verdict === 'supported' ? 'supported' : 'partial') : 'unsupported',
    reasons
  };
}

async function runRagPrimaryAgent({ question, conversationState, evidence, knowledge, sessionId, model, policyContract, deadlineAt, abortSignal }) {
  const startedAt = Date.now();
  const events = [];
  const selectedModel = model || router.agentModel();
  const requestDeadline = deadlineAt || (Date.now() + RAG_TIMEOUT_MS);
  const requestAbort = abortSignal || null;

  function remainingMs() {
    return Math.max(0, requestDeadline - Date.now());
  }

  function attemptTimeout(configuredMax, minimumUsefulBudget = 2000) {
    const remaining = remainingMs();
    if (remaining < minimumUsefulBudget) return 0;
    return Math.min(configuredMax, remaining);
  }

  function emit(type, data) {
    events.push({ ts: Date.now() - startedAt, type, ...data });
  }

  emit('rag_start', { model: selectedModel });

  const isControlTurn = CONTROL_MODES.has(policyContract?.mode);
  if (isControlTurn) {
    // Control turns need tiny, shaped prompts. Reuse the existing lite control path
    // by importing the packet builder from lite-agent and skipping evidence.
    const { buildLitePacket } = require('./lite-agent');
    const controlPacket = buildLitePacket({
      question,
      compressedEvidence: '',
      operation: 'control',
      maxTokens: RAG_MAX_TOKENS,
      structuredFacts: '',
      plan: null,
      planText: '',
      responseContract: policyContract
    });
    const timeout = attemptTimeout(RAG_TIMEOUT_MS, 2000);
    if (timeout === 0) {
      return {
        reply: null,
        proseSource: 'TECHNICAL_ERROR',
        provider: 'scout-rag',
        model: selectedModel,
        fallback: true,
        inferenceUnavailable: true,
        outcome: 'deadline_exceeded',
        events,
        contextTokens: controlPacket.estimatedTokens,
        latencyMs: Date.now() - startedAt,
        generationAttempts: 0,
        generationCalls: [],
        actualProviderCalls: 0,
        operation: 'control',
        steps: [{ type: 'rag_control' }]
      };
    }
    const genResult = await router.generate(selectedModel, [
      { role: 'system', content: controlPacket.systemPrompt },
      { role: 'user', content: controlPacket.userPrompt }
    ], {
      timeoutMs: timeout,
      temperature: 0.25,
      topP: 0.9,
      numPredict: RAG_NUM_PREDICT,
      numCtx: RAG_NUM_CTX,
      format: 'json',
      abortSignal: requestAbort
    });
    const answer = parseGeneratedAnswer(genResult.text || '');
    return {
      reply: answer,
      proseSource: 'MODEL_GENERATION',
      provider: genResult.usage?.provider || router.inferenceProvider || 'unknown',
      model: genResult.model || selectedModel,
      fallback: false,
      outcome: 'control',
      events,
      contextTokens: controlPacket.estimatedTokens,
      latencyMs: Date.now() - startedAt,
      generationAttempts: 1,
      generationCalls: [{
        attemptType: 'PRIMARY',
        provider: genResult.usage?.provider || router.inferenceProvider || 'unknown',
        model: genResult.model || selectedModel,
        inputTokens: genResult.usage?.promptEvalCount ?? null,
        outputTokens: genResult.usage?.evalCount ?? null,
        latencyMs: genResult.latencyMs ?? null,
        ok: genResult.ok,
        accepted: true
      }],
      actualProviderCalls: genResult.ok ? 1 : 0,
      operation: 'control',
      steps: [{ type: 'rag_control' }]
    };
  }

  // 1. Rewrite query using conversation state.
  const stateHistory = conversationState?.recentTurns || conversationState?.history || [];
  const rewrite = rewriteQuery(question, conversationState, knowledge, stateHistory);
  const rewritten = rewrite.rewritten || question;
  emit('rag_rewrite', { rewritten, changed: rewrite.rewritten_, clarificationRequired: !!rewrite.clarificationRequired });

  if (rewrite.clarificationRequired) {
    return {
      reply: null,
      proseSource: 'TECHNICAL_ERROR',
      provider: 'scout-rag',
      model: selectedModel,
      fallback: true,
      clarification: true,
      outcome: 'clarification_required',
      events,
      contextTokens: 0,
      latencyMs: Date.now() - startedAt,
      generationAttempts: 0,
      generationCalls: [],
      actualProviderCalls: 0,
      operation: 'clarification',
      rewritten: rewrite.rewritten_,
      rewrittenQuery: rewritten,
      steps: [{ type: 'rag_clarification' }]
    };
  }

  // 2. Optional deterministic tool enrichment. The tool must NOT replace evidence.
  let enrichment = '';
  let route = null;
  let toolResult = null;
  try {
    route = preRoute(rewritten, conversationState, knowledge);
    if (route.tool && route.tool !== 'no_tool') {
      toolResult = executeAgentTool(route.tool, route.args, knowledge);
      enrichment = formatToolEnrichment(route.tool, toolResult, 300);
      emit('rag_tool', { tool: route.tool, enrichmentChars: enrichment.length });
    }
  } catch (err) {
    emit('rag_tool_error', { error: err.message });
  }

  // 3. Build primary evidence from retrieved BM25/RRF chunks.
  const ragText = buildRagEvidenceText(evidence, RAG_EVIDENCE_MAX_CHARS, RAG_EVIDENCE_MAX_ITEMS);
  emit('rag_evidence', { chunks: evidence.length, selectedChunks: (ragText.match(/FACT \d+ /g) || []).length, chars: ragText.length });

  // 4. Build lightweight guardrails from response contract.
  let responseContract = null;
  let guardrails = '';
  try {
    responseContract = buildResponseContract(rewritten, ragText, knowledge, stateHistory);
    guardrails = buildGuardrails(responseContract, policyContract, rewritten);
    emit('rag_guardrails', { chars: guardrails.length, subIntent: responseContract?.subIntent || null });
  } catch (e) {
    emit('rag_guardrail_error', { error: e.message });
  }

  // 5. Build the model packet.
  const packet = buildRagPrimaryPacket({
    question: rewritten,
    ragEvidence: ragText,
    enrichment,
    guardrails,
    conversationState,
    maxTokens: RAG_MAX_TOKENS
  });
  const contextTokens = packet.estimatedTokens;
  emit('rag_packet', { estimatedInputTokens: contextTokens, chars: packet.systemPrompt.length + packet.userPrompt.length });

  // 6. Primary generation.
  const primaryTimeout = attemptTimeout(RAG_TIMEOUT_MS, 3000);
  if (primaryTimeout === 0) {
    return {
      reply: null,
      proseSource: 'TECHNICAL_ERROR',
      provider: 'scout-rag',
      model: selectedModel,
      fallback: true,
      inferenceUnavailable: true,
      outcome: 'deadline_exceeded',
      events,
      contextTokens,
      latencyMs: Date.now() - startedAt,
      generationAttempts: 0,
      generationCalls: [],
      actualProviderCalls: 0,
      operation: route?.operation || 'search',
      rewritten: rewrite.rewritten_,
      rewrittenQuery: rewritten,
      responseContract,
      steps: [{ type: 'rag_deadline' }]
    };
  }

  const genResult = await router.generate(selectedModel, [
    { role: 'system', content: packet.systemPrompt },
    { role: 'user', content: packet.userPrompt }
  ], {
    timeoutMs: primaryTimeout,
    temperature: 0.25,
    topP: 0.9,
    numPredict: RAG_NUM_PREDICT,
    numCtx: RAG_NUM_CTX,
    format: 'json',
    abortSignal: requestAbort
  });

  if (!genResult.ok) {
    emit('rag_generate_error', { error: genResult.error, latencyMs: genResult.latencyMs });
    return {
      reply: null,
      proseSource: 'TECHNICAL_ERROR',
      provider: genResult.usage?.provider || router.inferenceProvider || 'unknown',
      model: genResult.model || selectedModel,
      fallback: true,
      inferenceUnavailable: true,
      outcome: 'generation_failed',
      events,
      contextTokens,
      latencyMs: Date.now() - startedAt,
      generationAttempts: 1,
      generationCalls: [{
        attemptType: 'PRIMARY',
        provider: genResult.usage?.provider || router.inferenceProvider || 'unknown',
        model: genResult.model || selectedModel,
        inputTokens: genResult.usage?.promptEvalCount ?? null,
        outputTokens: genResult.usage?.evalCount ?? null,
        latencyMs: genResult.latencyMs ?? null,
        ok: genResult.ok,
        accepted: false,
        error: genResult.error
      }],
      actualProviderCalls: genResult.ok ? 1 : 0,
      operation: route?.operation || 'search',
      rewritten: rewrite.rewritten_,
      rewrittenQuery: rewritten,
      responseContract,
      steps: [{ type: 'rag_generation_failed' }]
    };
  }

  let answer = parseGeneratedAnswer(genResult.text || '');
  if (answer.length < 3) {
    emit('rag_generate_short', { raw: (genResult.text || '').slice(0, 200) });
    return {
      reply: null,
      proseSource: 'TECHNICAL_ERROR',
      provider: genResult.usage?.provider || router.inferenceProvider || 'unknown',
      model: genResult.model || selectedModel,
      fallback: true,
      outcome: 'too_short',
      events,
      contextTokens,
      latencyMs: Date.now() - startedAt,
      generationAttempts: 1,
      generationCalls: [{
        attemptType: 'PRIMARY',
        provider: genResult.usage?.provider || router.inferenceProvider || 'unknown',
        model: genResult.model || selectedModel,
        inputTokens: genResult.usage?.promptEvalCount ?? null,
        outputTokens: genResult.usage?.evalCount ?? null,
        latencyMs: genResult.latencyMs ?? null,
        ok: genResult.ok,
        accepted: false,
        error: 'parsed answer too short'
      }],
      actualProviderCalls: 1,
      operation: route?.operation || 'search',
      rewritten: rewrite.rewritten_,
      rewrittenQuery: rewritten,
      responseContract,
      steps: [{ type: 'rag_too_short' }]
    };
  }

  const sentences = extractCompleteSentences(answer, 2);
  if (sentences && sentences.length >= 20) answer = sentences;

  emit('rag_generate_ok', { answerLen: answer.length, answer: answer.slice(0, 120) });

  // 7. Factual validation only.
  const sourceText = `${ragText}\n${enrichment}`;
  const reqGraph = knowledge ? require('./relationship-graph').buildRelationshipGraph(knowledge) : null;
  const validation = validateAnswer(answer, sourceText, rewritten, knowledge, stateHistory, reqGraph, policyContract?.mode || null, responseContract);
  const factualValidation = filterValidation(validation);
  emit('rag_validation', { verdict: validation.verdict, reasons: validation.reasons, factualVerdict: factualValidation.verdict });

  // 8. One factual repair attempt if needed.
  if (!factualValidation.valid && RAG_ENABLE_REPAIR) {
    const repairTimeout = attemptTimeout(RAG_REPAIR_TIMEOUT_MS, 2000);
    if (repairTimeout > 0) {
      const repairPrompt = [
        `You are ${scoutIdentity.getAssistantName() || 'Scout'}. The previous answer had factual problems.`,
        'Rewrite the answer using ONLY the supplied evidence.',
        factualValidation.reasons.map(r => `- ${r}`).join('\n'),
        '',
        'EVIDENCE:',
        truncate(ragText, RAG_EVIDENCE_MAX_CHARS - 200),
        enrichment ? `ENRICHMENT:\n${truncate(enrichment, 200)}` : '',
        '',
        `Q: ${rewritten}\nReturn JSON: {"answer":"<your answer>"}`
      ].filter(Boolean).join('\n\n');

      const repairResult = await router.generate(selectedModel, [
        { role: 'system', content: repairPrompt },
        { role: 'user', content: 'Rewrite the answer.' }
      ], {
        timeoutMs: repairTimeout,
        temperature: 0.2,
        topP: 0.85,
        numPredict: RAG_NUM_PREDICT,
        numCtx: RAG_NUM_CTX,
        format: 'json',
        abortSignal: requestAbort
      });

      if (repairResult.ok) {
        const repaired = parseGeneratedAnswer(repairResult.text || '');
        const repairedValidation = validateAnswer(repaired, sourceText, rewritten, knowledge, stateHistory, reqGraph, policyContract?.mode || null, responseContract);
        const repairedFactual = filterValidation(repairedValidation);
        if (repaired.length >= 3 && (repairedFactual.valid || repairedFactual.reasons.length < factualValidation.reasons.length)) {
          answer = repaired;
          emit('rag_repair_ok', { answerLen: answer.length, verdict: repairedFactual.verdict });
        } else {
          emit('rag_repair_reject', { reasons: repairedFactual.reasons });
        }
      } else {
        emit('rag_repair_error', { error: repairResult.error });
      }
    }
  }

  return {
    reply: answer,
    proseSource: 'MODEL_GENERATION',
    provider: genResult.usage?.provider || router.inferenceProvider || 'unknown',
    model: genResult.model || selectedModel,
    fallback: false,
    outcome: 'accepted',
    events,
    contextTokens,
    latencyMs: Date.now() - startedAt,
    generationAttempts: 1 + (factualValidation.valid ? 0 : 1),
    generationCalls: [{
      attemptType: 'PRIMARY',
      provider: genResult.usage?.provider || router.inferenceProvider || 'unknown',
      model: genResult.model || selectedModel,
      inputTokens: genResult.usage?.promptEvalCount ?? null,
      outputTokens: genResult.usage?.evalCount ?? null,
      latencyMs: genResult.latencyMs ?? null,
      ok: genResult.ok,
      accepted: true
    }],
    actualProviderCalls: 1,
    operation: route?.operation || 'search',
    toolResults: route?.tool ? [{ tool: route.tool, result: toolResult }] : [],
    rewritten: rewrite.rewritten_,
    rewrittenQuery: rewritten,
    validation: factualValidation,
    responseContract,
    steps: [{ type: 'rag_primary' }]
  };
}

module.exports = { runRagPrimaryAgent, buildRagEvidenceText, buildRagPrimaryPacket, buildGuardrails };
