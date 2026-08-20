'use strict';

/**
 * Knowledge Access — Generic accessor for tenant-specific knowledge.
 *
 * This module provides data-driven lookups so executable code never
 * hardcodes tenant facts. All tenant-specific knowledge lives in
 * the active knowledge package (data/recruiter-knowledge.json or
 * a synthetic tenant fixture).
 *
 * Scout code knows HOW TO THINK ABOUT KNOWLEDGE.
 * The active knowledge package knows the tenant (or any other tenant).
 */

/**
 * Get the subject's full name from the knowledge base.
 * @param {object} knowledge
 * @returns {string}
 */
function getSubjectName(knowledge) {
  return knowledge?.identity?.name || '';
}

/**
 * Get the subject's preferred/short name.
 * @param {object} knowledge
 * @returns {string}
 */
function getPreferredName(knowledge) {
  return knowledge?.identity?.preferredName || '';
}

/**
 * Get all aliases for the subject (including name parts).
 * Returns lowercase normalized set for matching.
 * @param {object} knowledge
 * @returns {Set<string>}
 */
function getSubjectAliasSet(knowledge) {
  const aliases = new Set();
  const name = getSubjectName(knowledge);
  if (name) {
    for (const part of name.split(/\s+/)) {
      if (part.length >= 2) aliases.add(part.toLowerCase());
    }
    aliases.add(name.toLowerCase());
  }
  const preferred = getPreferredName(knowledge);
  if (preferred) aliases.add(preferred.toLowerCase());
  if (Array.isArray(knowledge?.subjectAliases)) {
    for (const alias of knowledge.subjectAliases) {
      aliases.add(String(alias).toLowerCase());
    }
  }
  return aliases;
}

/**
 * Get the subject's title/role.
 * @param {object} knowledge
 * @returns {string}
 */
function getSubjectTitle(knowledge) {
  return knowledge?.identity?.title || '';
}

/**
 * Get the subject's location.
 * @param {object} knowledge
 * @returns {string}
 */
function getSubjectLocation(knowledge) {
  return knowledge?.identity?.location || '';
}

/**
 * Get known companies from experience entries.
 * @param {object} knowledge
 * @returns {string[]}
 */
function getKnownCompanies(knowledge) {
  if (!knowledge?.experience || !Array.isArray(knowledge.experience)) return [];
  return knowledge.experience
    .map(e => e.company)
    .filter(Boolean);
}

/**
 * Get known school names from education.
 * @param {object} knowledge
 * @returns {string[]}
 */
function getKnownSchools(knowledge) {
  const schools = [];
  if (knowledge?.education?.school) schools.push(knowledge.education.school);
  return schools;
}

/**
 * Get known certification names.
 * @param {object} knowledge
 * @returns {string[]}
 */
function getKnownCertifications(knowledge) {
  if (!knowledge?.certifications || !Array.isArray(knowledge.certifications)) return [];
  return knowledge.certifications.map(c => typeof c === 'string' ? c : (c.name || '')).filter(Boolean);
}

/**
 * Get known project names and aliases.
 * @param {object} knowledge
 * @returns {{name: string, aliases: string[]}[]}
 */
function getKnownProjects(knowledge) {
  if (!knowledge?.projects || !Array.isArray(knowledge.projects)) return [];
  return knowledge.projects.map(p => ({
    name: p.name || '',
    aliases: Array.isArray(p.aliases) ? p.aliases : []
  }));
}

/**
 * Get all known project names and aliases as a flat lowercase array.
 * @param {object} knowledge
 * @returns {string[]}
 */
function getProjectNameTokens(knowledge) {
  const projects = getKnownProjects(knowledge);
  const tokens = [];
  for (const p of projects) {
    if (p.name) tokens.push(p.name.toLowerCase());
    for (const a of p.aliases) tokens.push(a.toLowerCase());
  }
  return tokens;
}

/**
 * Get all known technology/skill names as a lowercase array.
 * @param {object} knowledge
 * @returns {string[]}
 */
function getKnownTechnologies(knowledge) {
  const techs = new Set();
  if (knowledge?.skills && typeof knowledge.skills === 'object') {
    for (const cat of Object.values(knowledge.skills)) {
      if (Array.isArray(cat)) {
        for (const s of cat) {
          if (typeof s === 'string') techs.add(s.toLowerCase());
        }
      }
    }
  }
  if (Array.isArray(knowledge?.projects)) {
    for (const p of knowledge.projects) {
      if (Array.isArray(p.tech)) {
        for (const t of p.tech) techs.add(t.toLowerCase());
      }
    }
  }
  return Array.from(techs);
}

/**
 * Get boundaries (authoritative negative facts) from the knowledge base.
 * @param {object} knowledge
 * @returns {object[]}
 */
function getBoundaries(knowledge) {
  if (!Array.isArray(knowledge?.boundaries)) return [];
  return knowledge.boundaries;
}

/**
 * Get boundaries by category.
 * @param {object} knowledge
 * @param {string} category
 * @returns {object[]}
 */
function getBoundariesByCategory(knowledge, category) {
  return getBoundaries(knowledge).filter(b => b.category === category);
}

/**
 * Get claim corrections from the knowledge base.
 * These are pattern-based corrections for common false claims.
 * @param {object} knowledge
 * @returns {object[]}
 */
function getClaimCorrections(knowledge) {
  if (!Array.isArray(knowledge?.claimCorrections)) return [];
  return knowledge.claimCorrections;
}

/**
 * Find claim corrections that match a given question text.
 * @param {object} knowledge
 * @param {string} text
 * @returns {object[]}
 */
function findMatchingClaimCorrections(knowledge, text) {
  const corrections = getClaimCorrections(knowledge);
  return corrections.filter(c => {
    try {
      const re = new RegExp(c.triggerPattern, 'i');
      return re.test(text);
    } catch {
      return false;
    }
  });
}

/**
 * Get direct answers from the knowledge base.
 * @param {object} knowledge
 * @returns {object[]}
 */
function getDirectAnswers(knowledge) {
  if (!Array.isArray(knowledge?.directAnswers)) return [];
  return knowledge.directAnswers;
}

/**
 * Find a direct answer matching a question.
 * @param {object} knowledge
 * @param {string} question
 * @returns {object|null}
 */
function findDirectAnswer(knowledge, question) {
  const answers = getDirectAnswers(knowledge);
  const qLower = String(question || '').toLowerCase();
  let fallback = null;
  for (const ans of answers) {
    if (!Array.isArray(ans.questionPatterns)) continue;
    const hasDirect = Array.isArray(ans.intents) && ans.intents.includes('direct');
    for (const pattern of ans.questionPatterns) {
      try {
        const re = new RegExp(pattern, 'i');
        if (re.test(qLower)) {
          if (hasDirect) return ans;
          if (!fallback) fallback = ans;
        }
      } catch {
        // skip invalid patterns
      }
    }
  }
  return fallback;
}

/**
 * Determine whether the knowledge base contains an authoritative negative
 * assessment for the question. This is used by the response contract to
 * set factState and by the grounding validator to decide whether a ranked
 * weakness claim is supported.
 *
 * Searches (in precedence order):
 *  1. explicit directAnswers with 'direct' intent
 *  2. interviewStories whose prompt matches the user question
 *  3. faq entries whose question matches the user question
 *
 * A match is only authoritative when the record's own question/prompt answers
 * the same kind of negative-assessment question as the user. A story whose
 * prompt is "Can you code?" and happens to mention an honest gap is not an
 * authoritative answer to "What is Bradley bad at?" unless the prompt itself
 * asks that.
 *
 * Returns null when no record matches.
 */
function findAuthoritativeNegativeAssessment(knowledge, question) {
  if (!knowledge) return null;
  const qLower = String(question || '').toLowerCase();

  // Classify the user question by the kind of negative assessment it requests.
  // The ranked forms are the explicit superlative weakness constructions.
  // "honest" alone does not create a ranked-weakness question (it is a tenant
  // framing for documented gaps and still needs authoritative record support).
  const isRanked = /\b(?:biggest|main|primary|greatest|worst)\s+(?:honest\s+)?weakness\b/i.test(qLower);
  const isWeaknesses = /\bweakness(?:es)?\b/i.test(qLower);
  const isBadAt = /\bwhat\s+.*\s+bad\s+at\b/i.test(qLower);
  const isGap = /\b(?:honest\s+)?gap(?:s)?\b/i.test(qLower);
  if (!isRanked && !isWeaknesses && !isBadAt && !isGap) return null;

  // Direct answers are curated and authoritative.
  const directAnswers = getDirectAnswers(knowledge);
  for (const ans of directAnswers) {
    if (!Array.isArray(ans.intents) || !ans.intents.includes('direct')) continue;
    if (!Array.isArray(ans.questionPatterns)) continue;
    for (const pattern of ans.questionPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(qLower)) {
          // ranked is determined by the user's question, not by the answer text.
          // The answer may say "biggest current gap" without being an answer to
          // a "biggest weakness" question. If the user explicitly asks a ranked
          // weakness form and the pattern matches, the record is a ranked answer.
          const patternRanked = isRanked;
          return {
            source: 'directAnswers',
            path: `directAnswers.${ans.id}`,
            question: ans.questionPatterns.join(' | '),
            answer: ans.answer,
            ranked: patternRanked,
            exact: true
          };
        }
      } catch { /* skip invalid pattern */ }
    }
  }

  const weaknessRe = /\b(?:biggest|main|primary|greatest|worst)\s+(?:honest\s+)?weakness\b/i;
  const weaknessesRe = /\bweakness(?:es)?\b/i;
  const badAtRe = /\bwhat\s+.*\s+bad\s+at\b/i;
  const gapRe = /\b(?:honest\s+)?gap(?:s)?\b/i;

  // Interview stories are first-person source answers to common prompts.
  if (Array.isArray(knowledge.interviewStories)) {
    for (let i = 0; i < knowledge.interviewStories.length; i++) {
      const story = knowledge.interviewStories[i];
      const prompt = String(story?.prompt || '').toLowerCase();
      // Only match when the record prompt itself asks the same kind of
      // negative-assessment question.
      const recordRanked = weaknessRe.test(prompt);
      const recordWeaknesses = weaknessesRe.test(prompt);
      const recordBadAt = badAtRe.test(prompt);
      const recordGap = gapRe.test(prompt);
      if ((isRanked && recordRanked) ||
          (isWeaknesses && recordWeaknesses) ||
          (isBadAt && recordBadAt) ||
          (isGap && recordGap)) {
        return {
          source: 'interviewStories',
          path: `interviewStories[${i}]`,
          question: story.prompt,
          answer: story.answer,
          ranked: isRanked && recordRanked,
          exact: false
        };
      }
    }
  }

  // FAQ entries are tenant-curated Q/A pairs.
  if (Array.isArray(knowledge.faq)) {
    for (let i = 0; i < knowledge.faq.length; i++) {
      const entry = knowledge.faq[i];
      const q = String(entry?.question || '').toLowerCase();
      const recordRanked = weaknessRe.test(q);
      const recordWeaknesses = weaknessesRe.test(q);
      const recordBadAt = badAtRe.test(q);
      const recordGap = gapRe.test(q);
      if ((isRanked && recordRanked) ||
          (isWeaknesses && recordWeaknesses) ||
          (isBadAt && recordBadAt) ||
          (isGap && recordGap)) {
        return {
          source: 'faq',
          path: `faq[${i}]`,
          question: entry.question,
          answer: entry.answer,
          ranked: isRanked && recordRanked,
          exact: false
        };
      }
    }
  }

  return null;
}

/**
 * Get the subject pronouns from identity config or knowledge.
 * @param {object} knowledge
 * @returns {{subject: string, object: string, possessive: string}}
 */
function getSubjectPronouns(knowledge) {
  const id = knowledge?.identity;
  if (id?.pronouns) return id.pronouns;
  // Default to he/him/his — but this is a generic default, not tenant-specific
  return { subject: 'he', object: 'him', possessive: 'his' };
}

/**
 * Build a regex alternation of subject name tokens for use in matching.
 * Returns a string like "name1|name2|alias" or empty string if no names.
 * @param {object} knowledge
 * @returns {string}
 */
function getSubjectNamePattern(knowledge) {
  const aliases = getSubjectAliasSet(knowledge);
  const tokens = Array.from(aliases).filter(a => a.length >= 2);
  if (!tokens.length) return '';
  return tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/**
 * Get a list of known employer company names as a lowercase set.
 * Used for employment validation (checking if a claimed company is known).
 * @param {object} knowledge
 * @returns {Set<string>}
 */
function getKnownCompanySet(knowledge) {
  const companies = getKnownCompanies(knowledge);
  const set = new Set();
  for (const c of companies) {
    set.add(c.toLowerCase());
    // Also add normalized (no spaces/punct)
    set.add(c.toLowerCase().replace(/[^a-z0-9]/g, ''));
  }
  return set;
}

/**
 * Check if a knowledge category is declared complete (closed-world).
 * When complete + authoritative, absence of an entity implies FALSE.
 * When not complete, absence implies UNKNOWN.
 * @param {object} knowledge
 * @param {string} category - e.g. 'employmentHistory', 'education', 'certifications'
 * @returns {boolean}
 */
function isCategoryComplete(knowledge, category) {
  const kc = knowledge?.knowledgeCompleteness;
  if (!kc || typeof kc !== 'object') return false;
  const cat = kc[category];
  if (!cat) return false;
  return cat.complete === true || cat.mode === 'closed_world';
}

/**
 * Check if a knowledge category is declared authoritative.
 * Combined with isCategoryComplete, allows strong denial of absent facts.
 * @param {object} knowledge
 * @param {string} category
 * @returns {boolean}
 */
function isCategoryAuthoritative(knowledge, category) {
  const kc = knowledge?.knowledgeCompleteness;
  if (!kc || typeof kc !== 'object') return false;
  const cat = kc[category];
  if (!cat) return false;
  return cat.authoritative === true;
}

/**
 * Determine the semantic fact state for a subject-predicate-object triple.
 * Returns 'true', 'false', or 'unknown'.
 * - 'true': evidence or direct answer supports the claim
 * - 'false': boundary explicitly denies, OR closed-world + authoritative + absent
 * - 'unknown': no evidence and no authoritative denial
 * @param {object} knowledge
 * @param {string} category - knowledge category for closed-world check
 * @param {boolean} hasEvidence - whether positive evidence was found
 * @param {boolean} hasBoundary - whether an explicit negative boundary exists
 * @returns {'true'|'false'|'unknown'}
 */
function resolveFactState(knowledge, category, hasEvidence, hasBoundary) {
  if (hasEvidence) return 'true';
  if (hasBoundary) return 'false';
  if (isCategoryComplete(knowledge, category) && isCategoryAuthoritative(knowledge, category)) {
    return 'false';
  }
  return 'unknown';
}

module.exports = {
  getSubjectName,
  getPreferredName,
  getSubjectAliasSet,
  getSubjectTitle,
  getSubjectLocation,
  getKnownCompanies,
  getKnownSchools,
  getKnownCertifications,
  getKnownProjects,
  getProjectNameTokens,
  getKnownTechnologies,
  getBoundaries,
  getBoundariesByCategory,
  getClaimCorrections,
  findMatchingClaimCorrections,
  getDirectAnswers,
  findDirectAnswer,
  findAuthoritativeNegativeAssessment,
  getSubjectPronouns,
  getSubjectNamePattern,
  getKnownCompanySet,
  isCategoryComplete,
  isCategoryAuthoritative,
  resolveFactState,
};
