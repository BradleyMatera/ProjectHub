'use strict';

/**
 * Claim Extractor — deterministic linguistic claim extraction.
 *
 * Extracts (subject, relation, object) triples from generated answer text
 * WITHOUT using an LLM. Uses canonical entity detection, sentence/clause
 * splitting, and relation phrase normalization to identify factual claims.
 *
 * The goal is NOT perfect NLP. The goal is to catch high-risk entity
 * relationship inventions:
 *
 *   "ProjectHub was built during his time at Amazon"
 *     → (ProjectHub, built_during, Amazon) → check graph
 *
 *   "His AWS capstone used React"
 *     → (AWS capstone, uses_tech, React) → check graph
 *
 *   "He has expertise in AWS services"
 *     → (he, has_expertise, AWS) → check graph (expertise is overclaim)
 *
 * Relation classes are normalized from natural language:
 *   "used", "uses", "built with", "included", "leveraged" → uses_tech
 *   "worked at", "was at", "employed at"                  → worked_at
 *   "interned at", "was an intern at"                     → interned_at
 *   "built", "developed", "created", "made"               → built_by
 *   "has a degree from", "graduated from"                 → has_degree
 *   "has a certification", "is certified"                 → has_cert
 *   "has expertise in", "is expert in"                    → has_expertise (OVERCLAIM)
 *   "has experience with"                                  → has_experience
 *
 * The extractor also classifies claim type:
 *   FACT          — asserts a specific relationship
 *   INTERPRETATION — reasoned judgment ("probably his strongest")
 *   COMPARISON    — compares two entities
 *   NEGATION      — refutes a claim ("was not senior")
 */

const { normalizeEntity } = require('./canonical-entities');

// Check if a sentence contains negation (for skipping overclaim in negated context)
function hasNegationInSentence(text) {
  return /\b(?:not|no|never|neither|nor|without|doesn't|don't|isn't|wasn't|won't|can't|cannot|couldn't|shouldn't|wouldn't|hasn't|haven't|hadn't|aren't|weren't)\b/i.test(text);
}

// --- Relation phrase patterns ---
// Each pattern maps natural language to a semantic relation class.
// Patterns are checked in order; first match wins.
const RELATION_PATTERNS = [
  // Negation patterns (refuting a claim) — high priority
  { re: /\b(?:was|is|was not|is not|wasn't|isn't)\s+(?:a\s+)?(?:senior|lead|principal|staff|expert|manager)\b/i, relation: 'negates_seniority', type: 'NEGATION' },
  { re: /\b(?:did not|didn't|never|no)\s+(?:work|intern|study|attend|have|earn|get)\b/i, relation: 'negates_claim', type: 'NEGATION' },
  { re: /\bnot\s+(?:a\s+)?(?:senior|production|expert|lead|manager|architect)\b/i, relation: 'negates_claim', type: 'NEGATION' },

  // Expertise/overclaim patterns (these are ALWAYS suspicious)
  { re: /\b(?:has|have|with)\s+(?:extensive|deep|strong|broad)\s+experience\s+(?:in|with|at)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/i, relation: 'has_extensive_experience', type: 'FACT', overclaim: true },
  { re: /\b(?:expertise|expert)\s+(?:in|with|at)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/i, relation: 'has_expertise', type: 'FACT', overclaim: true },
  { re: /\b(?:specializ\w+)\s+(?:in|with|at)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/i, relation: 'specializes_in', type: 'FACT', overclaim: true },
  { re: /\b(?:proficient|proficiency)\s+(?:in|with)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/i, relation: 'proficient_in', type: 'FACT', overclaim: true },
  { re: /\b(?:adept)\s+(?:in|with|at)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/i, relation: 'adept_at', type: 'FACT', overclaim: true },

  // Technology usage patterns — "X uses/used Y" or "X built with Y"
  // Only match specific tech usage verbs, NOT "includes" (too broad for education context)
  // "X is built/developed using Y" is handled by a separate pattern to avoid capturing "is" in subject
  // Character class includes apostrophe for possessives (ProjectHub's)
  // Subject must be a proper noun phrase — reject if it contains "is an/a" or "that"
  { re: /\b([A-Z][A-Za-z0-9+#.'\s-]{2,40}?)\s+(?:uses?|used|built with|developed with|implemented with|leveraged)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/i, relation: 'uses_tech', type: 'FACT' },
  // "X is built/developed/created using/with Y" — separate pattern to avoid capturing "is" in subject
  { re: /\b([A-Z][A-Za-z0-9+#.'\s-]{2,40}?)\s+(?:is|was|are|were)\s+(?:built|developed|created|made|written|designed|implemented)\s+(?:with|using|in|on)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/i, relation: 'uses_tech', type: 'FACT' },
  { re: /\b(?:his|her|their)\s+([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:uses?|used|built with|developed with)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/i, relation: 'uses_tech', type: 'FACT' },

  // Built/created patterns — "X was built/developed/created during/while/at Y"
  // Allow words between the verb and the temporal clause (e.g., "built by Scout during")
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:was|is)\s+(?:built|developed|created|made|written|designed)\b[^.]*?(?:during|while|at)\s+(?:his\s+|her\s+|their\s+)?(?:internship\s+at\s+|time\s+at\s+|work\s+at\s+)?([A-Z][A-Za-z0-9+#.\s&-]{2,40})/i, relation: 'built_during', type: 'FACT' },
  { re: /\b(?:he|she|they|bradley|brad)\s+(?:built|developed|created|made|wrote|designed)\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'built_by', type: 'FACT' },

  // Employment patterns
  { re: /\b(?:he|she|they|bradley|brad)\s+(?:worked|was|employed|spent time)\s+(?:at|for)\s+([A-Z][A-Za-z0-9+#.\s&-]{2,40})/i, relation: 'worked_at', type: 'FACT' },
  { re: /\b(?:he|she|they|bradley|brad)\s+(?:interned|was an intern|was a trainee)\s+(?:at|for)\s+([A-Z][A-Za-z0-9+#.\s&-]{2,40})/i, relation: 'interned_at', type: 'FACT' },
  { re: /\b(?:his|her|their)\s+(?:time|internship|work|experience)\s+(?:at|with)\s+([A-Z][A-Za-z0-9+#.\s&-]{2,40})/i, relation: 'worked_at', type: 'FACT' },

  // Education patterns
  { re: /\b(?:he|she|they|bradley|brad)\s+(?:has|holds?|earned|received|got)\s+(?:a\s+)?([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:from|at)\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'has_degree', type: 'FACT' },
  { re: /\b(?:he|she|they|bradley|brad)\s+(?:graduated from|attended|studied at)\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'attended', type: 'FACT' },

  // Certification patterns
  { re: /\b(?:he|she|they|bradley|brad)\s+(?:has|holds?|earned|received|completed)\s+(?:(?:a|the)\s+)?([A-Z][A-Za-z0-9+#.\s-]{5,50}\s+cert\w*)/i, relation: 'has_cert', type: 'FACT' },
  { re: /\b(?:he|she|they|bradley|brad)\s+(?:is|was)\s+(?:a\s+)?([A-Z][A-Za-z0-9+#.\s-]{5,50}\s+cert\w*)/i, relation: 'has_cert', type: 'FACT' },

  // "X is a Y" (type assertion) — only match short, specific type nouns
  // Avoid matching long descriptive phrases like "AI recruiter assistant named Scout"
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:is|was)\s+(?:a|an)\s+([a-z][a-z]+(?:\s+[a-z]+){0,2})\b/i, relation: 'is_type', type: 'FACT' },

  // Experience claim — "has experience in/with X"
  // X must be a specific entity (tech, company, role), not a gerund (building, developing)
  { re: /\b(?:has|have|with)\s+(?:\d+\s+years?\s+of\s+)?experience\s+(?:in|with|at)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/i, relation: 'has_experience', type: 'FACT' },

  // Interpretation/comparison patterns (not factual claims)
  { re: /\b(?:probably|likely|seems|appears|might be|could be|i think|i believe|i'd say)\b/i, relation: null, type: 'INTERPRETATION' },
  { re: /\b(?:strongest|best|most complex|most impressive|favorite|coolest|most interesting)\b/i, relation: null, type: 'COMPARISON' },
];

// --- Known entity detection helpers ---
// These help identify entities in extracted claims. The actual entity
// registry is built from the knowledge base at runtime.

/**
 * Extract claims from an answer text.
 *
 * @param {string} answer - The generated answer text
 * @param {Object} graph - The relationship graph (for entity identification)
 * @param {string} question - The user's question (for coreference resolution)
 * @returns {Array} Array of claim objects: { subject, relation, object, type, raw, overclaim }
 */
function extractClaims(answer, graph, question = '') {
  const text = String(answer || '');
  if (text.length < 10) return [];

  const claims = [];
  const sentences = splitSentences(text);

  // Coreference resolution: find the primary entity from the question
  // to resolve "It", "This", "That" at the start of sentences
  let primaryEntity = null;
  if (question) {
    // Skip question words (Compare, Tell, What, Does, Has, Is, Was, etc.)
    const questionWords = new Set(['Compare', 'Tell', 'What', 'Does', 'Has', 'Is', 'Was',
      'How', 'Why', 'When', 'Where', 'Who', 'Which', 'Give', 'Summarize', 'Describe',
      'Explain', 'Show', 'List', 'Are', 'Were', 'Have', 'Had', 'Did', 'Do', 'Can',
      'Could', 'Would', 'Should', 'Will', 'May', 'Might', 'Must', 'Please', 'Kindly',
      'He', 'She', 'They', 'His', 'Her', 'Their', 'About', 'For', 'With', 'From',
      'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'And', 'Or', 'But', 'To',
      'In', 'On', 'At', 'By', 'Of', 'As', 'So', 'If', 'Then', 'Else', 'Also',
      'Just', 'Only', 'Even', 'Still', 'Now', 'Here', 'There', 'Very', 'Quite',
      'Really', 'Actually', 'Basically', 'Essentially', 'Simply', 'Merely',
      'Versus', 'VS', 'Between', 'Against', 'Like', 'Unlike', 'Than']);
    // Extract individual words and multi-word phrases from the question
    // Split into words first, then try to build entity names from consecutive capitalized words
    const words = question.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const word = words[i].replace(/[^A-Za-z0-9+#.\-]/g, '');
      if (!word || !/^[A-Z]/.test(word)) continue;
      if (questionWords.has(word)) continue;

      // Try single word first
      let wNorm = normalizeEntity(word);
      if (graph.entityIndex && graph.entityIndex.has(wNorm)) {
        primaryEntity = word;
        break;
      }

      // Try multi-word entity (up to 4 consecutive capitalized words)
      let phrase = word;
      for (let j = i + 1; j < Math.min(i + 5, words.length); j++) {
        const nextWord = words[j].replace(/[^A-Za-z0-9+#.\-]/g, '');
        if (!nextWord || !/^[A-Z]/.test(nextWord)) break;
        if (questionWords.has(nextWord)) break;
        phrase += ' ' + nextWord;
        const pNorm = normalizeEntity(phrase);
        if (graph.entityIndex.has(pNorm)) {
          primaryEntity = phrase;
          break;
        }
        // Check fuzzy match
        for (const key of graph.entityIndex.keys()) {
          if (key.length >= 4 && (key.includes(pNorm) || pNorm.includes(key))) {
            primaryEntity = phrase;
            break;
          }
        }
        if (primaryEntity) break;
      }
      if (primaryEntity) break;

      // Check fuzzy match for single word
      for (const key of graph.entityIndex.keys()) {
        if (key.length >= 4 && (key.includes(wNorm) || wNorm.includes(key))) {
          primaryEntity = word;
          break;
        }
      }
      if (primaryEntity) break;
    }
  }

  for (const sentence of sentences) {
    // Resolve coreference: replace leading "It", "This", "That" with primary entity
    let resolvedSentence = sentence;
    if (primaryEntity) {
      resolvedSentence = sentence.replace(
        /^(It|This|That|The project|The system)\s+(is|was|uses|used|has|integrates|includes|involves|built|developed|created)\b/i,
        `${primaryEntity} $2`
      );
    }
    // Check for interpretation/comparison markers first
    let sentenceType = 'FACT';
    for (const pattern of RELATION_PATTERNS) {
      if (pattern.type === 'INTERPRETATION' && pattern.re.test(resolvedSentence)) {
        sentenceType = 'INTERPRETATION';
        break;
      }
      if (pattern.type === 'COMPARISON' && pattern.re.test(resolvedSentence)) {
        sentenceType = 'COMPARISON';
        break;
      }
    }

    // Extract factual claims
    for (const pattern of RELATION_PATTERNS) {
      if (pattern.type === 'NEGATION') {
        if (pattern.re.test(resolvedSentence)) {
          claims.push({
            subject: null,
            relation: pattern.relation,
            object: null,
            type: 'NEGATION',
            raw: sentence.trim(),
            overclaim: false
          });
        }
        continue;
      }

      if (pattern.type !== 'FACT') continue;

      const match = resolvedSentence.match(pattern.re);
      if (!match) continue;

      // Skip overclaim claims in negated context — "not an expert in React"
      // is a refutation, not an overclaim.
      if (pattern.overclaim && hasNegationInSentence(resolvedSentence)) continue;

      // Extract subject and object from match groups
      let subject = null, object = null;

      if (pattern.relation === 'uses_tech') {
        // Two patterns: "X uses Y" or "his X uses Y"
        if (match[1] && match[2]) {
          subject = match[1].trim();
          object = match[2].trim();
        }
      } else if (pattern.relation === 'built_during') {
        if (match[1] && match[2]) {
          subject = match[1].trim();
          object = match[2].trim();
        }
      } else if (pattern.relation === 'built_by') {
        if (match[1]) {
          subject = 'subject'; // he/she/bradley
          object = match[1].trim();
        }
      } else if (pattern.relation === 'worked_at' || pattern.relation === 'interned_at' || pattern.relation === 'attended') {
        if (match[1]) {
          subject = 'subject';
          object = match[1].trim();
        }
      } else if (pattern.relation === 'has_degree') {
        if (match[1] && match[2]) {
          subject = 'subject';
          object = match[2].trim(); // school is the key entity
        }
      } else if (pattern.relation === 'has_cert') {
        if (match[1]) {
          subject = 'subject';
          object = match[1].trim();
          // Strip leading verbs/articles that slip through due to case-insensitive matching
          // e.g., "completed the AWS Certified" → "AWS Certified"
          object = object.replace(/^(?:completed|earned|received|holds?)\s+(?:the\s+)?/i, '');
        }
      } else if (pattern.relation === 'is_type') {
        if (match[1] && match[2]) {
          subject = match[1].trim();
          object = match[2].trim();
        }
      } else if (pattern.relation === 'has_experience' || pattern.relation === 'has_expertise' ||
                 pattern.relation === 'has_extensive_experience' || pattern.relation === 'specializes_in' ||
                 pattern.relation === 'proficient_in' || pattern.relation === 'adept_at') {
        if (match[1]) {
          subject = 'subject';
          object = match[1].trim();
        }
      }

      if (subject || object) {
        const cleanedSubject = subject ? cleanEntityName(subject) : subject;
        const cleanedObject = object ? cleanEntityName(object) : object;
        // Skip claim if both subject and object were cleaned to null
        if (!cleanedSubject && !cleanedObject) continue;
        claims.push({
          subject: cleanedSubject,
          relation: pattern.relation,
          object: cleanedObject,
          type: sentenceType === 'INTERPRETATION' ? 'INTERPRETATION' : 'FACT',
          raw: sentence.trim(),
          overclaim: !!pattern.overclaim
        });
      }
    }

    // If no claims were extracted but the sentence has interpretation markers,
    // record it as an interpretation (not a factual claim to validate)
    if (claims.filter(c => c.raw === sentence.trim()).length === 0 && sentenceType === 'INTERPRETATION') {
      claims.push({
        subject: null,
        relation: null,
        object: null,
        type: 'INTERPRETATION',
        raw: sentence.trim(),
        overclaim: false
      });
    }
  }

  return claims;
}

/**
 * Split text into sentences for claim extraction.
 * Handles periods in tech terms (Node.js, Next.js, etc.) by only splitting
 * on sentence-ending punctuation: periods followed by space + capital letter,
 * or exclamation/question marks.
 */
function splitSentences(text) {
  // Split on: ! or ? followed by space/end, OR . followed by space + capital letter or end
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?])$/)
    .map(s => s.trim())
    .filter(s => s.length > 10);
  return parts.length > 0 ? parts : [text];
}

/**
 * Clean up an extracted entity name by trimming at common stop words
 * and removing trailing punctuation and leading pronouns.
 * "Node.js as part of a serverless" → "Node.js"
 * "React for a web application" → "React"
 * "His AWS internship capstone" → "AWS internship capstone"
 */
function cleanEntityName(name) {
  if (!name) return name;
  let cleaned = String(name).trim();
  // Strip leading pronouns/possessives
  cleaned = cleaned.replace(/^(?:His|Her|Their|The|A|An)\s+/i, '');
  // Strip trailing possessive 's (e.g., "ProjectHub's" → "ProjectHub", "Scout's" → "Scout")
  cleaned = cleaned.replace(/['']s\b/i, '');
  // Strip leading possessive remnants (e.g., "s education" from "Scout's education")
  if (/^s\s+/i.test(cleaned) && cleaned.length > 3) {
    cleaned = cleaned.replace(/^s\s+/i, '');
  }
  // Truncate at common stop words that indicate the entity name has ended
  const stopWords = /\s+(?:as|for|in|at|to|from|with|by|on|of|is|was|are|were|and|or|but|including|such|like|part|which|that|while|during|because|since)\s+/i;
  const stopMatch = cleaned.match(stopWords);
  if (stopMatch) {
    cleaned = cleaned.slice(0, stopMatch.index);
  }
  // Remove trailing punctuation (but keep periods in tech names like Node.js)
  cleaned = cleaned.replace(/[,;:]+$/, '');
  // Remove trailing period that's not part of a tech name
  // Keep "Node.js" but remove trailing "." from "Amazon."
  if (cleaned.length > 4 && cleaned.endsWith('.') && !cleaned.match(/[a-z]\.[a-z]/i)) {
    cleaned = cleaned.slice(0, -1);
  }
  // Skip if the cleaned name is too short or is a common word fragment
  if (cleaned.length < 3) return null;
  // Skip common non-entity phrases that slip through
  // Match both single words and common multi-word phrases
  const nonEntities = /^(?:that|this|these|those|which|where|when|what|project|tech|stack|backend|frontend|system|part|focus|focused|involves|involving|includes?|utilizes?|leveraged|developed|built|created|designed|implemented|used|uses|using|tech stack|that focused|that focuses|that used|that uses|that includes|that utilizes|that involves|that leverages|project where|project that|part of|part where)$/i;
  if (nonEntities.test(cleaned)) return null;
  // Also reject phrases starting with "that" or ending with "focused/includes"
  if (/^(?:that|which|where)\s+/i.test(cleaned)) return null;
  if (/\s+(?:focused|includes|involves|utilizes|leveraged|developed|built|created|designed|implemented)$/i.test(cleaned)) return null;
  // Reject phrases containing "is an/a" or "that" — they're sentence fragments, not entities
  if (/\s+is\s+(?:an?|the)\s+/i.test(cleaned)) return null;
  if (/^is\s+(?:an?|the)\s+/i.test(cleaned)) return null;
  if (/\s+that\s+/i.test(cleaned)) return null;
  if (/^that\s+/i.test(cleaned)) return null;
  // Reject phrases starting with "includes" or "includes working" — sentence fragments
  if (/^(?:includes?|involves?)\s+/i.test(cleaned)) return null;
  // Reject gerunds (building, developing, creating) — they're activities, not entities
  if (/^(?:building|developing|creating|designing|implementing|writing|making|crafting|providing|working|coding|programming|debugging|testing|deploying)$/i.test(cleaned)) return null;
  return cleaned.trim();
}

/**
 * Identify if a string refers to a known entity in the graph.
 * Returns the canonical entity name or null.
 */
function identifyEntity(text, graph) {
  if (!text) return null;
  const norm = normalizeEntity(text);
  if (norm.length < 3) return null;

  // Direct match
  if (graph.entityIndex.has(norm)) {
    return text;
  }

  // Partial match (entity name contains or is contained in the text)
  for (const key of graph.entityIndex.keys()) {
    if (key.length >= 4 && (key.includes(norm) || norm.includes(key))) {
      // Return the longer match (more specific)
      return key.length > norm.length ? key : norm;
    }
  }

  return null;
}

module.exports = {
  extractClaims,
  splitSentences,
  identifyEntity,
  cleanEntityName,
  RELATION_PATTERNS
};
