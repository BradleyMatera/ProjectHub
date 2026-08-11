'use strict';

// Context Engineering for Scout's local model.
//
// Small models degrade when fed mountains of irrelevant text. This module builds
// compact, turn-relevant context packets: only the intent, conversation state,
// retrieved evidence, available tools, and grounding rules the model needs for
// THIS turn. Everything else is dropped.
//
// The packet is a plain string (system prompt) plus a compact JSON observation
// block for tool results. We measure input characters and estimate tokens so the
// agent loop and frontend can report real context sizes.

const { TOOL_DEFINITIONS } = require('./agent-tools');

const ESTIMATED_CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / ESTIMATED_CHARS_PER_TOKEN);
}

function truncateForContext(text, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars - 1).trimEnd() + '…';
}

// Compact evidence rendering: only the fields the model needs, deduplicated.
function renderEvidenceItem(item, maxChars = 240) {
  if (!item) return '';
  const parts = [];
  const kind = item.kind || item.type || 'evidence';
  const title = item.name || item.title || item.role || item.group || '';
  if (title) parts.push(`${kind}:${title}`);
  if (item.description) parts.push(truncateForContext(item.description, 160));
  if (Array.isArray(item.tech)) parts.push(`tech:${item.tech.slice(0, 6).join(',')}`);
  if (Array.isArray(item.skills)) parts.push(`skills:${item.skills.slice(0, 6).join(',')}`);
  if (item.summary) parts.push(truncateForContext(item.summary, 120));
  if (item.category) parts.push(`cat:${item.category}`);
  if (item.url) parts.push(`url:${item.url}`);
  if (item.evidenceScore) parts.push(`score:${item.evidenceScore}`);
  return truncateForContext(parts.join(' | '), maxChars);
}

function renderEvidenceList(items, maxItems = 5, maxCharsEach = 240) {
  const seen = new Set();
  const out = [];
  for (const item of (items || [])) {
    const key = renderEvidenceItem(item, maxCharsEach);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= maxItems) break;
  }
  return out;
}

// Compact tool definitions: name + one-line description + required params only.
function renderToolCompact(tool) {
  if (!tool?.function) return '';
  const fn = tool.function;
  const required = (fn.parameters?.required || []).join(',');
  const props = Object.entries(fn.parameters?.properties || {})
    .map(([k, v]) => `${k}:${v.type}`)
    .join(',');
  return `${fn.name}(${props}) req[${required}] — ${truncateForContext(fn.description, 120)}`;
}

function renderToolList(toolNames) {
  const allowed = new Set(toolNames || []);
  const defs = TOOL_DEFINITIONS.filter(t => allowed.has(t.function.name));
  return defs.map(renderToolCompact).filter(Boolean);
}

// Build the structured conversation state summary from server-owned state.
// This is what lets the model resolve "that project", "the AWS one", etc.
function renderConversationState(state) {
  if (!state) return 'none';
  const parts = [];
  if (state.currentTopic) parts.push(`topic:${state.currentTopic}`);
  if (state.currentProjects && state.currentProjects.length) parts.push(`projects:${state.currentProjects.slice(0, 3).join(',')}`);
  if (state.currentJob) parts.push(`job:${truncateForContext(state.currentJob, 80)}`);
  if (state.currentCompany) parts.push(`company:${state.currentCompany}`);
  if (state.activeComparison) parts.push(`comparing:${state.activeComparison}`);
  if (state.intent) parts.push(`intent:${state.intent}`);
  if (state.unresolvedReference) parts.push(`unresolved_ref:${truncateForContext(state.unresolvedReference, 60)}`);
  const turns = (state.recentTurns || []).slice(-3);
  if (turns.length) {
    parts.push('recent:' + turns.map(t => `U:${truncateForContext(t.user, 60)}|S:${truncateForContext(t.assistant, 60)}`).join(' // '));
  }
  return parts.length ? parts.join(' | ') : 'none';
}

// Build a context packet for a reasoning/tool-selection turn.
// Returns { systemPrompt, userPrompt, estimatedTokens, evidenceCount, toolsCount, charsDropped }
function buildReasoningPacket({ question, conversationState, evidence, toolNames, rules, phase }) {
  const stateLine = renderConversationState(conversationState);
  const evidenceLines = renderEvidenceList(evidence, 5, 220);
  const toolLines = renderToolList(toolNames);
  const phaseLabel = phase || 'reason';

  const system = [
    `You are Scout, a recruiter assistant for Bradley Matera. You reason in strict JSON.`,
    `PHASE: ${phaseLabel}`,
    `CONVERSATION_STATE: ${stateLine}`,
    evidenceLines.length ? `VERIFIED_EVIDENCE:\n${evidenceLines.map((e, i) => `${i + 1}. ${e}`).join('\n')}` : `VERIFIED_EVIDENCE: none`,
    toolLines.length ? `AVAILABLE_TOOLS:\n${toolLines.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : `AVAILABLE_TOOLS: none`,
    `RULES:`,
    ` ${rules || 'Answer grounded in verified evidence only. Never invent experience, employers, metrics, or years. If a tool is needed, request it. If you have enough evidence, answer directly.'}`,
    `OUTPUT: Return ONLY JSON. Schema: {"action":"tool"|"answer","tool":<name if action=tool>,"arguments":{...},"answer":<text if action=answer>}`
  ].join('\n');

  const user = `User question: ${truncateForContext(question, 300)}`;
  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: estimateTokens(system + user),
    evidenceCount: evidenceLines.length,
    toolsCount: toolLines.length,
    charsDropped: 0
  };
}

// Build a context packet for the final synthesis turn (after tool observations).
function buildSynthesisPacket({ question, conversationState, evidence, toolObservations, rules }) {
  const stateLine = renderConversationState(conversationState);
  const evidenceLines = renderEvidenceList(evidence, 4, 200);
  const obsLines = (toolObservations || []).slice(-3).map((obs, i) => {
    const result = truncateForContext(JSON.stringify(obs.result), 400);
    return `${i + 1}. ${obs.tool} → ${result}`;
  });
  const system = [
    `You are Scout, a recruiter assistant for Bradley Matera. Synthesize a grounded answer from verified evidence and tool results.`,
    `CONVERSATION_STATE: ${stateLine}`,
    evidenceLines.length ? `VERIFIED_EVIDENCE:\n${evidenceLines.map((e, i) => `${i + 1}. ${e}`).join('\n')}` : `VERIFIED_EVIDENCE: none`,
    obsLines.length ? `TOOL_OBSERVATIONS:\n${obsLines.join('\n')}` : `TOOL_OBSERVATIONS: none`,
    `RULES:`,
    ` ${rules || 'Answer the question directly and conversationally in exactly 1-2 sentences. Every factual claim must paraphrase verified evidence or a tool result. Never invent experience, employers, degrees, metrics, or years. Third person (he/his). Do not say "as an AI" or "based on the data". End with punctuation.'}`,
    `OUTPUT: Return ONLY JSON: {"answer":"<1-2 sentence grounded answer>"}`,
    `The answer must be 20-200 characters. Do not include explanations, history, or definitions.`
  ].join('\n');
  const user = `User question: ${truncateForContext(question, 300)}`;
  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: estimateTokens(system + user),
    evidenceCount: evidenceLines.length,
    toolsCount: 0,
    charsDropped: 0
  };
}

// Build a raw (unassisted) prompt for the raw-vs-assisted comparison.
// Minimal context: just the question and a bare persona line.
function buildRawPacket({ question, agentName }) {
  const system = `You are ${agentName || 'Scout'}, a recruiter assistant for Bradley Matera. Answer the recruiter's question about Bradley. Be honest and concise.`;
  const user = truncateForContext(question, 400);
  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: estimateTokens(system + user),
    evidenceCount: 0,
    toolsCount: 0,
    charsDropped: 0
  };
}

module.exports = {
  estimateTokens,
  truncateForContext,
  renderEvidenceItem,
  renderEvidenceList,
  renderToolList,
  renderConversationState,
  buildReasoningPacket,
  buildSynthesisPacket,
  buildRawPacket
};
