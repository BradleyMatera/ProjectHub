'use strict';

/**
 * Technology Claim Validator — checks whether each technology mentioned in
 * an answer is supported by the evidence packet.
 *
 * This is distinct from entity fabrication validation (which checks if a
 * capitalized token exists anywhere in the knowledge base). Tech claim
 * validation checks if the specific technology claim is grounded in the
 * evidence provided for THIS question.
 *
 * Example:
 *   answer: "Uses Node.js, Express, MongoDB"
 *   evidence: "Built ProjectHub using JavaScript, Node.js, and AWS Lambda."
 *   Result:
 *     Node.js: SUPPORTED (in evidence)
 *     Express: UNSUPPORTED (not in evidence)
 *     MongoDB: UNSUPPORTED (not in evidence)
 *
 * Generic descriptors (API, HTML, CSS, NLP) are treated differently:
 *   "The project exposes an API" — generic language, not a tech claim
 *   "He has professional NLP experience" — factual claim requiring evidence
 *
 * The validator is fully portable — it contains NO hard-coded person names,
 * project names, or benchmark-specific literals. Common English words are
 * filtered generically by word class (pronouns, determiners, connectors).
 */

// Generic descriptors that are NOT technology claims when used in
// descriptive context. These are common acronyms/terms that appear in
// general technical language, not specific technology names.
// When used in a CLAIM context ("has experience with NLP"), they still
// need evidence support — but when used descriptively ("exposes an API"),
// they are not claims.
const { phraseAppears } = require('./evidence-relations');

const GENERIC_DESCRIPTORS = new Set([
  'api', 'rest', 'graphql', 'grpc', 'rpc', 'sdk', 'cli', 'gui',
  'tdd', 'bdd', 'ddd', 'ci', 'cd', 'dev', 'qa', 'ux', 'ui', 'cx',
  'seo', 'sem', 'crm', 'erp', 'cms', 'dms', 'bi', 'etl', 'olap',
  'json', 'xml', 'yaml', 'html', 'css', 'sql', 'nosql', 'dom',
  'spa', 'mpa', 'pwa', 'ssr', 'ssg', 'isr', 'csr',
  'http', 'https', 'tcp', 'udp', 'dns', 'ssl', 'tls',
  'cpu', 'gpu', 'ram', 'ssd', 'hdd',
  'ai', 'ml', 'dl', 'nlp', 'cv', 'rl', 'gan', 'llm', 'rag', 'bm25', 'rrf',
]);

// Common English words by word class — these are NOT technology names.
// No person names, project names, or benchmark-specific literals.
const COMMON_ENGLISH_WORDS = new Set([
  // Pronouns
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their', 'theirs',
  // Determiners / articles
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'some', 'any', 'all',
  'both', 'each', 'every', 'neither', 'either', 'no', 'yes',
  // Conjunctions
  'and', 'but', 'or', 'nor', 'so', 'yet', 'for', 'as', 'if', 'unless', 'until', 'while',
  'although', 'though', 'because', 'since', 'when', 'where', 'whether', 'whereas',
  // Prepositions
  'in', 'on', 'at', 'to', 'from', 'by', 'with', 'without', 'within', 'of', 'about',
  'into', 'onto', 'upon', 'over', 'under', 'between', 'among', 'through', 'across',
  // Common verbs (capitalized at start of sentence)
  'is', 'was', 'are', 'were', 'has', 'had', 'have', 'did', 'does', 'do', 'can',
  'could', 'would', 'should', 'will', 'may', 'might', 'must', 'been', 'being',
  'built', 'used', 'using', 'made', 'make', 'get', 'got', 'give', 'gave',
  'take', 'took', 'see', 'saw', 'know', 'knew', 'think', 'thought',
  'feel', 'felt', 'want', 'wanted', 'need', 'needed', 'let', 'try', 'trying',
  'going', 'show', 'showing', 'tell', 'told', 'ask', 'asked',
  // Common adjectives/adverbs
  'good', 'great', 'better', 'best', 'worst', 'bad', 'new', 'old', 'first', 'last',
  'most', 'more', 'less', 'least', 'many', 'much', 'few', 'several', 'various',
  'specific', 'general', 'particular', 'certain', 'simple', 'complex', 'clear',
  'important', 'interesting', 'useful', 'helpful', 'available', 'possible',
  'technical', 'practical', 'theoretical', 'basic', 'advanced', 'intermediate',
  'primary', 'secondary', 'main', 'major', 'minor', 'key', 'core', 'essential',
  // Common nouns (may appear capitalized at sentence start)
  'skills', 'skill', 'experience', 'experiences', 'project', 'projects',
  'work', 'working', 'role', 'roles', 'job', 'jobs', 'career', 'careers',
  'team', 'teams', 'company', 'companies', 'school', 'schools',
  'degree', 'degrees', 'education', 'certification', 'certifications',
  'technology', 'technologies', 'tech', 'stack', 'stacks',
  'frontend', 'backend', 'fullstack', 'full', 'front', 'back',
  'web', 'mobile', 'desktop', 'cloud', 'server', 'client',
  'data', 'code', 'software', 'hardware', 'system', 'systems',
  'development', 'developer', 'developers', 'engineering', 'engineer', 'engineers',
  'program', 'programming', 'programmer', 'application', 'applications',
  'gaps', 'gap', 'weaknesses', 'weakness', 'strengths', 'strength',
  'recruiters', 'recruiter', 'hiring', 'interview', 'interviews',
  'resume', 'portfolio', 'profile', 'background', 'summary',
  'professional', 'personal', 'public', 'private',
  // Discourse markers
  'however', 'therefore', 'moreover', 'furthermore', 'additionally', 'also',
  'well', 'actually', 'currently', 'unfortunately', 'honestly', 'sure',
  'correct', 'right', 'true', 'false', 'not', 'overall', 'instead', 'rather',
  'meanwhile', 'look', 'consider', 'analyze', 'based',
]);

// Patterns that indicate a technology CLAIM context — the answer is
// asserting that the subject uses/knows/has experience with a technology.
// These are contexts where a technology mention is a factual claim
// requiring evidence support.
// Patterns use /gi to match both capitalized and lowercase tech names.
const TECH_CLAIM_CONTEXTS = [
  // "uses/used/utilizes X" / "built with X" / "developed with X"
  // Delimiter lookahead: period only matches at end of string or before space
  // to avoid splitting "Node.js" at the internal period
  /\b(?:uses?|used|utiliz\w+|built\s+with|developed\s+with|implemented\s+with|written\s+in|written\s+with|powered\s+by|runs\s+on|relies\s+on|depends\s+on)\s+([A-Za-z][A-Za-z0-9+#.\s-]{1,40}?)(?:\s+(?:for|as|in|on|to|and|;)|(?:,|\.(?:\s|$))|$)/gi,
  // "tech stack includes X" / "stack is X" / "technologies include X"
  /\b(?:tech\s+stack|technology\s+stack|stack)\s+(?:includes?|is|contains?|consists\s+of|comprises?)\s+([A-Za-z][A-Za-z0-9+#.,\s-]{1,60}?)(?:\.(?:\s|$)|;|$)/gi,
  // "knows X" / "has experience with X" / "proficient in X" / "has worked with X"
  /\b(?:knows?|has\s+experience\s+(?:with|in|at)|proficient\s+in|skilled\s+in|familiar\s+with|expertise\s+in|has\s+worked\s+with|worked\s+with|has\s+used|programs?\s+in|codes?\s+in|writes?\s+in|develops?\s+in)\s+([A-Za-z][A-Za-z0-9+#.\s-]{1,40}?)(?:\s+(?:for|as|in|on|to|and|;)|(?:,|\.(?:\s|$))|$)/gi,
  // "X for backend/frontend/server-side/client-side" — only match when
  // preceded by a tech-usage verb so we don't capture sentence subjects
  /\b(?:uses?|used|built\s+with|developed\s+with|implemented\s+with)\s+([A-Za-z][A-Za-z0-9+#.\s-]{1,30}?)\s+for\s+(?:backend|frontend|front-end|back-end|server-side|client-side|server|client|web|mobile|desktop)\b/gi,
  // "X with Y" when both look like tech names (conjunction context)
  /\b(?:uses?|used|built\s+with|developed\s+with)\s+([A-Za-z][A-Za-z0-9+#.-]{1,30})\s+with\s+([A-Za-z][A-Za-z0-9+#.-]{1,30})\b/gi,
  // "and X for backend/frontend" — continuation after a tech usage verb
  /\band\s+([A-Za-z][A-Za-z0-9+#.-]{1,30})\s+for\s+(?:backend|frontend|front-end|back-end|server-side|client-side|server|client|web|mobile|desktop)\b/gi,
  // "and X" continuation after a tech usage verb — captures tech after
  // "and" in lists like "built with Python and FastAPI"
  // Only matches when preceded by a tech-usage verb earlier in the clause
  /\b(?:built\s+with|developed\s+with|implemented\s+with|uses?|used|written\s+in|knows?|has\s+experience\s+(?:with|in|at)|proficient\s+in|skilled\s+in)\s+[A-Za-z][A-Za-z0-9+#.,\s-]{1,40}?\s+and\s+([A-Za-z][A-Za-z0-9+#.-]{1,30})(?:\s+(?:for|as|in|on|to|;)|(?:,|\.(?:\s|$))|$)/gi,
  // Comma-separated tech continuation — captures items after the first
  // in a list like "knows React, Python, and AWS"
  // Requires a tech-usage verb earlier in the clause
  /\b(?:built\s+with|developed\s+with|implemented\s+with|uses?|used|written\s+in|knows?|has\s+experience\s+(?:with|in|at)|proficient\s+in|skilled\s+in)\s+[A-Za-z][A-Za-z0-9+#.\s-]{1,30}?,\s+([A-Za-z][A-Za-z0-9+#.-]{1,30})(?:\s+(?:for|as|in|on|to|and|;)|(?:,|\.(?:\s|$))|$)/gi,
  // "includes/featuring X" — tech list
  /\b(?:includes?|featuring|incorporating)\s+([A-Za-z][A-Za-z0-9+#.\s-]{1,40}?)(?:\s+(?:for|as|in|on|to|and|;)|(?:,|\.(?:\s|$))|$)/gi,
];

// Negation check — technologies mentioned in negation context should
// NOT be flagged as unsupported claims.
function hasNegation(text) {
  return /\b(?:not|never|no|wasn't|was not|isn't|is not|didn't|did not|doesn't|does not|don't|do not|cannot|can't|won't|will not)\b/i.test(text);
}

// Split text into sentences for negation-aware checking
function splitSentences(text) {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Za-z])|(?<=[.!?])$/)
    .map(s => s.trim())
    .filter(s => s.length >= 10);
  return parts.length > 0 ? parts : [text];
}

// Split a sentence into clauses for negation-aware checking.
// Each clause is checked independently for negation so that
// "She does not use Express but uses React" correctly separates
// the negated Express clause from the affirmative React clause.
function splitClauses(sentence) {
  // Split on semicolons first
  const semiParts = sentence.split(/[;]+/).map(s => s.trim()).filter(s => s.length > 5);
  if (semiParts.length > 1) return semiParts;
  // Split on "No, ..." / "Yes, ..." discourse markers
  if (/^(?:no|yes|correct|right),\s/i.test(sentence)) {
    const parts = sentence.split(/,\s*(?=\w)/).map(s => s.trim()).filter(s => s.length > 5);
    if (parts.length > 1) return parts;
  }
  // Split on contrastive conjunctions (but, however, rather, instead)
  const conjParts = sentence.split(/\s+(?:but|however|rather|instead)\s+/i).map(s => s.trim()).filter(s => s.length > 5);
  if (conjParts.length > 1) return conjParts;
  // Also split on ", not X" trailing negation: "She uses React, not Vue"
  const notParts = sentence.split(/,\s*(?:not|never)\s+/i).map(s => s.trim()).filter(s => s.length > 5);
  if (notParts.length > 1) return notParts;
  return [sentence];
}

// Canonicalize a technology name for comparison.
// Uses the same normalization approach as canonical-entities.js normalizeEntity:
// lowercase + strip all non-alphanumeric characters.
// "Node.js" → "nodejs", "NodeJS" → "nodejs", "Next.js" → "nextjs"
function canonicalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Known punctuation aliases — technology names that have common
// alternative spellings. These are generic, not person/project specific.
const TECH_ALIASES = new Map([
  ['nodejs', 'nodejs'],
  ['node', 'nodejs'],
  ['nextjs', 'nextjs'],
  ['next', 'nextjs'],
  ['csharp', 'csharp'],
  ['c#', 'csharp'],
  ['cplusplus', 'cplusplus'],
  ['c++', 'cplusplus'],
  ['golang', 'golang'],
  ['go', 'golang'],
  ['postgresql', 'postgresql'],
  ['postgres', 'postgresql'],
  ['mongodb', 'mongodb'],
  ['mongo', 'mongodb'],
  ['reactjs', 'reactjs'],
  ['react', 'reactjs'],
  ['vuejs', 'vuejs'],
  ['vue', 'vuejs'],
  ['expressjs', 'expressjs'],
  ['express', 'expressjs'],
  ['fastapi', 'fastapi'],
  ['fast-api', 'fastapi'],
  ['tailwindcss', 'tailwindcss'],
  ['tailwind', 'tailwindcss'],
]);

// Resolve a canonicalized tech name through the alias map.
function resolveAlias(canonical) {
  return TECH_ALIASES.get(canonical) || canonical;
}

// Extract technology tokens from evidence text for normalized comparison.
// Returns a Set of canonicalized, alias-resolved tokens.
function extractEvidenceTokens(evidenceText) {
  const evidence = String(evidenceText || '');
  const tokens = new Set();

  // Extract all word-like tokens (including dots, hashes, plus signs)
  const rawTokens = evidence.match(/[A-Za-z][A-Za-z0-9+#.-]{1,40}/g) || [];
  for (const token of rawTokens) {
    const canonical = canonicalize(token);
    if (canonical.length < 2) continue;
    const resolved = resolveAlias(canonical);
    tokens.add(resolved);
    // Also add the unresolved form for direct matching
    tokens.add(canonical);
  }

  return tokens;
}

// Check if a technology name appears in the evidence text.
// Uses true normalized token-sequence comparison on BOTH sides with the same
// canonicalizer and alias resolver, avoiding unsafe substring matches like
// "Go" matching "Google" and supporting multi-word techs like
// "vanilla JavaScript".
//
// knownTechnologies may be used to assist alias recognition in the future,
// but it is intentionally NOT used to override explicit scoped RAG evidence.
function isTechInEvidence(technology, evidenceText, knownTechnologies = null) {
  if (!technology || !evidenceText) return false;
  const techCanonical = canonicalize(technology);
  if (techCanonical.length < 2) return false;

  // If a set of known technologies is supplied, the claim must match a
  // documented skill/project tech. This stops boundary/FAQ text that merely
  // names a technology (e.g. "rust-not-documented") from being treated as
  // supporting evidence.
  if (knownTechnologies && knownTechnologies.size > 0) {
    const resolved = resolveAlias(techCanonical);
    const known = knownTechnologies.has(techCanonical) || knownTechnologies.has(resolved);
    if (!known) return false;
  }

  const tokenNormalizer = (token) => resolveAlias(canonicalize(token));
  return phraseAppears(evidenceText, technology, tokenNormalizer);
}

// Extract technology names from a text string.
// Returns an array of { technology, context, isNegated } objects.
// Works with both capitalized and lowercase technology names by using
// claim context patterns rather than relying on capitalization.
function extractTechClaims(answer) {
  const text = String(answer || '').trim();
  if (!text) return [];

  const sentences = splitSentences(text);
  const claims = [];

  for (const sentence of sentences) {
    const clauses = splitClauses(sentence);
    const clauseNegation = clauses.map(c => hasNegation(c));

    for (let cIdx = 0; cIdx < clauses.length; cIdx++) {
      const clause = clauses[cIdx];
      const isNegated = clauseNegation[cIdx];

      // Skip negated clauses — "does not use Express" is a refutation
      if (isNegated) continue;

      // Extract technologies from claim contexts
      for (const pattern of TECH_CLAIM_CONTEXTS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(clause)) !== null) {
          // The captured group(s) contain technology name(s)
          for (let g = 1; g < match.length; g++) {
            const rawTech = match[g];
            if (!rawTech) continue;

            // Split on commas and "and" to get individual technologies
            const techParts = rawTech.split(/,\s*|\s+and\s+/)
              .map(t => t.replace(/^and\s+/i, '').trim())
              .filter(t => t.length >= 2);

            for (const tech of techParts) {
              // Clean trailing punctuation and prepositional clauses
              const cleanTech = tech
                .replace(/\s+(?:as|in|on|for|with|by|to|using|during|while|at|and|,|\.|;|$).*$/i, '')
                .replace(/[.,!?;)]+$/, '')
                .trim();

              if (!cleanTech || cleanTech.length < 2) continue;

              const techLower = cleanTech.toLowerCase();

              // Skip common English words (pronouns, determiners, connectors, etc.)
              // No person/project/benchmark-specific literals — purely word-class based
              if (COMMON_ENGLISH_WORDS.has(techLower)) continue;

              // Skip if the first word is a common English word (e.g. "The project")
              const firstWord = techLower.split(/\s+/)[0];
              if (COMMON_ENGLISH_WORDS.has(firstWord)) continue;

              claims.push({
                technology: cleanTech,
                context: clause.trim(),
                isNegated: false,
              });
            }
          }
        }
      }
    }
  }

  return claims;
}

/**
 * Validate technology claims in an answer against the evidence packet.
 *
 * @param {string} answer - The generated answer text
 * @param {string} evidence - The evidence text the answer must be grounded in
 * @param {Set|null} knownTechnologies - Optional set of canonicalized known techs
 * @returns {Object} { valid, unsupportedTechs, details }
 */
function validateTechClaims(answer, evidence, knownTechnologies = null) {
  const claims = extractTechClaims(answer);
  const unsupportedTechs = [];
  const details = [];

  // Deduplicate by technology name (case-insensitive)
  const seen = new Set();

  for (const claim of claims) {
    const techKey = claim.technology.toLowerCase();
    if (seen.has(techKey)) continue;
    seen.add(techKey);

    const supported = isTechInEvidence(claim.technology, evidence, knownTechnologies);

    if (!supported) {
      // Check if this is a generic descriptor used in a claim context
      // Generic descriptors in claim contexts ("has NLP experience") still
      // need evidence, but we mark them differently
      const isGeneric = GENERIC_DESCRIPTORS.has(techKey);

      unsupportedTechs.push({
        technology: claim.technology,
        isGeneric,
        context: claim.context.slice(0, 100),
      });

      details.push({
        technology: claim.technology,
        verdict: 'unsupported_tech_claim',
        message: `Technology "${claim.technology}" not found in evidence packet`,
        isGeneric,
      });
    } else {
      details.push({
        technology: claim.technology,
        verdict: 'supported',
        message: `Technology "${claim.technology}" found in evidence packet`,
      });
    }
  }

  return {
    valid: unsupportedTechs.length === 0,
    unsupportedTechs,
    details,
  };
}

module.exports = {
  extractTechClaims,
  isTechInEvidence,
  validateTechClaims,
  canonicalize,
  resolveAlias,
  extractEvidenceTokens,
  GENERIC_DESCRIPTORS,
  COMMON_ENGLISH_WORDS,
};
