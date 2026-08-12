'use strict';

// Grounding Validator — prevents hallucination and exaggeration in generated
// Scout answers. The model may write the answer, but it CANNOT invent Bradley's
// history. Every factual claim must be supported by Scout evidence.
//
// Validation layers:
//   1. Overclaim detection: flags exaggeration language ("expert", "led",
//      "production-ready", "mastery", etc.) with negation-aware context.
//   2. Entity grounding: capitalized tokens (project names, tech, employers)
//      must appear in the source evidence using normalized matching.
//   3. Number grounding: any number in the answer must appear in the evidence.
//   4. Content-word overlap: the answer must share enough content words with
//      the evidence to be grounded.
//   5. Question relevance: the answer must address the question's subject.
//   6. Length/structure: 1-2 sentences, ends with punctuation, not too long.
//   7. Upgrade detection: catches "worked with" → "expert in", "helped" → "led",
//      "internship" → "production", "learned" → "professional experience".
//   8. Claim-level validation: splits answer into sentences, detects negation
//      per-sentence, and only flags unsupported positive assertions.
//
// Returns a verdict: { valid, reasons[], verdict: 'supported'|'partial'|'unsupported', cleaned }

const { buildEntityRegistry, isEntityGrounded, normalizeEntity } = require('./canonical-entities');

const OVERCLAIM_RE = /\b(clear winner|best candidate|strong ai capabilities|production[- ]ready|enterprise[- ]ready|proven leader|guaranteed fit|valuable asset|deep expertise|years of experience|seasoned|veteran|senior engineer|architected|spearheaded|championed|revolutionized|cutting[- ]edge|state[- ]of[- ]the[- ]art)\b/i;

// Upgrade patterns: the answer uses stronger language than the evidence supports.
const UPGRADE_PATTERNS = [
  { re: /\b(expert|master(?:ed|y)|deep knowledge)\b/i, flag: 'expertise_inflation', needs: /\b(expert|master(?:ed|y)|deep knowledge)\b/i },
  { re: /\b(led|leadership|headed|managed the team|directed)\b/i, flag: 'leadership_inflation', needs: /\b(led|leadership|headed|managed the team|directed)\b/i },
  { re: /\b(production system|production environment|live production|owned production)\b/i, flag: 'production_inflation', needs: /\b(production system|production environment|live production|owned production)\b/i },
  { re: /\b(senior|principal|staff)\b.*\b(engineer|developer|architect)\b/i, flag: 'seniority_inflation', needs: /\b(senior|principal|staff)\b.*\b(engineer|developer|architect)\b/i },
  { re: /\b(\d+)\s+years?\s+(of\s+)?experience\b/i, flag: 'years_claim', needs: null }
];

// Negation words that indicate a claim is being REFUTED, not asserted
const NEGATION_RE = /\b(not|never|no|wasn't|was not|isn't|is not|didn't|did not|doesn't|does not|don't|do not|cannot|can't|won't|will not|rather than|instead of|contrary to)\b/i;

// Check if a specific clause/sentence contains negation
function hasNegation(text) {
  return NEGATION_RE.test(text);
}

// Split answer into sentences for claim-level analysis
function splitSentences(text) {
  return text.match(/[^.!?]{12,}[.!?]+(?:\s|$)/g) || [text];
}

// Split a sentence into clauses (by semicolons, commas with conjunctions)
// so that negation in one clause doesn't mask positive assertions in another.
// e.g., "he was not a junior engineer; he was a senior engineer" →
//   ["he was not a junior engineer", "he was a senior engineer"]
function splitClauses(sentence) {
  // Split on semicolons first
  const semiParts = sentence.split(/[;]+/).map(s => s.trim()).filter(s => s.length > 5);
  if (semiParts.length > 1) return semiParts;
  // Split on ", but " or ", and " or ", however " if the parts are long enough
  const conjParts = sentence.split(/,\s*(?:but|however|rather|instead)\s+/i).map(s => s.trim()).filter(s => s.length > 10);
  if (conjParts.length > 1) return conjParts;
  return [sentence];
}

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

  if (text.length < 15) { reasons.push('too_short'); return { valid: false, reasons, verdict: 'unsupported', cleaned: text }; }
  if (text.length > 800) { reasons.push('too_long'); }
  if (!/[.!?]$/.test(text)) { reasons.push('no_terminal_punctuation'); }
  const sentenceCount = (text.match(/[.!?]+(?:\s|$)/g) || []).length;
  if (sentenceCount > 5) { reasons.push('too_many_sentences'); }

  // 1. Overclaim — clause-level negation-aware check.
  // Split into sentences and clauses, only flag overclaim in NON-negated clauses.
  const sentences = splitSentences(text);
  let overclaimFound = false;
  for (const sent of sentences) {
    const clauses = splitClauses(sent);
    for (const clause of clauses) {
      if (OVERCLAIM_RE.test(clause) && !hasNegation(clause)) {
        overclaimFound = true;
        break;
      }
    }
    if (overclaimFound) break;
  }
  if (overclaimFound) {
    reasons.push('overclaim_language');
  }

  // 2. Upgrade detection — also negation-aware at clause level
  for (const pattern of UPGRADE_PATTERNS) {
    let patternFound = false;
    for (const sent of sentences) {
      const clauses = splitClauses(sent);
      for (const clause of clauses) {
        if (pattern.re.test(clause) && !hasNegation(clause)) {
          patternFound = true;
          break;
        }
      }
      if (patternFound) break;
    }
    if (patternFound) {
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

  // 3. Number grounding — contextual check.
  // A number is grounded only if it appears as a WHOLE WORD in the source text
  // AND at least one of the surrounding content words from the answer also
  // appears near the number in the source text. This prevents:
  //   - "16" matching "0.016393..." (substring of evidence score)
  //   - "10" matching "$10/mo" when the claim is "10 years of experience"
  const numberMatches = [...text.matchAll(/\b\d[\d.,]*\b/g)];
  for (const match of numberMatches) {
    const num = match[0];
    // Extract ±30 chars of context around the number in the answer
    const ctxStart = Math.max(0, match.index - 30);
    const ctxEnd = Math.min(text.length, match.index + num.length + 30);
    const contextWindow = text.slice(ctxStart, ctxEnd).toLowerCase();
    // Content words from the context (3+ chars, excluding the number itself)
    const contextWords = (contextWindow.match(/[a-z][a-z]{2,}/g) || [])
      .filter(w => !/^\d/.test(w) && w.length >= 3);

    // Find all occurrences of the number as a whole word in the source text
    const numEscaped = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const numRegex = new RegExp(`\\b${numEscaped}\\b`, 'gi');
    let foundGrounded = false;
    let match2;
    while ((match2 = numRegex.exec(sourceText)) !== null) {
      if (contextWords.length === 0) {
        // No context words to check — accept the number as grounded
        foundGrounded = true;
        break;
      }
      // Check if any context word appears within 50 chars of this number occurrence
      const srcStart = Math.max(0, match2.index - 50);
      const srcEnd = Math.min(sourceText.length, match2.index + num.length + 50);
      const srcWindow = sourceText.slice(srcStart, srcEnd);
      if (contextWords.some(w => srcWindow.includes(w))) {
        foundGrounded = true;
        break;
      }
    }
    if (!foundGrounded) {
      reasons.push(`number_not_grounded:${num}`);
    }
  }

  // 4. Entity grounding — generic normalized matching.
  // Build entity registry from source text (any capitalized word in the
  // evidence is automatically grounded). Also matches normalized forms
  // so "VoiceOps" matches "Voice Ops" and "Matera" matches "Bradley Matera".
  // Also includes the profile summary so common tech terms are grounded.
  //
  // Generic approach: a word is a "named entity claim" only if it appears
  // in a multi-word capitalized phrase or is a known proper noun pattern.
  // Single capitalized words at sentence start are common English, not entities.
  const { buildCompactProfileSummary } = require('./profile-summary');
  const profileSrc = source + '\n' + buildCompactProfileSummary();
  const entityRegistry = buildEntityRegistry(null, profileSrc);

  // Extract potential entity claims: multi-word capitalized phrases or
  // single capitalized words that are NOT at the start of a sentence.
  // Words at sentence start are capitalized by English convention and are
  // not necessarily named entities.
  const sentencesForEntities = splitSentences(text);
  const entityClaims = [];
  for (const sent of sentencesForEntities) {
    // Find multi-word capitalized phrases (likely named entities)
    const multiWord = sent.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
    for (const phrase of multiWord) {
      entityClaims.push(phrase);
    }
    // Find single capitalized words NOT at sentence start
    // (words after position 0 are more likely to be real entities)
    const words = sent.match(/\b[A-Z][A-Za-z0-9+#.-]{1,}\b/g) || [];
    for (const word of words) {
      const idx = sent.indexOf(word);
      // Skip if at sentence start (first 10 chars) — likely just English capitalization
      if (idx > 10 || /^[A-Z]{2,}$/.test(word)) {
        entityClaims.push(word);
      }
    }
  }

  for (const token of entityClaims) {
    if (!isEntityGrounded(token, entityRegistry)) {
      reasons.push(`entity_not_grounded:${token}`);
    }
  }

  // 5. Content-word overlap
  // Strip trailing punctuation from each match so "DynamoDB." doesn't fail to
  // match "DynamoDB" in the source. The regex character class includes "." for
  // version numbers (e.g. "Node.js") but trailing periods must be trimmed.
  const rawContentWords = text.toLowerCase().match(/[a-z][a-z0-9+#.-]{4,}/g) || [];
  const contentWords = rawContentWords.map(w => w.replace(/[.]+$/, ''));
  const groundedMatches = new Set(contentWords.filter(w => sourceText.includes(w)));
  if (groundedMatches.size < 2) { reasons.push('insufficient_content_overlap'); }

  // 6. Question relevance — match on full word, stem prefix, or short tech terms.
  // Include 3-char tech terms (AWS, SQL, API) that the {4,} regex misses.
  // This is a SOFT check: only hard-fail if the answer shares NO topic overlap
  // with the question at all (no terms, no entities, no topic words).
  const SHORT_TECH_TERMS = new Set(['aws', 'sql', 'api', 'css', 'html', 'url', 'gcp', 'npm', 'git', 'hub', 's3', 'ec2', 'rds']);
  const longQuestionTerms = (String(question).toLowerCase().match(/[a-z][a-z0-9+#.-]{4,}/g) || [])
    .filter(w => !QUESTION_STOPWORDS.has(w));
  const shortQuestionTerms = (String(question).toLowerCase().match(/[a-z][a-z0-9+#.]{2,3}\b/g) || [])
    .filter(w => SHORT_TECH_TERMS.has(w));
  const allQuestionTerms = [...longQuestionTerms, ...shortQuestionTerms];
  if (allQuestionTerms.length > 0) {
    const answerLower = text.toLowerCase();
    const answered = allQuestionTerms.some(w => answerLower.includes(w) || answerLower.includes(w.slice(0, 4)));
    if (!answered) { reasons.push('not_relevant_to_question'); }
  }

  // AI slop / self-revelation
  if (/\b(as an ai|i am an ai|i'?m an ai|based on the (data|information|evidence) provided|according to (the )?(data|information|evidence))\b/i.test(text)) {
    reasons.push('ai_slop');
  }

  // 7. Persona confusion — check if the answer uses first person
  // when it should be talking about the subject in third person.
  // Scout is the assistant; the subject is separate.
  // Only flag CLEAR first-person claims about the subject's experience,
  // not incidental mentions of titles like "software engineer".
  const firstPersonClaimPatterns = [
    /\bi (?:am|was|have|had|built|worked|used|created|developed|managed|led|learned|know|specialize|helped|designed)\b/i,
    /\bmy (?:work|experience|projects|skills|role|background|career|expertise|internship|degree|education)\b/i,
    /\bin my (?:role|position|experience|work|capacity|internship|time at)\b/i,
    /\bas a software (?:engineer|developer|architect|intern)\b/i
  ];
  for (const pattern of firstPersonClaimPatterns) {
    if (pattern.test(text)) {
      // Check if there's also third-person reference — if so, it's probably
      // a mixed answer where the model is explaining its reasoning.
      // Pure first-person without any third-person reference is persona confusion.
      const hasThirdPerson = /\b(he|his|him|she|her|they|their|the candidate|the subject|bradley|brad)\b/i.test(text);
      if (!hasThirdPerson) {
        reasons.push('persona_confusion');
      }
      break;
    }
  }

  // Hard fails: these always reject the answer.
  // not_relevant_to_question is SOFT — it contributes to a 'partial' verdict
  // but does not auto-reject, because the model may accurately paraphrase
  // using different words than the question.
  const hardFail = reasons.some(r =>
    r === 'too_short' ||
    r === 'insufficient_content_overlap' ||
    r === 'persona_confusion' ||
    r.startsWith('entity_not_grounded:') ||
    r.startsWith('number_not_grounded:') ||
    r.startsWith('upgrade:') ||
    r === 'overclaim_language' ||
    r === 'ai_slop'
  );
  // Soft fails that don't auto-reject but contribute to quality assessment
  // too_many_sentences, no_terminal_punctuation, too_long, not_relevant_to_question

  const verdict = hardFail ? 'unsupported' : (reasons.length > 0 ? 'partial' : 'supported');

  // Build structured rejection feedback for validation-guided repair.
  // Maps internal reasons to machine-useful categories.
  const rejectionDetails = [];
  if (reasons.includes('overclaim_language')) {
    rejectionDetails.push({ reason: 'OVERCLAIM', detail: 'Answer uses exaggeration language (expert, led, production-ready, etc.)' });
  }
  for (const r of reasons) {
    if (r.startsWith('upgrade:')) {
      rejectionDetails.push({ reason: 'OVERCLAIM', detail: `Inflated language: ${r}` });
    }
  }
  for (const r of reasons) {
    if (r.startsWith('entity_not_grounded:')) {
      rejectionDetails.push({ reason: 'UNSUPPORTED_ENTITY', detail: `Entity not in evidence: ${r.split(':')[1]}` });
    }
  }
  for (const r of reasons) {
    if (r.startsWith('number_not_grounded:')) {
      rejectionDetails.push({ reason: 'UNSUPPORTED_NUMBER', detail: `Number not in evidence: ${r.split(':')[1]}` });
    }
  }
  if (reasons.includes('insufficient_content_overlap')) {
    rejectionDetails.push({ reason: 'LOW_EVIDENCE_OVERLAP', detail: 'Answer does not share enough content words with verified evidence' });
  }
  if (reasons.includes('not_relevant_to_question')) {
    rejectionDetails.push({ reason: 'QUESTION_MISMATCH', detail: 'Answer may not address the question topic' });
  }
  if (reasons.includes('too_short')) {
    rejectionDetails.push({ reason: 'TOO_SHORT', detail: 'Answer is too short (under 20 characters)' });
  }
  if (reasons.includes('too_long')) {
    rejectionDetails.push({ reason: 'TOO_LONG', detail: 'Answer is too long (over 600 characters)' });
  }
  if (reasons.includes('no_terminal_punctuation')) {
    rejectionDetails.push({ reason: 'INVALID_STRUCTURE', detail: 'Answer does not end with punctuation' });
  }
  if (reasons.includes('too_many_sentences')) {
    rejectionDetails.push({ reason: 'TOO_LONG', detail: 'Answer has more than 3 sentences' });
  }
  if (reasons.includes('ai_slop')) {
    rejectionDetails.push({ reason: 'AI_SLOP', detail: 'Answer uses AI self-revelation phrases' });
  }

  return { valid: !hardFail, reasons, verdict, cleaned: text, rejectionDetails };
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
  cleanText,
  extractCompleteSentences,
  validateAnswer,
  validateToolDecision,
  attemptJsonRepair,
  hasNegation,
  splitSentences,
  splitClauses
};
