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
const RAG_MAX_TOKENS = parseInt(process.env.SCOUT_RAG_MAX_TOKENS || '400', 10);
const RAG_TIMEOUT_MS = Math.max(3000, Math.min(parseInt(process.env.SCOUT_RAG_TIMEOUT_MS || '15000', 10), 30000));
const RAG_REPAIR_TIMEOUT_MS = Math.max(2000, Math.min(parseInt(process.env.SCOUT_RAG_REPAIR_TIMEOUT_MS || '8000', 10), 15000));
const RAG_NUM_CTX = parseInt(process.env.SCOUT_RAG_NUM_CTX || '1024', 10);
const RAG_NUM_PREDICT = parseInt(process.env.SCOUT_RAG_NUM_PREDICT || '220', 10);
const RAG_ENABLE_REPAIR = process.env.SCOUT_RAG_ENABLE_REPAIR !== 'false';
const RAG_EVIDENCE_MAX_CHARS = parseInt(process.env.SCOUT_RAG_EVIDENCE_MAX_CHARS || '1100', 10);
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

// Safe telemetry identifiers for evidence. Never include raw description text in
// the response payload — the UI only needs to show counts and short tags.
function evidenceToIdentifiers(evidence, limit) {
  return evidence.slice(0, limit || evidence.length).map((item, i) => ({
    kind: item.kind || 'evidence',
    tag: item.kind || 'evidence',
    name: item.name || '',
    id: `${item.kind || 'evidence'}-${i + 1}`,
    score: item.evidenceScore || 0
  }));
}

function buildRagEvidenceText(evidence, maxChars = RAG_EVIDENCE_MAX_CHARS, maxItems = RAG_EVIDENCE_MAX_ITEMS) {
  const tagBoost = {
    identity: 1.1,
    pitch: 1.1,
    summary: 1.1,
    'what-he-does': 1.05,
    'looking-for': 1.05,
    'target-roles': 1.05,
    education: 1.1,
    experience: 1.1,
    skills: 1.1,
    project: 1.1,
    faq: 1.05,
    story: 1.0,
    blog: 0.9,
    source: 0.85,
    boundaries: 0.9,
    'direct-answer': 1.5,
    'scout-runtime': 1.5,
    'scout-cost': 1.25,
    contact: 1.5
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
    const isBoundary = ['boundaries', 'direct-answer'].includes(tag);
    const perItemMax = Math.min(isBoundary ? 180 : 320, Math.floor(budget * 0.6));
    const text = truncate(item.description || item.text, perItemMax);
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

function buildGuardrails(responseContract, policyContract, question, knowledge) {
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

  if (responseContract?.boundary) {
    rails.push(`LIMITATION: ${responseContract.boundary}`);
  }

  if (Array.isArray(responseContract?.responseShape?.requirements) && responseContract.responseShape.requirements.length) {
    rails.push(`RESPONSE SHAPE: ${responseContract.responseShape.requirements.slice(0, 3).join('; ')}`);
  }

  if (responseContract?.subIntent === 'META_CAPABILITIES' || responseContract?.subIntent === 'META') {
    rails.push(`The user is asking what Scout can do. Start with "I can answer questions about..." and list these topics: ${scoutIdentity.getSubjectName()}'s projects, skills, work experience, education, certifications, career goals, public contact information, and Scout's own runtime. Do not claim unrelated AI abilities or general knowledge.`);
  }

  if (responseContract?.subIntent === 'CONTACT') {
    const id = knowledge?.identity || {};
    const contactMethods = [];
    if (id.email) contactMethods.push(`email ${id.email}`);
    if (id.phone) contactMethods.push(`phone ${id.phone}`);
    if (id.linkedInUrl) contactMethods.push(`LinkedIn ${id.linkedInUrl}`);
    if (id.gitHubUrl) contactMethods.push(`GitHub ${id.gitHubUrl}`);
    if (id.portfolioUrl) contactMethods.push(`portfolio ${id.portfolioUrl}`);
    if (contactMethods.length) {
      rails.push(`PUBLIC CONTACT METHODS (from verified profile): ${contactMethods.join(', ')}. Your answer MUST list these methods.`);
    } else {
      rails.push('List the public contact methods from the facts (email, LinkedIn, GitHub, portfolio, public phone). Do not invent contact methods or provide private/home contact information.');
    }
  }

  if (responseContract?.subIntent === 'JOB_FIT' || responseContract?.subIntent === 'RECRUITER_RECOMMENDATION') {
    rails.push('Ground the answer in project evidence and skills. Do not invent a job title, employer, employment dates, or seniority that are not in the verified facts.');
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

function buildRagPrimaryPacket({ question, ragEvidence, enrichment, guardrails, conversationState, maxTokens, responseContract }) {
  const budget = (maxTokens || RAG_MAX_TOKENS) * ESTIMATED_CHARS_PER_TOKEN;
  const systemBudget = Math.floor(budget * 0.9);
  const userBudget = Math.floor(budget * 0.1);

  const conversationLines = [];
  const history = conversationState?.recentTurns || [];
  for (const turn of history.slice(-3)) {
    if (turn.user) conversationLines.push(`User: ${turn.user}`);
    if (turn.assistant) conversationLines.push(`Assistant: ${turn.assistant}`);
  }

  const isMeta = responseContract?.intent === 'META' || String(responseContract?.subIntent || '').startsWith('META_');
  const subjectName = scoutIdentity.getSubjectName() || 'the candidate';
  const systemLines = isMeta ? [
    `You are ${scoutIdentity.getAssistantName() || 'Scout'}, ${subjectName}'s portfolio assistant.`,
    'The user is asking about YOU (Scout). Answer as yourself, using "I" or "my" where natural. The evidence below is about Scout\'s runtime, scope, model, and hosting — it is NOT about the candidate.',
    'Use only the supplied evidence. Synthesize across the runtime/scope facts. If a fact is not established, say unknown or not verified.',
    'Do not claim to be a general-purpose assistant. Do not describe the candidate as if he uses these systems.',
    'Answer in natural, complete sentences — not lists or fragments. For explanatory questions, write 2-4 concise sentences.',
    'EXAMPLE (do not copy this text — it is a format template only):\nEVIDENCE: FACT 1 [scout-runtime] <runtime fact>.\nQ: What can you do?\nA: {"answer": "<a 2-4 sentence answer about Scout from the evidence, using I/my>"}',
    conversationLines.length ? `CONVERSATION:\n${conversationLines.join('\n')}` : '',
    guardrails ? `GUARDRAILS:\n${guardrails}` : '',
    'EVIDENCE:',
    truncate(ragEvidence, systemBudget - 450 - (guardrails?.length || 0) - (conversationLines.length ? 150 : 0)),
    enrichment ? `ENRICHMENT:\n${truncate(enrichment, 200)}` : ''
  ] : [
    `You are ${scoutIdentity.getAssistantName() || 'Scout'}, ${subjectName}'s portfolio assistant.`,
    'Use only the supplied evidence. Synthesize across facts and cite project/technology names. If a fact is not established, say unknown or not verified. Never invent employers, experience, dates, roles, or seniority.',
    'Never attribute a technology to a project unless the evidence explicitly says that project uses it. When describing the subject\'s skills, say he has used or knows the technology; do NOT say he used it "in [Project]" unless the evidence explicitly links the skill to that project.',
    'Speak about the subject in third person (he/his); never use I/my/me. Answer in natural, complete sentences — not lists or fragments. For explanatory questions, write 2-4 concise sentences. For yes/no questions, start with Yes/No, then add one sentence of evidence.',
    'EXAMPLE (do not copy this text — it is a format template only):\nEVIDENCE: FACT 1 [identity] <identity fact>. FACT 2 [pitch] <pitch fact>.\nQ: <example question>\nA: {"answer": "<a 2-4 sentence answer drawn only from the evidence>"}',
    conversationLines.length ? `CONVERSATION:\n${conversationLines.join('\n')}` : '',
    guardrails ? `GUARDRAILS:\n${guardrails}` : '',
    'EVIDENCE:',
    truncate(ragEvidence, systemBudget - 450 - (guardrails?.length || 0) - (conversationLines.length ? 150 : 0)),
    enrichment ? `ENRICHMENT:\n${truncate(enrichment, 200)}` : ''
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
  const text = String(rawText || '').trim();
  if (!text) return answer;

  // Prefer the requested JSON envelope.
  try {
    const parsed = JSON.parse(text);
    answer = String(parsed.answer || '').trim();
    if (answer) return answer;
  } catch { /* fall through */ }

  // Regex extraction for JSON-like snippets.
  const m = text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    answer = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
    if (answer) return answer;
  }

  // Final fallback: if the model ignored JSON and wrote prose, treat the
  // returned text as the answer. Strip obvious scaffolding lines.
  answer = text
    .replace(/\{[\s\S]*?\}/g, '')
    .replace(/Return JSON:\s*\{[^}]*\}/gi, '')
    .replace(/^\s*["']?answer["']?\s*[:=]\s*/im, '')
    .replace(/^[\n\r]+|[\n\r]+$/g, '')
    .trim();

  // Remove leading Q: / A: scaffolding the model may have echoed.
  const lines = answer.split(/\r?\n/);
  if (lines.length >= 2 && /^Q:\s*/i.test(lines[0]) && /^A:\s*/i.test(lines[1])) {
    lines[1] = lines[1].replace(/^A:\s*/i, '').trim();
    answer = lines.slice(1).join(' ').trim();
  } else if (/^A:\s*/i.test(answer)) {
    answer = answer.replace(/^A:\s*/i, '').trim();
  }

  // If stripping removed everything, return the original text.
  if (!answer) answer = text;
  return answer;
}

function isNonFactualReason(reason) {
  const nonFactual = /^(too_short|too_long|too_many_sentences|no_terminal_punctuation|insufficient_content_overlap|ai_slop|leaked_prompt_language|leaked_internal_language|leaked_relation_syntax|generic_vague|generic_filler|not_relevant_to_question)$/;
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

  const forceSubstantive = /\b(?:bradley|matera|recruiter|portfolio|project|experience|skill|role|job|summary|developer|engineer)\b/i.test(question);
  // META asks about Scout itself (runtime, model, cost, caps) and should still be evidence-grounded.
  const isControlTurn = (CONTROL_MODES.has(policyContract?.mode) && policyContract?.mode !== 'META') && !forceSubstantive;
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
        attemptIndex: 0,
        attemptType: 'PRIMARY',
        provider: genResult.usage?.provider || router.inferenceProvider || 'unknown',
        model: genResult.model || selectedModel,
        inputTokens: genResult.usage?.promptEvalCount ?? null,
        outputTokens: genResult.usage?.evalCount ?? null,
        actualNeurons: genResult.usage?.actualNeurons ?? null,
        estimatedNeurons: genResult.usage?.estimatedNeurons ?? null,
        latencyMs: genResult.latencyMs ?? null,
        ok: genResult.ok,
        accepted: true
      }],
      actualProviderCalls: 1,
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
    guardrails = buildGuardrails(responseContract, policyContract, rewritten, knowledge);
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
    maxTokens: RAG_MAX_TOKENS,
    responseContract
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
      steps: [{ type: 'rag_deadline' }],
      retrievalCandidates: evidenceToIdentifiers(evidence, 10)
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
    abortSignal: requestAbort
  });

  const primaryProvider = genResult.usage?.provider || router.inferenceProvider || 'unknown';
  const primaryModel = genResult.model || selectedModel;

  function buildCallRecord(attemptIndex, attemptType, result, accepted, validationReasons, errorOverride) {
    const usage = result?.usage || {};
    return {
      attemptIndex,
      attemptType,
      provider: usage.provider || primaryProvider,
      model: result?.model || primaryModel,
      inputTokens: usage.promptEvalCount ?? null,
      outputTokens: usage.evalCount ?? null,
      actualNeurons: usage.actualNeurons ?? null,
      estimatedNeurons: usage.estimatedNeurons ?? null,
      latencyMs: result?.latencyMs ?? null,
      ok: result?.ok ?? false,
      accepted: Boolean(accepted),
      validationReasons: Array.isArray(validationReasons) ? validationReasons : [],
      error: errorOverride || result?.error || null
    };
  }

  const generationCalls = [buildCallRecord(0, 'PRIMARY', genResult, false, [], null)];

  if (!genResult.ok) {
    emit('rag_generate_error', { error: genResult.error, latencyMs: genResult.latencyMs });
    return {
      reply: null,
      proseSource: 'TECHNICAL_ERROR',
      provider: primaryProvider,
      model: primaryModel,
      fallback: true,
      inferenceUnavailable: true,
      outcome: 'generation_failed',
      events,
      contextTokens,
      latencyMs: Date.now() - startedAt,
      generationAttempts: 1,
      generationCalls,
      actualProviderCalls: generationCalls.length,
      operation: route?.operation || 'search',
      rewritten: rewrite.rewritten_,
      rewrittenQuery: rewritten,
      responseContract,
      steps: [{ type: 'rag_generation_failed' }],
      retrievalCandidates: evidenceToIdentifiers(evidence, 10)
    };
  }

  let answer = parseGeneratedAnswer(genResult.text || '');
  if (answer.length < 3) {
    generationCalls[0].error = 'parsed answer too short';
    emit('rag_generate_short', { raw: (genResult.text || '').slice(0, 200) });
    return {
      reply: null,
      proseSource: 'TECHNICAL_ERROR',
      provider: primaryProvider,
      model: primaryModel,
      fallback: true,
      outcome: 'too_short',
      events,
      contextTokens,
      latencyMs: Date.now() - startedAt,
      generationAttempts: 1,
      generationCalls,
      actualProviderCalls: generationCalls.length,
      operation: route?.operation || 'search',
      rewritten: rewrite.rewritten_,
      rewrittenQuery: rewritten,
      responseContract,
      steps: [{ type: 'rag_too_short' }],
      retrievalCandidates: evidenceToIdentifiers(evidence, 10)
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
  generationCalls[0].validationReasons = factualValidation.reasons || [];
  emit('rag_validation', { verdict: validation.verdict, reasons: validation.reasons, factualVerdict: factualValidation.verdict });

  // 8. One factual repair attempt if the primary is factually invalid.
  let finalAnswer = null;
  let finalValidation = { valid: false, verdict: 'unsupported', reasons: [] };
  let finalProseSource = 'TECHNICAL_ERROR';
  let finalOutcome = 'validation_failed';
  let steps = [{ type: 'rag_primary' }];
  let rawRepair = null;

  if (factualValidation.valid) {
    finalAnswer = answer;
    finalValidation = factualValidation;
    finalProseSource = 'MODEL_GENERATION';
    finalOutcome = 'accepted';
    generationCalls[0].accepted = true;
  } else if (RAG_ENABLE_REPAIR) {
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
        abortSignal: requestAbort
      });

      generationCalls.push(buildCallRecord(1, 'FACTUAL_REPAIR', repairResult, false, [], null));

      if (repairResult.ok) {
        const repaired = parseGeneratedAnswer(repairResult.text || '');
        if (repaired.length >= 3) {
          rawRepair = repaired;
          const repairedValidation = validateAnswer(repaired, sourceText, rewritten, knowledge, stateHistory, reqGraph, policyContract?.mode || null, responseContract);
          const repairedFactual = filterValidation(repairedValidation);
          generationCalls[1].validationReasons = repairedFactual.reasons || [];
          if (repairedFactual.valid) {
            finalAnswer = repaired;
            finalValidation = repairedFactual;
            finalProseSource = 'MODEL_GENERATION';
            finalOutcome = 'accepted';
            generationCalls[1].accepted = true;
            steps = [{ type: 'rag_repair' }];
            emit('rag_repair_ok', { answerLen: finalAnswer.length, verdict: repairedFactual.verdict });
          } else {
            finalValidation = repairedFactual;
            generationCalls[1].accepted = false;
            emit('rag_repair_reject', { reasons: repairedFactual.reasons });
          }
        } else {
          generationCalls[1].error = 'parsed repair answer too short';
          finalValidation = { valid: false, verdict: 'unsupported', reasons: ['repair_answer_too_short'] };
          emit('rag_repair_short', { raw: (repairResult.text || '').slice(0, 200) });
        }
      } else {
        finalValidation = { valid: false, verdict: 'unsupported', reasons: [`repair_generation_failed:${repairResult.error || 'unknown'}`] };
        generationCalls[1].accepted = false;
        emit('rag_repair_error', { error: repairResult.error });
      }
    } else {
      finalValidation = factualValidation;
      emit('rag_repair_skipped', { reason: 'deadline' });
    }
  } else {
    finalValidation = factualValidation;
  }

  if (!finalAnswer) {
    return {
      reply: null,
      proseSource: 'TECHNICAL_ERROR',
      provider: primaryProvider,
      model: primaryModel,
      fallback: true,
      inferenceUnavailable: true,
      outcome: finalOutcome,
      events,
      contextTokens,
      latencyMs: Date.now() - startedAt,
      generationAttempts: generationCalls.length,
      generationCalls,
      actualProviderCalls: generationCalls.length,
      operation: route?.operation || 'search',
      toolResults: route?.tool ? [{ tool: route.tool, result: toolResult }] : [],
      rewritten: rewrite.rewritten_,
      rewrittenQuery: rewritten,
      validation: finalValidation,
      responseContract,
      steps,
      retrievalCandidates: evidenceToIdentifiers(evidence, 10),
      selectedEvidence: evidenceToIdentifiers(evidence, RAG_EVIDENCE_MAX_ITEMS),
      toolEnrichment: enrichment,
      rawPrimary: answer,
      rawRepair
    };
  }

  return {
    reply: finalAnswer,
    proseSource: finalProseSource,
    provider: primaryProvider,
    model: primaryModel,
    fallback: false,
    outcome: finalOutcome,
    events,
    contextTokens,
    latencyMs: Date.now() - startedAt,
    generationAttempts: generationCalls.length,
    generationCalls,
    actualProviderCalls: generationCalls.length,
    operation: route?.operation || 'search',
    toolResults: route?.tool ? [{ tool: route.tool, result: toolResult }] : [],
    rewritten: rewrite.rewritten_,
    rewrittenQuery: rewritten,
    validation: finalValidation,
    responseContract,
    steps,
    retrievalCandidates: evidenceToIdentifiers(evidence, 10),
    selectedEvidence: evidenceToIdentifiers(evidence, RAG_EVIDENCE_MAX_ITEMS),
    toolEnrichment: enrichment,
    rawPrimary: answer,
    rawRepair
  };
}

module.exports = { runRagPrimaryAgent, buildRagEvidenceText, buildRagPrimaryPacket, buildGuardrails, parseGeneratedAnswer, evidenceToIdentifiers };
