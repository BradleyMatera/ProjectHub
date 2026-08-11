'use strict';

// Grounding Validator — prevents hallucination and exaggeration in generated
// Scout answers. The model may write the answer, but it CANNOT invent Bradley's
// history. Every factual claim must be supported by Scout evidence.
//
// Validation layers:
//   1. Overclaim detection: flags exaggeration language ("expert", "led",
//      "production-ready", "mastery", etc.)
//   2. Entity grounding: capitalized tokens (project names, tech, employers)
//      must appear in the source evidence.
//   3. Number grounding: any number in the answer must appear in the evidence.
//   4. Content-word overlap: the answer must share enough content words with
//      the evidence to be grounded.
//   5. Question relevance: the answer must address the question's subject.
//   6. Length/structure: 1-2 sentences, ends with punctuation, not too long.
//   7. Upgrade detection: catches "worked with" → "expert in", "helped" → "led",
//      "internship" → "production", "learned" → "professional experience".
//
// Returns a verdict: { valid, reasons[], verdict: 'supported'|'partial'|'unsupported', cleaned }

const OVERCLAIM_RE = /\b(clear winner|winner|best candidate|strong ai capabilities|no external dependencies|production[- ]ready|enterprise[- ]ready|expert|mastery|highly skilled|proven leader|guaranteed fit|valuable asset|crucial|extensive|deep expertise|years of experience|seasoned|veteran|senior engineer|architected|spearheaded|championed|revolutionized|cutting[- ]edge|state[- ]of[- ]the[- ]art)\b/i;

// Upgrade patterns: the answer uses stronger language than the evidence supports.
const UPGRADE_PATTERNS = [
  { re: /\b(expert|expertise|master(?:ed|y)|deep knowledge)\b/i, flag: 'expertise_inflation', needs: /\b(expert|expertise|master(?:ed|y)|deep knowledge)\b/i },
  { re: /\b(led|leadership|headed|managed the team|directed)\b/i, flag: 'leadership_inflation', needs: /\b(led|leadership|headed|managed the team|directed)\b/i },
  { re: /\b(production system|production environment|live production|owned production)\b/i, flag: 'production_inflation', needs: /\b(production system|production environment|live production|owned production)\b/i },
  { re: /\b(professional experience|professional experience with)\b/i, flag: 'professional_inflation', needs: /\b(professional experience)\b/i },
  { re: /\b(senior|principal|staff)\b.*\b(engineer|developer|architect)\b/i, flag: 'seniority_inflation', needs: /\b(senior|principal|staff)\b.*\b(engineer|developer|architect)\b/i },
  { re: /\b(\d+)\s+years?\s+(of\s+)?experience\b/i, flag: 'years_claim', needs: null }
];

const SAFE_CAPITALIZED = new Set([
  'A', 'An', 'And', 'As', 'At', 'Based', 'Because', 'Brad', 'Bradley', 'But',
  'For', 'From', 'He', 'His', 'However', 'I', 'If', 'In', 'It', 'Its', 'On',
  'Or', 'Overall', 'Scout', 'So', 'That', 'The', 'These', 'They', 'This', 'To',
  'When', 'While', 'With', 'AWS', 'API', 'APIs', 'CSS', 'HTML', 'SQL', 'URL',
  'GitHub', 'JavaScript', 'TypeScript', 'Node', 'Node.js', 'React', 'GCP',
  'CIRIS', 'CodePen', 'DevOps', 'Linux', 'Python', 'Docker', 'Caddy',
  'Yes', 'No', 'Not', 'Also', 'Well', 'Actually', 'Currently', 'Unfortunately',
  'Honestly', 'Sure', 'Correct', 'Right', 'True', 'False', 'Both', 'Neither',
  'Although', 'Since', 'Though', 'Unless', 'Until', 'Without', 'Within'
]);

const QUESTION_STOPWORDS = new Set([
  'about', 'affect', 'bradley', 'could', 'does', 'doing', 'from', 'have',
  'looks', 'should', 'their', 'there', 'these', 'thing', 'think', 'those',
  'through', 'under', 'what', 'when', 'where', 'which', 'while', 'would',
  'tell', 'about', 'know', 'knows', 'show', 'give', 'explain', 'describe'
]);

function cleanText(value, max) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractCompleteSentences(value, maxSentences = 2) {
  const text = cleanText(value, 1200);
  const matches = text.match(/[^.!?]{12,}[.!?](?=\s|$)/g) || [];
  return matches.slice(0, Math.max(1, maxSentences)).map(s => s.trim()).join(' ');
}

// Core validation. source = the concatenated evidence text the answer must be
// grounded in. question = the user's question (for relevance check).
function validateAnswer(answer, source, question = '') {
  const text = cleanText(answer, 800);
  const sourceText = cleanText(source, 16000).toLowerCase();
  const reasons = [];

  if (text.length < 20) { reasons.push('too_short'); return { valid: false, reasons, verdict: 'unsupported', cleaned: text }; }
  if (text.length > 600) { reasons.push('too_long'); }
  if (!/[.!?]$/.test(text)) { reasons.push('no_terminal_punctuation'); }
  const sentenceCount = (text.match(/[.!?]+(?:\s|$)/g) || []).length;
  if (sentenceCount > 3) { reasons.push('too_many_sentences'); }

  // 1. Overclaim
  if (OVERCLAIM_RE.test(text)) { reasons.push('overclaim_language'); }

  // 2. Upgrade detection
  for (const pattern of UPGRADE_PATTERNS) {
    if (pattern.re.test(text)) {
      if (pattern.needs && !pattern.needs.test(sourceText)) {
        reasons.push(`upgrade:${pattern.flag}`);
      } else if (!pattern.needs) {
        // years claim — must appear in source
        const yearsMatch = text.match(/\b(\d+)\s+years?\b/i);
        if (yearsMatch && !sourceText.includes(yearsMatch[1])) {
          reasons.push('upgrade:years_claim_not_in_evidence');
        }
      }
    }
  }

  // 3. Number grounding
  const numbers = text.match(/\b\d[\d.,]*\b/g) || [];
  for (const num of numbers) {
    if (!sourceText.includes(num.toLowerCase())) { reasons.push(`number_not_grounded:${num}`); }
  }

  // 4. Entity grounding
  const capitalized = text.match(/\b[A-Z][A-Za-z0-9+#.-]{1,}\b/g) || [];
  for (const token of capitalized) {
    if (!SAFE_CAPITALIZED.has(token) && !sourceText.includes(token.toLowerCase())) {
      reasons.push(`entity_not_grounded:${token}`);
    }
  }

  // 5. Content-word overlap
  const contentWords = text.toLowerCase().match(/[a-z][a-z0-9+#.-]{4,}/g) || [];
  const groundedMatches = new Set(contentWords.filter(w => sourceText.includes(w)));
  if (groundedMatches.size < 2) { reasons.push('insufficient_content_overlap'); }

  // 6. Question relevance — match on full word or a 4-char stem prefix so
  // "build" matches "built", "projects" matches "project", etc.
  const questionTerms = (String(question).toLowerCase().match(/[a-z][a-z0-9+#.-]{4,}/g) || [])
    .filter(w => !QUESTION_STOPWORDS.has(w));
  if (questionTerms.length > 0) {
    const answerLower = text.toLowerCase();
    const answered = questionTerms.some(w => answerLower.includes(w) || answerLower.includes(w.slice(0, 4)));
    if (!answered) { reasons.push('not_relevant_to_question'); }
  }

  // AI slop / self-revelation
  if (/\b(as an ai|i am an ai|i'?m an ai|based on the (data|information|evidence) provided|according to (the )?(data|information|evidence))\b/i.test(text)) {
    reasons.push('ai_slop');
  }

  const hardFail = reasons.some(r =>
    r === 'too_short' ||
    r === 'insufficient_content_overlap' ||
    r === 'not_relevant_to_question' ||
    r.startsWith('entity_not_grounded:') ||
    r.startsWith('number_not_grounded:') ||
    r.startsWith('upgrade:') ||
    r === 'overclaim_language' ||
    r === 'ai_slop'
  );

  const verdict = hardFail ? 'unsupported' : (reasons.length > 0 ? 'partial' : 'supported');
  return { valid: !hardFail, reasons, verdict, cleaned: text };
}

// Validate a structured tool-selection decision from the model.
// Small models often produce slightly wrong schemas — this validator is tolerant:
//   * {"action":"answer","answer":"..."}            — direct answer
//   * {"action":"tool","tool":"X","arguments":{}}   — tool request
//   * {"tool":"X","arguments":{}}                   — implicit tool request
//   * {"answer":"..."}                              — implicit answer
//   * {"action":"<tool_name>","arguments":{}}       — tool name as action
//   * Both answer + tool present                     — prefer answer if substantial
// Returns { valid, decision, error }
function validateToolDecision(parsed, allowedToolNames) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, decision: null, error: 'not_an_object' };
  }
  const allowed = new Set(allowedToolNames || []);
  const action = String(parsed.action || '').toLowerCase();
  const answer = String(parsed.answer || '').trim();
  const tool = String(parsed.tool || '').trim();
  const args = parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {};

  // If both answer and tool are present, prefer a substantial answer (the model
  // already reasoned over the evidence it was given).
  if (answer.length >= 20 && (action === 'answer' || !action || action === 'tool')) {
    return { valid: true, decision: { action: 'answer', answer }, error: null };
  }

  // Explicit answer action
  if (action === 'answer') {
    if (answer.length < 10) return { valid: false, decision: null, error: 'answer_too_short' };
    return { valid: true, decision: { action: 'answer', answer }, error: null };
  }

  // Tool request: action="tool" with tool field, OR tool field directly, OR
  // action is itself a tool name.
  let resolvedTool = tool;
  if (!resolvedTool && allowed.has(action)) resolvedTool = action;
  if (!resolvedTool) {
    // Maybe the model put the tool name in a different field
    for (const key of Object.keys(parsed)) {
      if (allowed.has(String(parsed[key]).toLowerCase())) {
        resolvedTool = String(parsed[key]).toLowerCase();
        break;
      }
    }
  }
  if (resolvedTool) {
    if (!allowed.has(resolvedTool)) return { valid: false, decision: null, error: `unknown_tool:${resolvedTool}` };
    return { valid: true, decision: { action: 'tool', tool: resolvedTool, arguments: args }, error: null };
  }

  // Fallback: if there's any answer-like text, use it
  if (answer.length >= 10) {
    return { valid: true, decision: { action: 'answer', answer }, error: null };
  }

  return { valid: false, decision: null, error: `unknown_action:${action || 'none'}` };
}

// Attempt to repair a model output that wasn't valid JSON. Returns parsed object
// or null if repair fails. Only attempts cheap, safe repairs.
function attemptJsonRepair(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  // Strip markdown code fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // Extract the first {...} block
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }
  try {
    return JSON.parse(text);
  } catch {
    // Try removing trailing commas
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      // Try removing stray quotes/commas before closing braces
      try {
        return JSON.parse(text.replace(/[",]\s*([}\]])/g, '$1'));
      } catch {
        // Last resort: extract the "answer" field directly with a regex
        const answerMatch = text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (answerMatch) return { action: 'answer', answer: answerMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') };
        const toolMatch = text.match(/"tool"\s*:\s*"([^"]+)"/);
        if (toolMatch) {
          const argsMatch = text.match(/"arguments"\s*:\s*(\{[^}]*\})/);
          return { action: 'tool', tool: toolMatch[1], arguments: argsMatch ? (() => { try { return JSON.parse(argsMatch[1]); } catch { return {}; } })() : {} };
        }
        return null;
      }
    }
  }
}

module.exports = {
  OVERCLAIM_RE,
  UPGRADE_PATTERNS,
  SAFE_CAPITALIZED,
  cleanText,
  extractCompleteSentences,
  validateAnswer,
  validateToolDecision,
  attemptJsonRepair
};
