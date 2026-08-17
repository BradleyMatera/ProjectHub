'use strict';

const knowledgeAccess = require('./knowledge-access');

/**
 * Normalize first-person source text to third-person bot perspective.
 * Knowledge data may contain "I built..." / "I have taken..." — Scout must
 * say "He built..." / "He has taken..." unless explicitly configured as that person.
 *
 * This is a generic text-preparation helper, not a prose-authoring function:
 * it only swaps pronouns based on the subject pronouns configured for the tenant.
 *
 * @param {string} text
 * @param {object} knowledge
 * @returns {string}
 */
function normalizeSourceVoice(text, knowledge) {
  if (!text || typeof text !== 'string') return text;
  const pronouns = knowledgeAccess.getSubjectPronouns(knowledge);
  const subjectPronoun = pronouns.subject ? pronouns.subject.charAt(0).toUpperCase() + pronouns.subject.slice(1) : 'He';
  const subjectObj = pronouns.object || 'him';
  const subjectPoss = pronouns.possessive || 'his';

  let normalized = text;
  // "I am" → "He is" / "She is" (not "Jane am")
  normalized = normalized.replace(/\bI\s+am\b/gi, `${subjectPronoun} is`);
  normalized = normalized.replace(/\bI\s+was\b/gi, `${subjectPronoun} was`);
  normalized = normalized.replace(/\bI\s+have\b/gi, `${subjectPronoun} has`);
  normalized = normalized.replace(/\bI\s+had\b/gi, `${subjectPronoun} had`);
  normalized = normalized.replace(/\bI\s+will\b/gi, `${subjectPronoun} will`);
  // Remaining standalone "I" → pronoun
  normalized = normalized.replace(/\bI\b/g, subjectPronoun);
  normalized = normalized.replace(/\bmy\b/gi, subjectPoss);
  normalized = normalized.replace(/\bme\b/gi, subjectObj);
  normalized = normalized.replace(/\bmine\b/gi, subjectPoss);
  // Fix "hisself" → "himself" if any weird replacements happened
  normalized = normalized.replace(/\bhisself\b/gi, 'himself');

  return normalized;
}

module.exports = { normalizeSourceVoice };
