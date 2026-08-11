'use strict';

const OVERCLAIM_RE = /\b(clear winner|winner|best candidate|strong ai capabilities|no external dependencies|production[- ]ready|enterprise[- ]ready|expert|mastery|highly skilled|proven leader|guaranteed fit)\b/i;
const SAFE_CAPITALIZED = new Set([
  'A', 'An', 'And', 'As', 'At', 'Based', 'Because', 'Brad', 'Bradley', 'But',
  'For', 'From', 'He', 'His', 'However', 'I', 'If', 'In', 'It', 'Its', 'On',
  'Or', 'Overall', 'Scout', 'So', 'That', 'The', 'These', 'They', 'This', 'To',
  'When', 'While', 'With'
]);
const MEMORY_MAX_TURNS = 5;

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

function validateLocalConversationReply(reply, source) {
  const text = cleanTurnText(reply, 1200);
  const sourceText = cleanTurnText(source, 12000).toLowerCase();
  if (text.length < 20 || text.length > 600 || !sourceText) return false;
  if (OVERCLAIM_RE.test(text)) return false;
  if ((text.match(/[.!?]+(?:\s|$)/g) || []).length > 3) return false;

  const numbers = text.match(/\b\d[\d.,]*\b/g) || [];
  if (numbers.some(number => !sourceText.includes(number.toLowerCase()))) return false;

  const capitalized = text.match(/\b[A-Z][A-Za-z0-9+#.-]{1,}\b/g) || [];
  if (capitalized.some(token => !SAFE_CAPITALIZED.has(token) && !sourceText.includes(token.toLowerCase()))) return false;

  const contentWords = text.toLowerCase().match(/[a-z][a-z0-9+#.-]{4,}/g) || [];
  const groundedMatches = new Set(contentWords.filter(word => sourceText.includes(word)));
  return groundedMatches.size >= 2;
}

module.exports = { MEMORY_MAX_TURNS, buildLocalConversationMemory, validateLocalConversationReply };
