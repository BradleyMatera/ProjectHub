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
  getSubjectPronouns,
  getSubjectNamePattern,
  getKnownCompanySet,
  isCategoryComplete,
  isCategoryAuthoritative,
  resolveFactState,
};
