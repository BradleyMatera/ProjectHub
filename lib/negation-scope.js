'use strict';

/**
 * Negation Scope — shared clause/proposition-aware negation detection.
 *
 * Both grounding-validator.js and relationship-validator.js need to determine
 * whether a specific entity or claim is within negation scope. Previously each
 * had its own incompatible implementation:
 *
 *   grounding-validator.js: 60-char window after a negation word
 *   relationship-validator.js: entire-sentence scope
 *
 * Both approaches have the same bug: a leading discourse "No," (answering a
 * yes/no question) causes the ENTIRE sentence to be treated as negated,
 * masking positive assertions like "No, Maria attended Stanford."
 *
 * This module splits text into clauses and returns only the clauses that
 * actually contain negation. A leading "No," / "Yes," / "Correct," discourse
 * marker is stripped before clause splitting so it does not contaminate the
 * remaining clauses.
 *
 * Relation classes:
 *   - POSITIVE  — clause asserts a fact ("Maria attended Stanford")
 *   - NEGATED   — clause refutes a fact ("Maria did not attend Stanford")
 *   - DISCOURSE — leading yes/no/ok marker only ("No,")
 */

// Negation words that indicate a claim is being REFUTED, not asserted.
// Does NOT include bare "no" at sentence start (discourse marker) — that is
// handled separately by stripDiscourseMarker().
const { tokenSequence } = require('./evidence-relations');

const NEGATION_WORDS = /\b(?:not|never|neither|nor|without|doesn't|doesn?t|don't|don?t|isn't|isn?t|wasn't|wasn?t|won't|won?t|can't|can?t|cannot|couldn't|couldn?t|shouldn't|shouldn?t|wouldn't|wouldn?t|hasn't|hasn?t|haven't|haven?t|hadn't|hadn?t|aren't|aren?t|weren't|weren?t|did not|does not|do not|is not|was not|is unknown|unknown whether|no information|not in evidence|no evidence|no proof|no indication|no verified record|no documented record|no known record|no verified evidence|no documented evidence|no documentation|not documented|not provided|no such|not a (?:known|verified|documented)|not a single|never any)\b/i;

// Discourse markers at the start of a sentence that answer a question.
// These are NOT negation — "No, Maria attended Stanford" confirms a negative
// question and then makes a positive assertion.
// The marker MUST be followed by a comma to distinguish from phrases like
// "No evidence shows..." where "No" is part of a negation phrase, not a
// discourse marker.
const DISCOURSE_MARKER_RE = /^(?:no|yes|correct|right|wrong|true|false|okay|ok|sure|exactly|indeed|certainly|absolutely)\s*,\s+/i;

// Conjunctions that separate contrasting clauses.
const CONTRAST_CONJUNCTIONS = /\s+(?:but|however|although|though|yet|nevertheless|nonetheless|whereas|while|whereas)\b/i;

/**
 * Strip a leading discourse marker ("No, ", "Yes, ", "Correct, ") from text.
 * Returns { text, hadDiscourseMarker, markerType }.
 */
function stripDiscourseMarker(text) {
  const match = text.match(DISCOURSE_MARKER_RE);
  if (match) {
    const marker = match[0].trim().replace(/[,]/g, '').toLowerCase();
    return {
      text: text.slice(match[0].length),
      hadDiscourseMarker: true,
      markerType: marker,
    };
  }
  return { text, hadDiscourseMarker: false, markerType: null };
}

/**
 * Split a sentence into clauses (by semicolons, contrastive conjunctions,
 * and commas before contrasting conjunctions).
 */
function splitClauses(sentence) {
  // Split on semicolons first
  const semiParts = sentence.split(/[;]+/).map(s => s.trim()).filter(s => s.length > 3);
  if (semiParts.length > 1) return semiParts;

  // Split on contrastive conjunctions (with or without preceding comma)
  const conjParts = sentence.split(/(?:,\s*)?\s+(?:but|however|although|though|yet|nevertheless|nonetheless|whereas)\b/i)
    .map(s => s.trim())
    .filter(s => s.length > 3);
  if (conjParts.length > 1) return conjParts;

  // Split on ", and " only if it introduces a contrasting clause
  // (detected by one side having negation and the other not)
  const andParts = sentence.split(/,\s*and\s+/i).map(s => s.trim()).filter(s => s.length > 3);
  if (andParts.length === 2) {
    const [a, b] = andParts;
    if (NEGATION_WORDS.test(a) !== NEGATION_WORDS.test(b)) return andParts;
  }

  return [sentence];
}

/**
 * Split text into sentences. Handles periods in tech names (Node.js, React.js)
 * by only splitting on sentence-ending punctuation followed by space + capital.
 */
function splitSentences(text) {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?])$/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  return parts.length > 0 ? parts : [text];
}

/**
 * Classify each clause of a sentence as POSITIVE, NEGATED, or DISCOURSE.
 *
 * Returns an array of { text, polarity, isNegated } where:
 *   - polarity: 'positive' | 'negated' | 'discourse'
 *   - isNegated: true only for 'negated' clauses
 *
 * The discourse marker is separated from the first clause so that
 * "No, Maria attended Stanford" produces:
 *   [{ text: "No", polarity: "discourse", isNegated: false },
 *    { text: "Maria attended Stanford", polarity: "positive", isNegated: false }]
 */
function classifyClauses(sentence) {
  const { text: stripped, hadDiscourseMarker, markerType } = stripDiscourseMarker(sentence);
  const clauses = splitClauses(stripped);
  const result = [];

  if (hadDiscourseMarker) {
    result.push({
      text: markerType,
      polarity: 'discourse',
      isNegated: false,
    });
  }

  for (const clause of clauses) {
    const isNegated = NEGATION_WORDS.test(clause);
    result.push({
      text: clause,
      polarity: isNegated ? 'negated' : 'positive',
      isNegated,
    });
  }

  return result;
}

/**
 * Get all negated clause texts from a full answer.
 * Returns an array of strings (the text of each negated clause).
 *
 * Usage in validators:
 *   const negated = getNegatedClauses(answer);
 *   const inNegation = negated.some(ctx => ctx.includes(tokenLower));
 */
function getNegatedClauses(text) {
  const sentences = splitSentences(String(text || ''));
  const negated = [];
  for (const sentence of sentences) {
    const classified = classifyClauses(sentence);
    for (const clause of classified) {
      if (clause.isNegated) {
        negated.push(clause.text.toLowerCase());
      }
    }
  }
  return negated;
}

/**
 * Check if a specific token (entity name) is within negation scope.
 *
 * This replaces the old 60-char-window and sentence-level approaches.
 * It splits the text into sentences and clauses, strips discourse markers,
 * and checks if the token appears in any NEGATED clause.
 *
 * @param {string} text - The full answer text
 * @param {string} token - The entity/term to check (case-insensitive)
 * @returns {boolean} true if the token is in a negated clause
 */
function isTokenNegated(text, token) {
  const tokenWords = tokenSequence(token);
  if (tokenWords.length === 0) return false;
  const negatedClauses = getNegatedClauses(text);
  return negatedClauses.some(ctx => {
    const ctxWords = tokenSequence(ctx);
    return tokenWords.every(tw => ctxWords.includes(tw));
  });
}

/**
 * Check if a sentence contains negation (for quick checks).
 * Strips discourse markers first so "No, Maria attended Stanford" returns false.
 */
function hasNegation(text) {
  const { text: stripped } = stripDiscourseMarker(String(text || ''));
  return NEGATION_WORDS.test(stripped);
}

module.exports = {
  NEGATION_WORDS,
  DISCOURSE_MARKER_RE,
  stripDiscourseMarker,
  splitClauses,
  splitSentences,
  classifyClauses,
  getNegatedClauses,
  isTokenNegated,
  hasNegation,
};
