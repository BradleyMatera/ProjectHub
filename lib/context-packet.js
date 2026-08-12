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
const { getPersonaLine, getConversationRules, getAssistantName, getSubjectName } = require('./scout-identity');
const { buildCompactProfileSummary } = require('./profile-summary');

const ESTIMATED_CHARS_PER_TOKEN = 4;

// Context packet size limits — configurable for low-RAM targets (e2-micro).
// The e2-micro processes prompts at ~70 tokens/second, so a 900-token packet
// takes 13+ seconds per step. Reducing evidence items and character limits
// keeps the packet under 400 tokens for reliable sub-5-second response.
const EVIDENCE_MAX_ITEMS = parseInt(process.env.SCOUT_EVIDENCE_MAX_ITEMS || '5', 10);
const EVIDENCE_MAX_CHARS = parseInt(process.env.SCOUT_EVIDENCE_MAX_CHARS || '220', 10);
const SYNTHESIS_EVIDENCE_MAX_ITEMS = parseInt(process.env.SCOUT_SYNTHESIS_EVIDENCE_MAX_ITEMS || '4', 10);
const SYNTHESIS_EVIDENCE_MAX_CHARS = parseInt(process.env.SCOUT_SYNTHESIS_EVIDENCE_MAX_CHARS || '200', 10);
const TOOL_OBS_MAX_CHARS = parseInt(process.env.SCOUT_TOOL_OBS_MAX_CHARS || '400', 10);

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

// Compact tool definitions with explicit "use when" guidance for small models.
// The key insight: small models need to see WHEN to use each tool, not just
// what it does. We add a short "use_when" hint to each tool definition.
const TOOL_USE_HINTS = {
  search_portfolio: 'USE FOR: broad discovery, "what has he done", "show me things", open-ended questions',
  get_project: 'USE FOR: one named project, "tell me about X", "what is X"',
  compare_projects: 'USE FOR: comparing 2+ named projects, "compare X and Y", "which is better"',
  match_role: 'USE FOR: job fit, "does he fit this role", pasted job description, requirements gap',
  get_candidate_profile: 'USE FOR: profile sections, "skills", "education", "experience", "certifications"',
  get_skill_evidence: 'USE FOR: "does he know X", "has he used X", evidence for a specific technology',
  build_recruiter_brief: 'USE FOR: "give me a brief", "summarize this candidate", recruiter summary'
};

function renderToolCompact(tool) {
  if (!tool?.function) return '';
  const fn = tool.function;
  const required = (fn.parameters?.required || []).join(',');
  const props = Object.entries(fn.parameters?.properties || {})
    .map(([k, v]) => `${k}:${v.type}`)
    .join(',');
  const hint = TOOL_USE_HINTS[fn.name] || '';
  return `${fn.name}(${props}) req[${required}] — ${truncateForContext(fn.description, 100)} ${hint}`;
}

function renderToolList(toolNames) {
  const allowed = new Set(toolNames || []);
  const defs = TOOL_DEFINITIONS.filter(t => allowed.has(t.function.name));
  return defs.map(renderToolCompact).filter(Boolean);
}

// Build the structured conversation state summary from server-owned state.
// This is what lets the model resolve "that project", "the AWS one", etc.
// We render it as compact JSON-like text so the model can parse it easily.
function renderConversationState(state) {
  if (!state) return '{}';
  const parts = [];
  if (state.currentTopic) parts.push(`"topic":"${state.currentTopic}"`);
  if (state.currentProjects && state.currentProjects.length) {
    parts.push(`"projects":[${state.currentProjects.slice(0, 3).map(p => `"${p}"`).join(',')}]`);
  }
  if (state.currentJob) parts.push(`"job":"${truncateForContext(state.currentJob, 80)}"`);
  if (state.currentCompany) parts.push(`"company":"${state.currentCompany}"`);
  if (state.activeComparison && Array.isArray(state.activeComparison) && state.activeComparison.length) {
    parts.push(`"comparing":[${state.activeComparison.map(p => `"${p}"`).join(',')}]`);
  }
  if (state.intent) parts.push(`"intent":"${state.intent}"`);
  if (state.unresolvedReference) parts.push(`"ref":"${truncateForContext(state.unresolvedReference, 60)}"`);
  const turns = (state.recentTurns || []).slice(-3);
  if (turns.length) {
    parts.push(`"recent":[${turns.map(t => `{"u":"${truncateForContext(t.user, 50)}","s":"${truncateForContext(t.assistant, 50)}"}`).join(',')}]`);
  }
  return `{${parts.join(',')}}`;
}

// Build a context packet for a reasoning/tool-selection turn.
// Returns { systemPrompt, userPrompt, estimatedTokens, evidenceCount, toolsCount, charsDropped }
function buildReasoningPacket({ question, conversationState, evidence, toolNames, rules, phase, toolHint }) {
  const stateJson = renderConversationState(conversationState);
  const evidenceLines = renderEvidenceList(evidence, EVIDENCE_MAX_ITEMS, EVIDENCE_MAX_CHARS);
  const toolLines = renderToolList(toolNames);
  const phaseLabel = phase || 'reason';
  const personaLine = getPersonaLine();

  const system = [
    `${personaLine} You reason in strict JSON.`,
    `PHASE: ${phaseLabel}`,
    `CONVERSATION_STATE: ${stateJson}`,
    evidenceLines.length ? `VERIFIED_EVIDENCE:\n${evidenceLines.map((e, i) => `${i + 1}. ${e}`).join('\n')}` : `VERIFIED_EVIDENCE: none`,
    toolLines.length ? `AVAILABLE_TOOLS:\n${toolLines.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : `AVAILABLE_TOOLS: none`,
    toolHint ? `SUGGESTED_TOOL: ${toolHint} (you may choose a different tool if better)` : `TOOL_GUIDANCE: Request a tool when the question needs specific verified data. Prefer the most specific tool.`,
    `REFERENCE_RULES:`,
    ` - "that", "it", "the first one" = refer to CONVERSATION_STATE.projects or recent turns`,
    ` - "the backend" = the backend of the project in CONVERSATION_STATE.projects`,
    ` - "compare that to X" = compare CONVERSATION_STATE.projects with X`,
    ` - if the question references prior context, use CONVERSATION_STATE to resolve it`,
    `HONESTY_RULES:`,
    ` - if the question claims something not in evidence, answer "No" and correct it`,
    ` - never agree with claims about seniority, leadership, or production work unless in evidence`,
    ` - distinguish internship/lab work from professional production work`,
    `RULES:`,
    ` ${rules || 'Answer grounded in verified evidence only. Never invent experience, employers, metrics, or years. If a tool is needed, request it. If you have enough evidence, answer directly.'}`,
    `OUTPUT: Return ONLY JSON: {"action":"tool"|"answer","tool":<name>,"arguments":{...},"answer":<text>}`
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
// Uses a compact structural format: TASK / FACTS / REQUIREMENTS / RETURN.
// This is more reliable for small models than paragraphs of rules.
function buildSynthesisPacket({ question, conversationState, evidence, toolObservations, rules }) {
  const stateJson = renderConversationState(conversationState);
  const evidenceLines = renderEvidenceList(evidence, SYNTHESIS_EVIDENCE_MAX_ITEMS, SYNTHESIS_EVIDENCE_MAX_CHARS);
  const obsLines = (toolObservations || []).slice(-3).map((obs, i) => {
    const result = truncateForContext(JSON.stringify(obs.result), TOOL_OBS_MAX_CHARS);
    return `${i + 1}. ${obs.tool} → ${result}`;
  });

  const personaLine = getPersonaLine();
  const convRules = getConversationRules();
  const profileSummary = buildCompactProfileSummary();

  const system = [
    personaLine,
    `CONVERSATION_STATE: ${stateJson}`,
    `PROFILE:\n${profileSummary}`,
    evidenceLines.length ? `FACTS:\n${evidenceLines.map((e, i) => `${i + 1}. ${e}`).join('\n')}` : `FACTS: none`,
    obsLines.length ? `TOOL_RESULTS:\n${obsLines.join('\n')}` : `TOOL_RESULTS: none`,
    `REQUIREMENTS:`,
    ` - answer naturally, as if talking to a person — not a robot reading facts`,
    ` - synthesize from FACTS and PROFILE — don't just copy them verbatim`,
    ` - use only FACTS, TOOL_RESULTS, and PROFILE`,
    ` - if the question claims something not in FACTS, say "No" and correct it`,
    ` - distinguish internship/lab work from professional production work`,
    ` - if the question references prior context, use CONVERSATION_STATE to resolve it`,
    convRules,
    `RETURN JSON: {"answer":"<grounded answer>"}`
  ].join('\n');

  const user = `Question: ${truncateForContext(question, 300)}`;
  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: estimateTokens(system + user),
    evidenceCount: evidenceLines.length,
    toolsCount: 0,
    charsDropped: 0
  };
}

// Build a repair packet for validation-guided repair.
// Sends the rejection reason and asks the model to rewrite.
function buildRepairPacket({ question, conversationState, evidence, toolObservations, rejectionDetails }) {
  const stateJson = renderConversationState(conversationState);
  const evidenceLines = renderEvidenceList(evidence, SYNTHESIS_EVIDENCE_MAX_ITEMS, SYNTHESIS_EVIDENCE_MAX_CHARS);
  const obsLines = (toolObservations || []).slice(-3).map((obs, i) => {
    const result = truncateForContext(JSON.stringify(obs.result), TOOL_OBS_MAX_CHARS);
    return `${i + 1}. ${obs.tool} → ${result}`;
  });

  const reasonLines = (rejectionDetails || []).map(r => ` - ${r.reason}: ${r.detail}`).join('\n');
  const personaLine = getPersonaLine();
  const convRules = getConversationRules();

  const system = [
    `${personaLine} Your previous answer was rejected.`,
    `CONVERSATION_STATE: ${stateJson}`,
    evidenceLines.length ? `FACTS:\n${evidenceLines.map((e, i) => `${i + 1}. ${e}`).join('\n')}` : `FACTS: none`,
    obsLines.length ? `TOOL_RESULTS:\n${obsLines.join('\n')}` : `TOOL_RESULTS: none`,
    `REJECTION_REASONS:`,
    reasonLines || ' - unknown',
    `REQUIREMENTS:`,
    ` - rewrite using ONLY FACTS and TOOL_RESULTS`,
    ` - fix every rejection reason above`,
    ` - answer naturally, not like a robot reading facts`,
    convRules,
    `RETURN JSON: {"answer":"<corrected grounded answer>"}`
  ].join('\n');

  const user = `Question: ${truncateForContext(question, 300)}`;
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
  const personaLine = getPersonaLine();
  const system = `${personaLine} Answer the question. Be honest and concise.`;
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
  buildRepairPacket,
  buildRawPacket
};
