'use strict';

const knowledgeAccess = require('./knowledge-access');

/**
 * Normalize first-person source text to third-person bot perspective.
 * Knowledge data may contain "I built..." / "I have taken..." — Scout rewrites
 * these with the configured subject pronouns ("They built..." by default,
 * "She built..." for a she/her tenant, and so on).
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
  // getSubjectPronouns always returns a normalized {subject, object,
  // possessive} object — string forms are resolved inside knowledge-access.
  const pronouns = knowledgeAccess.getSubjectPronouns(knowledge) || {};
  const subjectPronoun = pronouns.subject ? pronouns.subject.charAt(0).toUpperCase() + pronouns.subject.slice(1) : 'They';
  const subjectObj = pronouns.object || 'them';
  const subjectPoss = pronouns.possessive || 'their';
  // "They" takes plural agreement ("They are/have"); configured pronouns
  // ("ze", "she", "he") retain singular agreement.
  const plural = /^they$/i.test(subjectPronoun);
  const cop = plural
    ? { am: 'are', was: 'were', have: 'have', had: 'had', will: 'will' }
    : { am: 'is', was: 'was', have: 'has', had: 'had', will: 'will' };

  let normalized = text;
  // "I am" → "He is" / "They are" (not "Jane am" / "They is")
  normalized = normalized.replace(/\bI\s+am\b/gi, `${subjectPronoun} ${cop.am}`);
  normalized = normalized.replace(/\bI\s+was\b/gi, `${subjectPronoun} ${cop.was}`);
  normalized = normalized.replace(/\bI\s+have\b/gi, `${subjectPronoun} ${cop.have}`);
  normalized = normalized.replace(/\bI\s+had\b/gi, `${subjectPronoun} ${cop.had}`);
  normalized = normalized.replace(/\bI\s+will\b/gi, `${subjectPronoun} ${cop.will}`);
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
