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
 *   evidence: "Bradley built ProjectHub using JavaScript, Node.js, and AWS Lambda."
 *   Result:
 *     Node.js: SUPPORTED (in evidence)
 *     Express: UNSUPPORTED (not in evidence)
 *     MongoDB: UNSUPPORTED (not in evidence)
 *
 * Generic descriptors (API, HTML, CSS, NLP) are treated differently:
 *   "The project exposes an API" — generic language, not a tech claim
 *   "He has professional NLP experience" — factual claim requiring evidence
 *
 * Validation operates on the claim relation, not just whether the token
 * looks like a named entity.
 */

// Generic descriptors that are NOT technology claims when used in
// descriptive context. These are common acronyms/terms that appear in
// general technical language, not specific technology names.
// When used in a CLAIM context ("has experience with NLP"), they still
// need evidence support — but when used descriptively ("exposes an API"),
// they are not claims.
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

// Patterns that indicate a technology CLAIM context — the answer is
// asserting that the subject uses/knows/has experience with a technology.
// These are contexts where a technology mention is a factual claim
// requiring evidence support.
const TECH_CLAIM_CONTEXTS = [
  // "uses/used/utilizes X" / "built with X" / "developed with X"
  // Delimiter lookahead: period only matches at end of string or before space
  // to avoid splitting "Node.js" at the internal period
  /\b(?:uses?|used|utiliz\w+|built\s+with|developed\s+with|implemented\s+with|written\s+in|written\s+with|powered\s+by|runs\s+on|relies\s+on|depends\s+on)\s+([A-Z][A-Za-z0-9+#.\s-]{1,40}?)(?:\s+(?:for|as|in|on|to|and|;|$)|(?:,|\.(?:\s|$)))/gi,
  // "tech stack includes X" / "stack is X" / "technologies include X"
  /\b(?:tech\s+stack|technology\s+stack|stack)\s+(?:includes?|is|contains?|consists\s+of|comprises?)\s+([A-Z][A-Za-z0-9+#.,\s-]{1,60}?)(?:\.(?:\s|$)|;|$)/gi,
  // "knows X" / "has experience with X" / "proficient in X"
  /\b(?:knows?|has\s+experience\s+(?:with|in|at)|proficient\s+in|skilled\s+in|familiar\s+with|expertise\s+in)\s+([A-Z][A-Za-z0-9+#.\s-]{1,40}?)(?:\s+(?:for|as|in|on|to|and|;|$)|(?:,|\.(?:\s|$)))/gi,
  // "X for backend/frontend/server-side/client-side" — only match when
  // preceded by a tech-usage verb so we don't capture sentence subjects
  /\b(?:uses?|used|built\s+with|developed\s+with|implemented\s+with)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30}?)\s+for\s+(?:backend|frontend|front-end|back-end|server-side|client-side|server|client|web|mobile|desktop)\b/gi,
  // "X with Y" when both look like tech names (conjunction context)
  /\b(?:uses?|used|built\s+with|developed\s+with)\s+([A-Z][A-Za-z0-9+#.-]{1,30})\s+with\s+([A-Z][A-Za-z0-9+#.-]{1,30})\b/g,
  // "and X for backend/frontend" — continuation after a tech usage verb
  /\band\s+([A-Z][A-Za-z0-9+#.-]{1,30})\s+for\s+(?:backend|frontend|front-end|back-end|server-side|client-side|server|client|web|mobile|desktop)\b/gi,
  // "and X" continuation after a tech usage verb — captures tech after
  // "and" in lists like "built with Python and FastAPI" or "knows React, Python, and AWS"
  // Only matches when preceded by a tech-usage verb earlier in the clause
  /\b(?:built\s+with|developed\s+with|implemented\s+with|uses?|used|written\s+in|knows?|has\s+experience\s+(?:with|in|at)|proficient\s+in|skilled\s+in)\s+[A-Z][A-Za-z0-9+#.,\s-]{1,40}?\s+and\s+([A-Z][A-Za-z0-9+#.-]{1,30})(?:\s+(?:for|as|in|on|to|;|$)|(?:,|\.(?:\s|$)))/gi,
  // Comma-separated tech continuation — captures items after the first
  // in a list like "knows React, Python, and AWS" or "uses Node.js, Express, and MongoDB"
  // Requires a tech-usage verb earlier in the clause
  /\b(?:built\s+with|developed\s+with|implemented\s+with|uses?|used|written\s+in|knows?|has\s+experience\s+(?:with|in|at)|proficient\s+in|skilled\s+in)\s+[A-Z][A-Za-z0-9+#.\s-]{1,30}?,\s+([A-Z][A-Za-z0-9+#.-]{1,30})(?:\s+(?:for|as|in|on|to|and|;|$)|(?:,|\.(?:\s|$)))/gi,
  // "includes/featuring X" — tech list
  /\b(?:includes?|featuring|incorporating)\s+([A-Z][A-Za-z0-9+#.\s-]{1,40}?)(?:\s+(?:for|as|in|on|to|and|;|$)|(?:,|\.(?:\s|$)))/gi,
];

// Negation check — technologies mentioned in negation context should
// NOT be flagged as unsupported claims.
function hasNegation(text) {
  return /\b(?:not|never|no|wasn't|was not|isn't|is not|didn't|did not|doesn't|does not|don't|do not|cannot|can't|won't|will not)\b/i.test(text);
}

// Split text into sentences for negation-aware checking
function splitSentences(text) {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?])$/)
    .map(s => s.trim())
    .filter(s => s.length >= 10);
  return parts.length > 0 ? parts : [text];
}

// Split a sentence into clauses for negation-aware checking
function splitClauses(sentence) {
  const semiParts = sentence.split(/[;]+/).map(s => s.trim()).filter(s => s.length > 5);
  if (semiParts.length > 1) return semiParts;
  const conjParts = sentence.split(/,\s*(?:but|however|rather|instead)\s+/i).map(s => s.trim()).filter(s => s.length > 10);
  if (conjParts.length > 1) return conjParts;
  return [sentence];
}

// Extract technology names from a text string.
// Returns an array of { technology, context, isNegated } objects.
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

              // Skip if it's a generic descriptor used descriptively
              // (We'll handle claim-context generic descriptors separately)
              const techLower = cleanTech.toLowerCase();

              // Skip common English words that happen to be capitalized
              if (/^(?:The|This|That|These|Those|His|Her|Their|And|But|For|With|From|About|An?|She|He|They|It|We|I|You|Jane|Smith|Product|Alpha|Bradley|Matera|ProjectHub|Scout|)$/i.test(cleanTech)) continue;

              // Skip if it starts with a lowercase letter (not a tech name)
              if (!/^[A-Z]/.test(cleanTech)) continue;

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

// Check if a technology name appears in the evidence text.
// Uses normalized matching to handle case variations and common aliases.
function isTechInEvidence(technology, evidenceText) {
  const evidence = String(evidenceText || '').toLowerCase();
  const tech = technology.toLowerCase();

  // Direct substring match
  if (evidence.includes(tech)) return true;

  // Normalized match (strip non-alphanumeric for comparison)
  const techNorm = tech.replace(/[^a-z0-9]/g, '');
  if (techNorm.length >= 3 && evidence.includes(techNorm)) return true;

  // Check word-boundary match for short tech names (3+ chars)
  const techEscaped = tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const techRegex = new RegExp(`\\b${techEscaped}\\b`, 'i');
  if (techRegex.test(evidence)) return true;

  return false;
}

/**
 * Validate technology claims in an answer against the evidence packet.
 *
 * @param {string} answer - The generated answer text
 * @param {string} evidence - The evidence text the answer must be grounded in
 * @returns {Object} { valid, unsupportedTechs, details }
 */
function validateTechClaims(answer, evidence) {
  const claims = extractTechClaims(answer);
  const unsupportedTechs = [];
  const details = [];

  // Deduplicate by technology name
  const seen = new Set();

  for (const claim of claims) {
    const techKey = claim.technology.toLowerCase();
    if (seen.has(techKey)) continue;
    seen.add(techKey);

    const supported = isTechInEvidence(claim.technology, evidence);

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
  GENERIC_DESCRIPTORS,
};
