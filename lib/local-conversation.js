'use strict';

const { buildEntityRegistry, isEntityGrounded } = require('./canonical-entities');

const OVERCLAIM_RE = /\b(clear winner|winner|best candidate|strong ai capabilities|no external dependencies|production[- ]ready|enterprise[- ]ready|expert|mastery|highly skilled|proven leader|guaranteed fit|rather than|quality standards|valuable asset|crucial)\b/i;
const CURRENT_QUESTION_RE = /\b(currently|current|as of now|as of today|right now|at the moment|present day|these days)\b/i;
const CURRENT_REPLY_RE = /\b(currently|as of now|as of today|right now|at the moment)\b/i;
const PAST_QUESTION_RE = /\b(did|was|were|previously|before|ago|last year|former|in 20\d\d|in \d{4})\b/i;
const PAST_REPLY_RE = /\b(was|were|previously|before|ago|in 20\d\d|from .* to)\b/i;
const MEMORY_MAX_TURNS = 5;
const QUESTION_STOPWORDS = new Set(['about', 'affect', 'could', 'does', 'doing', 'from', 'have', 'looks', 'should', 'their', 'there', 'these', 'thing', 'think', 'those', 'through', 'under', 'what', 'when', 'where', 'which', 'while', 'would']);

// Add subject name parts to stopwords at runtime
function configureStopwords(subjectNames = []) {
  for (const name of subjectNames) {
    if (name) QUESTION_STOPWORDS.add(name.toLowerCase());
  }
}

function cleanTurnText(value, maxLength) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function buildLocalConversationMemory(history, stanceContext) {
  const turns = Array.isArray(history)
    ? history.slice(-MEMORY_MAX_TURNS).map(turn => ({
      user: cleanTurnText(turn?.user, 360),
      assistant: cleanTurnText(turn?.assistant, 480)
    })).filter(turn => turn.user || turn.assistant)
    : [];
  return {
    turns,
    text: turns.map(turn => `User: ${turn.user}\nScout: ${turn.assistant}`).join('\n'),
    stance: cleanTurnText(stanceContext, 600)
  };
}

function extractFirstCompleteSentence(value) {
  const text = cleanTurnText(value, 1200);
  const match = text.match(/^([\s\S]{20,}?[!?]|[\s\S]{20,}?\.(?=\s|$))/);
  return match ? match[1].trim() : '';
}

function extractCompleteSentences(value, maxSentences = 2) {
  const text = cleanTurnText(value, 1200);
  const matches = text.match(/[^.!?]{12,}[.!?](?=\s|$)/g) || [];
  return matches.slice(0, Math.max(1, maxSentences)).map(sentence => sentence.trim()).join(' ');
}

function validateTemporalGrounding(reply, source, question = '') {
  const q = String(question).toLowerCase();
  const r = String(reply).toLowerCase();
  const s = String(source).toLowerCase();

  const questionCurrent = CURRENT_QUESTION_RE.test(q);
  const replyCurrent = CURRENT_REPLY_RE.test(r);
  const questionPast = PAST_QUESTION_RE.test(q);
  const replyPast = PAST_REPLY_RE.test(r);

  // Tense mismatch: question asks current, reply answers past (or vice versa).
  if (questionCurrent && replyPast) return false;
  if (questionPast && replyCurrent) return false;

  // If the question asks about the current state and the reply asserts a current state,
  // require that the source contains an explicit current/time marker.
  if (questionCurrent && replyCurrent) {
    const sourceHasCurrent = CURRENT_QUESTION_RE.test(s) || /\bpresent\b/.test(s) || /\btoday\b/.test(s);
    return sourceHasCurrent;
  }

  return true;
}

function validateLocalConversationReply(reply, source, question = '') {
  const text = cleanTurnText(reply, 1200);
  const sourceText = cleanTurnText(source, 12000).toLowerCase();
  if (text.length < 20 || text.length > 600 || !sourceText) return false;
  if (!/[.!?]$/.test(text)) return false;
  if (!validateTemporalGrounding(text, sourceText, question)) return false;
  if (OVERCLAIM_RE.test(text)) return false;
  if ((text.match(/[.!?]+(?:\s|$)/g) || []).length > 2) return false;

  const numbers = text.match(/\b\d[\d.,]*\b/g) || [];
  if (numbers.some(number => !sourceText.includes(number.toLowerCase()))) return false;

  const capitalized = text.match(/\b[A-Z][A-Za-z0-9+#.-]{1,}\b/g) || [];
  const entityRegistry = buildEntityRegistry(null, source);
  if (capitalized.some(token => !isEntityGrounded(token, entityRegistry))) return false;

  const contentWords = text.toLowerCase().match(/[a-z][a-z0-9+#.-]{4,}/g) || [];
  const groundedMatches = new Set(contentWords.filter(word => sourceText.includes(word)));
  if (groundedMatches.size < 2) return false;

  const questionTerms = (String(question).toLowerCase().match(/[a-z][a-z0-9+#.-]{4,}/g) || [])
    .filter(word => !QUESTION_STOPWORDS.has(word));
  return questionTerms.length === 0 || questionTerms.some(word => text.toLowerCase().includes(word));
}

module.exports = { MEMORY_MAX_TURNS, buildLocalConversationMemory, extractFirstCompleteSentence, extractCompleteSentences, validateLocalConversationReply, configureStopwords };
