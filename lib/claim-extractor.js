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

// Configurable subject names for claim extraction.
// These are pronoun alternatives used in regex patterns to detect claims about the candidate.
// For portability, override via environment variable or knowledge profile.
// Default includes common short names that might appear as subject references.
const SUBJECT_NAMES = (process.env.SCOUT_SUBJECT_NAMES || 'bradley,brad')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Build a regex alternation string from subject names (escaped)
// Used as: (?:he|she|they<subjectAlt>) where subjectAlt is either empty or |name1|name2
const subjectAlt = SUBJECT_NAMES.length > 0
  ? '|' + SUBJECT_NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  : '';

// Check if a sentence contains negation (for skipping overclaim in negated context)
function hasNegationInSentence(text) {
  return /\b(?:not|no|never|neither|nor|without|doesn't|don't|isn't|wasn't|won't|can't|cannot|couldn't|shouldn't|wouldn't|hasn't|haven't|hadn't|aren't|weren't)\b/i.test(text);
}

// --- Relation phrase patterns ---
// Each pattern maps natural language to a semantic relation class.
// Patterns are checked in order; first match wins.
const RELATION_PATTERNS = [
  // Denial patterns — negative factual claims that require validation.
  // "X are not publicly available" → denial_of_availability(X)
  // "X does not exist" / "there is no X" → denial_of_existence(X)
  // "no evidence of X" / "no proof of X" → denial_of_existence(X)
  // These are NOT simple negations (refuting a false premise) — they are
  // assertions that something does NOT exist, which can be factually wrong
  // if the thing DOES exist in the knowledge base.
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:are|is)\s+not\s+(?:publicly\s+)?available\b/i, relation: 'denial_of_availability', type: 'DENIAL' },
  { re: /\b(?:there\s+is\s+no|there\s+are\s+no|no)\s+([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:in\s+(?:the\s+)?(?:provided\s+)?evidence|listed|mentioned|available|publicly)\b/i, relation: 'denial_of_existence', type: 'DENIAL' },
  { re: /\b(?:no\s+evidence|no\s+proof)\s+(?:of|for|that)\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'denial_of_existence', type: 'DENIAL' },
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:do(?:es)?\s+not|don'?t|doesn'?t)\s+exist\b/i, relation: 'denial_of_existence', type: 'DENIAL' },
  { re: /\b(?:has|have)\s+no\s+([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\b/i, relation: 'denial_of_existence', type: 'DENIAL' },

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

  // Technology usage patterns — "X uses/used/utilizes Y" or "X built with Y"
  // Only match specific tech usage verbs, NOT "includes" (too broad for education context)
  // "X is built/developed using Y" is handled by a separate pattern to avoid capturing "is" in subject
  // Character class includes apostrophe for possessives (ProjectHub's)
  // Subject must be a proper noun phrase — reject if it contains "is an/a" or "that"
  { re: /\b([A-Z][A-Za-z0-9+#.'\s-]{2,40}?)\s+(?:[Uu]ses?|[Uu]sed|[Tt]utiliz\w+|[Rr]elies on|[Dd]epends on|[Rr]uns on|is built on|built with|developed with|implemented with|[Ll]everaged|[Ff]eatured?|incorporat\w+)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/, relation: 'uses_tech', type: 'FACT' },
  // Generic tech clause pattern: "a web application/project using Y"
  { re: /\b(?:a|an|the|various)?\s*(?:projects?|apps?|applications?|systems?|software|web\s+applications?)\s+(?:using|with|built with|developed with)\s+([A-Z][A-Za-z0-9+#.-]+)/i, relation: 'uses_tech_generic', type: 'FACT' },
  // "X is built/developed/created using/with Y" — separate pattern to avoid capturing "is" in subject
  { re: /\b([A-Z][A-Za-z0-9+#.'\s-]{2,40}?)\s+(?:is|was|are|were)\s+(?:built|developed|created|made|written|designed|implemented)\s+(?:with|using|in|on)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/, relation: 'uses_tech', type: 'FACT' },
  { re: /\b(?:his|her|their)\s+([A-Z][A-Za-z0-9+#.'\s-]{2,40}?)\s+(?:[Uu]ses?|[Uu]sed|[Tt]utiliz\w+|built with|developed with)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/, relation: 'uses_tech', type: 'FACT' },

  // Built/created patterns — "X was built/developed/created during/while/at Y"
  // Allow words between the verb and the temporal clause (e.g., "built by Scout during")
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:was|is)\s+(?:built|developed|created|made|written|designed)\b[^.]*?(?:during|while|at)\s+(?:his\s+|her\s+|their\s+)?(?:internship\s+at\s+|time\s+at\s+|work\s+at\s+)?([A-Z][A-Za-z0-9+#.\s&-]{2,40})/i, relation: 'built_during', type: 'FACT' },
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:was|is)\s+created\s+by\s+([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+during\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'built_during', type: 'FACT' },
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:designed|developed|created|built|authored)\s+(?:the\s+|a\s+|an\s+)?([A-Z][A-Za-z0-9+#.\s-]{2,40})/, relation: 'built_by', type: 'FACT' },
  { re: new RegExp('\\b(?:he|she|they' + subjectAlt + ')\\s+(?:built|developed|created|made|wrote|designed)\\s+(?:the\\s+|a\\s+|an\\s+)?([A-Z][A-Za-z0-9+#.\\s-]{2,40})', 'i'), relation: 'built_by', type: 'FACT' },

  // Employment patterns
  { re: new RegExp('\\b(?:he|she|they' + subjectAlt + ')\\s+(?:was|were|is|completed)\\s+(?:a|an)?\\s*(?:[A-Za-z0-9\\s-]{1,35}\\s+)?(?:internship|intern|trainee|employee|engineer|developer)\\s+(?:at|for)\\s+([A-Z][A-Za-z0-9+#.\\s&-]{2,40})', 'i'), relation: 'interned_at', type: 'FACT' },
  { re: new RegExp('\\b(?:he|she|they' + subjectAlt + ')\\s+(?:had|has)\\s+(?:a|an)?\\s*(?:[A-Za-z0-9\\s-]{1,35}\\s+)?(?:internship|intern|trainee|employee|engineer|developer)\\s+(?:at|for|with)\\s+([A-Z][A-Za-z0-9+#.&-]+(?:\\s+[A-Z][A-Za-z0-9+#.&-]+)*)', 'i'), relation: 'interned_at', type: 'FACT' },
  { re: new RegExp('\\b(?:he|she|they' + subjectAlt + ')\\s+(?:worked|was|employed|spent time)\\s+(?:at|for)\\s+([A-Z][A-Za-z0-9+#.&-]+(?:\\s+[A-Z][A-Za-z0-9+#.&-]+)*)', 'i'), relation: 'worked_at', type: 'FACT' },
  // "was employed by X" / "was hired by X" — reversed word order
  { re: new RegExp('\\b(?:he|she|they' + subjectAlt + ')\\s+(?:was|were|is)\\s+(?:employed|hired|contracted)\\s+(?:by|at|for)\\s+([A-Z][A-Za-z0-9+#.&-]+(?:\\s+[A-Z][A-Za-z0-9+#.&-]+)*)', 'i'), relation: 'worked_at', type: 'FACT' },
  { re: new RegExp('\\b(?:he|she|they' + subjectAlt + ')\\s+(?:interned|was an intern|was a trainee)\\s+(?:at|for)\\s+([A-Z][A-Za-z0-9+#.&-]+(?:\\s+[A-Z][A-Za-z0-9+#.&-]+)*)', 'i'), relation: 'interned_at', type: 'FACT' },
  { re: /\b(?:his|her|their)\s+(?:time|internship|work|experience)\s+at\s+([A-Z][A-Za-z0-9+#.&-]+(?:\s+[A-Z][A-Za-z0-9+#.&-]+)*)/i, relation: 'worked_at', type: 'FACT' },

  // Education patterns
  { re: new RegExp('\\b(?:he|she|they' + subjectAlt + ')\\s+(?:has|holds?|earned|received|got)\\s+(?:a\\s+)?([A-Z][A-Za-z0-9+#.\\s-]{2,40}?)\\s+(?:from|at)\\s+([A-Z][A-Za-z0-9+#.\\s-]{2,40})', 'i'), relation: 'has_degree', type: 'FACT' },
  { re: new RegExp('\\b(?:he|she|they' + subjectAlt + ')\\s+(?:graduated from|attended|studied at)\\s+([A-Z][A-Za-z0-9+#.\\s-]{2,40})', 'i'), relation: 'attended', type: 'FACT' },

  // Certification patterns
  { re: new RegExp('\\b(?:he|she|they' + subjectAlt + ')\\s+(?:has|holds?|earned|received|completed)\\s+(?:(?:a|the)\\s+)?([A-Z][A-Za-z0-9+#.\\s-]{5,50}\\s+cert\\w*)', 'i'), relation: 'has_cert', type: 'FACT' },
  { re: new RegExp('\\b(?:he|she|they' + subjectAlt + ')\\s+(?:is|was)\\s+(?:a\\s+)?([A-Z][A-Za-z0-9+#.\\s-]{5,50}\\s+cert\\w*)', 'i'), relation: 'has_cert', type: 'FACT' },
  // "He has AWS SAA" — cert abbreviation
  { re: new RegExp('\\b(?:he|she|they' + subjectAlt + ')\\s+(?:has|holds?)\\s+(AWS\\s+(?:SAA|SAP|DVA|SOA|DBS|ANS|MLS|SCS|CLF))\\b', 'i'), relation: 'has_cert', type: 'FACT' },

  // "X is a Y" (type assertion) — only match short, specific type nouns
  // Avoid matching long descriptive phrases like "AI recruiter assistant named Scout"
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:is|was)\s+(?:a|an)\s+([a-z][a-z]+(?:\s+[a-z]+){0,2})\b/i, relation: 'is_type', type: 'FACT' },

  // "X embeds/features/integrates Y" — cross-project attribution check
  // e.g. "Scout embeds the Pokedex UI" → check if supported
  // No /i flag — both subject and object must start with uppercase (proper nouns)
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:embeds|features|integrates|incorporates)\s+(?:the\s+)?([A-Z][A-Za-z0-9+#.\s-]{2,40})/, relation: 'includes', type: 'FACT' },
  // Standalone "embeds/features/integrates the [Project]" — subject may be distant
  // No /i flag — object must start with uppercase (proper noun)
  { re: /\b(?:embeds|features|integrates|incorporates)\s+(?:the\s+)?([A-Z][A-Za-z0-9+#.\s-]{2,40})/, relation: 'includes_object_only', type: 'FACT' },

  // Founder/creator-of patterns — "X is the founder of Y" or "X founded Y"
  // These capture entrepreneurial/ownership relationships
  { re: /\b([A-Z][A-Za-z0-9+#.'\s-]{2,40}?)\s+(?:is|was)\s+(?:the\s+)?(?:founder|co-?founder|creator|author|inventor)\s+of\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'founder_of', type: 'FACT' },
  { re: /\b([A-Z][A-Za-z0-9+#.'\s-]{2,40}?)\s+(?:founded|co-?founded|created|authored|invented)\s+(?:the\s+)?([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'founder_of', type: 'FACT' },
  // "X, the company behind Y" — company-to-product attribution
  { re: /\b([A-Z][A-Za-z0-9+#.\s&-]{2,40}?)\s*,?\s+(?:the\s+)?(?:company|organization|team|group)\s+behind\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'company_behind', type: 'FACT' },
  // "Y is the company behind X" — reversed word order
  { re: /\b(?:the\s+)?(?:company|organization|team|group)\s+behind\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})\s+(?:is|was)\s+([A-Z][A-Za-z0-9+#.\s&-]{2,40})/i, relation: 'company_behind', type: 'FACT' },

  // Published/deployed patterns — "X was published on Y" or "X is deployed on Y"
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:was|is|were|are)\s+(?:published|released|launched|hosted)\s+(?:on|at|via)\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'published_on', type: 'FACT' },
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:was|is|were|are)\s+deployed\s+(?:on|at|to)\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'deployed_on', type: 'FACT' },
  // "published a CodePen with X" / "a CodePen with X" — platform attribution
  // The subject is the person, the object is the project, and the platform is CodePen.
  // We extract this as deployed_on to check if the project is actually on CodePen.
  { re: /\b(?:published\s+)?a\s+CodePen\s+(?:with|featuring|containing|showcasing|including)\s+(?:an?\s+|the\s+)?([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'deployed_on', type: 'FACT', platformOverride: 'CodePen' },
  // "X on CodePen" / "X on GitHub Pages" — direct platform attribution
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+on\s+(CodePen|GitHub\s+Pages|GitHub|itch\.io)\b/i, relation: 'deployed_on', type: 'FACT' },

  // Experience claim — "has experience in/with X"
  // X must be a specific entity (tech, company, role), not a gerund (building, developing)
  { re: /\b(?:has|have|with)\s+(?:\d+\s+years?\s+of\s+)?experience\s+(?:in|with|at)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30})/i, relation: 'has_experience', type: 'FACT' },

  // Experience claim — "his/her/their experience with/in X"
  // e.g. "leveraging his experience with Kubernetes"
  { re: /\b(?:his|her|their)\s+experience\s+(?:in|with|at)\s+([A-Z][A-Za-z0-9+#.-]{1,30})/i, relation: 'has_experience', type: 'FACT' },

  // Experience claim — "has experience [gerund] [object]"
  // e.g. "has experience handling production incidents"
  // e.g. "has experience managing a team"
  { re: /\b(?:has|have|with)\s+experience\s+(?:handling|managing|leading|building|developing|creating|deploying|maintaining|operating|running|supporting|troubleshooting)\s+([a-z][a-z\s]{2,40})/i, relation: 'has_experience', type: 'FACT' },

  // Experience claim — "has X experience" (reversed word order)
  // e.g. "has Kubernetes experience", "has React experience", "has front-end experience"
  // The capture group is the technology/domain, not "experience" itself.
  // The non-greedy {1,30}? ensures we capture the tech name, not the whole sentence.
  { re: /\b(?:has|have|with)\s+([A-Z][A-Za-z0-9+#.\s-]{1,30}?)\s+experience\b/, relation: 'has_experience', type: 'FACT' },

  // Comparative claim patterns — "X is faster/better/stronger than Y"
  // These are evidence-requiring claims, not automatic overclaims.
  // The validator checks if the graph has comparative evidence to support them.
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:is|was|are|were)\s+(?:faster|better|stronger|more\s+(?:experienced|skilled|proficient|advanced|knowledgeable|capable)|superior)\s+(?:than|to)\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'comparative_advantage', type: 'COMPARATIVE_CLAIM' },
  { re: /\b([A-Z][A-Za-z0-9+#.\s-]{2,40}?)\s+(?:outperforms?|exceeds?)\s+([A-Z][A-Za-z0-9+#.\s-]{2,40})/i, relation: 'comparative_advantage', type: 'COMPARATIVE_CLAIM' },

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
 * @param {Array} history - The chat history turns (for context)
 * @returns {Array} Array of claim objects: { subject, relation, object, type, raw, overclaim }
 */
function extractClaims(answer, graph, question = '', history = []) {
  const text = String(answer || '').trim();
  if (!text) return [];

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

  // Extract a context entity for coreference resolution of pronouns like
  // "there", "that company", "that organization", "that school", "that project".
  // This is the entity mentioned in the question after "at", "with", "for", etc.
  // Example: "Tell me about his time at Microsoft." → contextEntity = "Microsoft"
  // Then "he had a brief internship there" → "he had a brief internship at Microsoft"
  let contextEntity = null;
  if (question) {
    // Look for "at X", "with X", "for X", "at X University/school/company" patterns
    const contextMatch = question.match(/\b(?:at|with|for|from)\s+([A-Z][A-Za-z0-9+#.\s&-]{2,40}?)(?:[.?,!]|$)/);
    if (contextMatch && contextMatch[1]) {
      const candidate = contextMatch[1].trim();
      const candidateNorm = normalizeEntity(candidate);
      // Must be a known entity OR a capitalized non-common word
      if (candidateNorm !== 'scout' && candidateNorm !== 'bradley' && candidateNorm !== 'matera') {
        if (graph.entityIndex && graph.entityIndex.has(candidateNorm)) {
          contextEntity = candidate;
        } else if (graph.entityIndex) {
          // Check fuzzy match
          for (const key of graph.entityIndex.keys()) {
            if (key.length >= 4 && (key.includes(candidateNorm) || candidateNorm.includes(key))) {
              contextEntity = candidate;
              break;
            }
          }
        }
        // If not in entity index but still a capitalized proper noun from the
        // question, use it — it may be an invented entity the user is asking about
        // (e.g., "Microsoft", "Netflix", "Google", "Acme Corp") that we need to
        // resolve "there" to
        if (!contextEntity && /^[A-Z][A-Za-z0-9+#.\s&-]{2,}$/.test(candidate) &&
            !/^(?:the|a|an|his|her|their|this|that|these|those|what|which|how|why|when|where|who)$/i.test(candidate)) {
          contextEntity = candidate;
        }
      }
    }
  }

  // Fallback to history for contextEntity if question didn't provide one
  if (!contextEntity && Array.isArray(history) && history.length > 0) {
    for (let i = history.length - 1; i >= 0 && !contextEntity; i--) {
      const turnText = String(history[i].text || history[i].user || history[i].assistant || '');
      const contextMatch = turnText.match(/\b(?:at|with|for|from)\s+([A-Z][A-Za-z0-9+#.\s&-]{2,40}?)(?:[.?,!]|$)/);
      if (contextMatch && contextMatch[1]) {
        const candidate = contextMatch[1].trim();
        if (!/^(?:the|a|an|his|her|their|this|that|these|those|what|which|how|why|when|where|who)$/i.test(candidate)) {
          contextEntity = candidate;
        }
      }
    }
  }

  // Fallback to history for primaryEntity if question was a referential follow-up ("there", "it", etc.)
  if (!primaryEntity && Array.isArray(history) && history.length > 0 && graph && graph.entityIndex) {
    for (let i = history.length - 1; i >= 0; i--) {
      const turnText = String(history[i].text || history[i].user || history[i].assistant || '');
      const capMatches = turnText.match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g) || [];
      for (const cap of capMatches) {
        const norm = normalizeEntity(cap);
        if (graph.entityIndex.has(norm) && norm !== 'scout' && norm !== 'bradley' && norm !== 'matera') {
          primaryEntity = cap;
          break;
        }
      }
      if (primaryEntity) break;
    }
  }

  for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
    const sentence = sentences[sIdx];
    // Resolve coreference: replace leading "It", "This", "That" with primary entity
    let resolvedSentence = sentence;
    if (primaryEntity) {
      resolvedSentence = sentence.replace(
        /^(It|This|That|The project|The system)\s+(is|was|uses|used|has|integrates|includes|involves|built|developed|created|answers|embeds|features|incorporates|contains)\b/i,
        `${primaryEntity} $2`
      );
    }

    // Resolve locative/organizational coreference: "there", "that company",
    // "that organization", "that school", "that project", "that role" → contextEntity
    // Example: "he had a brief internship there" → "he had a brief internship at Microsoft"
    if (contextEntity) {
      // "there" after a noun/verb implying location → "at <entity>"
      // e.g., "internship there" → "internship at Microsoft"
      //       "worked there" → "worked at Microsoft"
      //       "was there" → "was at Microsoft"
      resolvedSentence = resolvedSentence.replace(
        /\b(internship|intern|work(?:ed)?|job|role|position|time|experience|employed|hired|studied|attended|was|were|is)\s+there\b/gi,
        '$1 at ' + contextEntity
      );
      // Replace remaining standalone "there" → "at <entity>" only after prepositions
      resolvedSentence = resolvedSentence.replace(
        /\b(at|with|for|from|by)\s+there\b/gi,
        '$1 ' + contextEntity
      );
      // Replace "that company/organization/school/project/role" → contextEntity
      resolvedSentence = resolvedSentence.replace(
        /\bthat\s+(?:company|organization|school|project|role|program|institution)\b/gi,
        contextEntity
      );
    }

    // Resolve compound coreference ("Both", "They both", "Both projects")
    // Find all proper noun entity names mentioned in previous sentence or full text
    const prevText = sIdx > 0 ? sentences[sIdx - 1] : text;
    const compoundEntities = prevText.match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g) || [];
    const uniqueEntities = [...new Set(compoundEntities)].filter(e =>
      !/^(Both|They|This|That|These|Those|ProjectHub|Scout|Bradley|Matera|JavaScript|Node|Express|React|HTML|CSS|AWS|GitHub|Full|Sail|University)$/i.test(e) ||
      e === 'ProjectHub' || e === 'Voice Ops' || e === 'CIRIS'
    );

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

    // Split on contrastive conjunctions so negation only applies to its clause.
    // "X did not work at A, but he had an internship at B" → two clauses:
    //   1. "X did not work at A" (negated)
    //   2. "he had an internship at B" (affirmative — should be extracted)
    // Also split on commas after "despite" phrases which create contrastive context.
    // Also split "No, ..." at the start — the "No" answers the question, the
    // rest is an affirmative claim that should be extracted.
    let clauses;
    if (/\bdespite\b/i.test(resolvedSentence)) {
      // "despite not having X, he has Y" → split on the comma after the despite phrase
      clauses = resolvedSentence.split(/,\s*(?=\w)/);
    } else if (/^(?:no|yes|correct|right),\s/i.test(resolvedSentence)) {
      // "No, he has experience..." → split the discourse marker from the claim
      clauses = resolvedSentence.split(/,\s*(?=\w)/);
    } else {
      clauses = resolvedSentence.split(/\s+(?:but|however|although|though|yet|nevertheless)\b/i);
    }
    const clauseHasNegation = clauses.map(c => hasNegationInSentence(c));

    // Extract factual claims
    for (const pattern of RELATION_PATTERNS) {
      if (pattern.type === 'DENIAL') {
        // Check each clause for denial patterns independently
        for (let cIdx = 0; cIdx < clauses.length; cIdx++) {
          const dMatch = clauses[cIdx].match(pattern.re);
          if (dMatch) {
            // Extract the denied entity from the capture group
            const deniedEntity = dMatch[1] ? cleanEntityName(dMatch[1]) : null;
            claims.push({
              subject: 'subject',
              relation: pattern.relation,
              object: deniedEntity,
              type: 'DENIAL',
              raw: clauses[cIdx].trim(),
              overclaim: false
            });
          }
        }
        continue;
      }

      if (pattern.type === 'NEGATION') {
        // Check each clause for negation independently
        for (let cIdx = 0; cIdx < clauses.length; cIdx++) {
          if (pattern.re.test(clauses[cIdx])) {
            claims.push({
              subject: null,
              relation: pattern.relation,
              object: null,
              type: 'NEGATION',
              raw: clauses[cIdx].trim(),
              overclaim: false
            });
          }
        }
        continue;
      }

      if (pattern.type === 'COMPARATIVE_CLAIM') {
        for (let cIdx = 0; cIdx < clauses.length; cIdx++) {
          const m = clauses[cIdx].match(pattern.re);
          if (m && !clauseHasNegation[cIdx]) {
            claims.push({
              subject: m[1] ? cleanEntityName(m[1]) : null,
              relation: pattern.relation,
              object: m[2] ? cleanEntityName(m[2]) : null,
              type: 'COMPARATIVE_CLAIM',
              raw: clauses[cIdx].trim(),
              overclaim: false
            });
          }
        }
        continue;
      }

      if (pattern.type !== 'FACT') continue;

      // Match against each clause independently so that affirmative "but"
      // clauses are still extracted even when the first clause is negated
      let match = null;
      let matchClauseIdx = 0;
      for (let cIdx = 0; cIdx < clauses.length; cIdx++) {
        const m = clauses[cIdx].match(pattern.re);
        if (m) {
          // Skip negated clauses for FACT claims — "did not have experience"
          // should not be extracted as a has_experience FACT. Continue to
          // the next clause to find an affirmative match.
          if (clauseHasNegation[matchClauseIdx] || clauseHasNegation[cIdx]) {
            // If this clause is negated, remember it but keep looking
            if (!match) { match = m; matchClauseIdx = cIdx; }
            continue;
          }
          match = m;
          matchClauseIdx = cIdx;
          break;
        }
      }
      if (!match) continue;

      // Skip overclaim claims in negated context — "not an expert in React"
      // is a refutation, not an overclaim. Check only the matching clause.
      if (pattern.overclaim && clauseHasNegation[matchClauseIdx]) continue;
      // Skip ALL FACT claims in negated context
      if (clauseHasNegation[matchClauseIdx]) continue;

      // Extract subject and object from match groups
      let subject = null, object = null;

      if (pattern.relation === 'uses_tech') {
        if (match[1] && match[2]) {
          let cleanSubj = cleanEntityName(match[1]);
          // Check if the matched subject actually starts with an uppercase letter
          // in the original clause text. The /i flag on the regex makes [A-Z]
          // match lowercase, which can capture sentence fragments like "was the
          // AWS..." or "current weakness" as subjects.
          const matchClause = clauses[matchClauseIdx];
          const subjStartInClause = match.index;
          const origFirstChar = matchClause.charAt(subjStartInClause);
          const startsLowercase = origFirstChar && origFirstChar === origFirstChar.toLowerCase() && origFirstChar !== origFirstChar.toUpperCase();
          if (!cleanSubj || startsLowercase || /^(?:is|was|are|were|has|have|includes?|that|which|where\s+he|where\s+she|where\s+they|he|she|they)\b/i.test(cleanSubj)) {
            const leadingNounMatches = sentence.slice(0, match.index).match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g);
            if (leadingNounMatches) {
              const cleanLeading = leadingNounMatches
                .map(n => cleanEntityName(n))
                .filter(n => n && !/^(His|Her|Their|The|A|An|Where|He|She|They|This|That|These|Those)$/i.test(n));
              if (cleanLeading.length > 0) {
                cleanSubj = cleanLeading[cleanLeading.length - 1];
              }
            }
            // If we still don't have a valid subject (e.g. the matched subject
            // started with lowercase and no leading noun was found), use the
            // primary entity from context or skip this claim entirely.
            if (!cleanSubj || (startsLowercase && cleanSubj === cleanEntityName(match[1]))) {
              cleanSubj = primaryEntity || null;
              // If no primary entity either, skip this claim
              if (!cleanSubj) continue;
            }
          }

          // Clean object: strip trailing prepositional clauses like "as part of a serverless metadata workflow"
          let cleanObj = match[2].trim().replace(/\s+(?:as|in|on|for|with|by|to|using|during|while|at|and|,)\b.*$/i, '').replace(/[.,!?;)]+$/, '').trim();

          subject = cleanSubj;
          object = cleanObj;

          // Check if clause contains additional list entities (e.g. "Node.js, and Express")
          const remainder = resolvedSentence.slice(match.index + match[0].length);
          const extraEntities = remainder.match(/\b(?:and|,)\s+(?:an?\s+|the\s+|advanced\s+|AI\s+|assistant\s+|named\s+)*([A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*)\b/g) || [];
          for (const item of extraEntities) {
            const cleanItem = item.replace(/^\b(?:and|,)\s+(?:an?\s+|the\s+|advanced\s+|AI\s+|assistant\s+|named\s+)*/i, '').replace(/[.,!?;)]+$/, '').trim();
            if (cleanItem && cleanItem.length >= 2 && cleanItem !== object && !/^(And|Or|With|In|On|At|By|For|The|An?)$/i.test(cleanItem)) {
              if (cleanSubj) {
                claims.push({
                  subject: cleanSubj,
                  relation: 'uses_tech',
                  object: cleanItem,
                  type: sentenceType === 'INTERPRETATION' ? 'INTERPRETATION' : 'FACT',
                  raw: sentence.trim(),
                  overclaim: false
                });
              }
            }
          }
        }
      } else if (pattern.relation === 'uses_tech_generic') {
        if (match[1]) {
          const techName = match[1].trim().replace(/[.,!?;)]+$/, '');
          // Skip if the captured "tech" doesn't start with uppercase —
          // the regex uses /i which makes [A-Z] match lowercase, causing
          // false positives like "basic" or "simple" being extracted as tech.
          if (!/^[A-Z]/.test(techName)) {
            continue; // Skip this pattern match
          }
          // Only apply uses_tech_generic to PROJECT entities, not people or technologies
          // "Bradley uses AWS" should be has_experience, not uses_tech
          // "Node.js uses JavaScript" is a language relationship, not a project tech
          if (primaryEntity) {
            const peNorm = normalizeEntity(primaryEntity);
            // Skip if primary entity is the subject (Bradley) or a known technology
            if (peNorm === 'bradley' || peNorm === 'matera' || peNorm === 'subject') {
              continue;
            }
            // Check if primary entity is a technology (in graph as a tech, not a project)
            if (graph.entityIndex) {
              const entityInfo = graph.entityIndex.get(peNorm);
              if (entityInfo) {
                const triples = Array.isArray(entityInfo) ? entityInfo : [entityInfo];
                // If the entity only appears as objects of uses_tech/has_skill, it's a tech
                const isTech = triples.every(t => t.relation === 'uses_tech' || t.relation === 'has_skill');
                const isProject = triples.some(t => t.relation === 'built_by' || t.relation === 'is_type');
                if (isTech && !isProject) continue;
              }
            }
          }
          subject = primaryEntity || null;
          object = techName;
        }
        if (match[1] && match[2]) {
          subject = match[1].trim();
          object = match[2].trim();
        }
      } else if (pattern.relation === 'built_by') {
        if (match[1] && match[2]) {
          // Two-group pattern: "X built Y" → subject=Y (the thing), object=X (the builder)
          // This matches the graph direction: project→built_by→person
          subject = match[2].trim();
          object = match[1].trim();
        } else if (match[1]) {
          // One-group pattern: "he/bradley built X" → subject=X (the thing), object='subject' (Bradley)
          subject = match[1].trim();
          object = 'subject';
        }
        // Strip "a/an/the project/app/system called" prefix from subject
        // e.g. "a project called ProjectHub" → "ProjectHub"
        if (subject) {
          subject = subject.replace(/^(?:a|an|the)\s+(?:project|app|application|system|tool|widget|site|website|platform|software|program|demo)\s+called\s+/i, '');
        }
        // Skip if the thing-built is a preposition phrase (parse artifact)
        // e.g. "has built projects relevant to" captures "in front-end technologies"
        if (subject && /^(?:in|at|on|for|with|by|to|from|of|as)\s/i.test(subject)) {
          subject = null; object = null;
        }
        // Skip if object is a preposition phrase or sentence fragment
        if (object && /^(?:in|at|on|for|with|by|to|from|of|as|the|a|an)\s/i.test(object)) {
          subject = null; object = null;
        }
        // Skip if object is a sentence fragment (contains common verbs/articles)
        if (object && /\b(?:is|was|are|were|has|have|had|part|that|which|coolest|best|most|first|main)\b/i.test(object)) {
          subject = null; object = null;
        }
      } else if (pattern.relation === 'worked_at' || pattern.relation === 'interned_at' || pattern.relation === 'attended') {
        if (match[1]) {
          subject = 'subject';
          object = match[1].trim();
          // Strip trailing prepositional clauses like "as part of his tech experience"
          object = object.replace(/\s+(?:as|in|on|for|with|by|to|using|during|while|at|and|,)\b.*$/i, '').replace(/[.,!?;)]+$/, '').trim();
          // Strip trailing lowercase words (e.g., "Acme Corp last summer" → "Acme Corp")
          // The /i flag on patterns makes [A-Z] match lowercase, so the capture
          // group can include trailing non-entity words. This strips them.
          // NOTE: no /i flag here — we need case-sensitive matching to preserve
          // capitalized entity words like "Corp" while stripping lowercase "last"
          object = object.replace(/\s+[a-z][A-Za-z]*.*$/, '').trim();
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
          // Expand AWS cert abbreviations to full names for matching
          const certAbbrevs = {
            'AWS SAA': 'AWS Certified Solutions Architect - Associate',
            'AWS SAP': 'AWS Certified Solutions Architect - Professional',
            'AWS DVA': 'AWS Certified Developer - Associate',
            'AWS SOA': 'AWS Certified SysOps Administrator - Associate',
            'AWS CLF': 'AWS Certified Cloud Practitioner'
          };
          if (certAbbrevs[object]) object = certAbbrevs[object];
        }
      } else if (pattern.relation === 'built_during') {
        // Pattern76: project was built during internship → subject=project, object=context
        // Pattern77: project was created by person during context → subject=project, object=context
        if (match[1] && match[3]) {
          // Three-group pattern (77): project=match[1], person=match[2], context=match[3]
          subject = match[1].trim();
          object = match[3].trim();
        } else if (match[1] && match[2]) {
          // Two-group pattern (76): project=match[1], context=match[2]
          subject = match[1].trim();
          object = match[2].trim();
        }
      } else if (pattern.relation === 'is_type') {
        if (match[1] && match[2]) {
          subject = match[1].trim();
          object = match[2].trim();
        }
      } else if (pattern.relation === 'founder_of') {
        // "X is the founder of Y" → subject=X (person), object=Y (project/company)
        if (match[1] && match[2]) {
          subject = match[1].trim();
          object = match[2].trim();
        }
      } else if (pattern.relation === 'company_behind') {
        // "X, the company behind Y" → subject=X (company), object=Y (product)
        // "the company behind Y is X" → subject=X (company), object=Y (product)
        if (match[1] && match[2]) {
          subject = match[1].trim();
          object = match[2].trim();
        }
      } else if (pattern.relation === 'published_on' || pattern.relation === 'deployed_on') {
        // "X was published on Y" → subject=X (project), object=Y (platform)
        if (pattern.platformOverride) {
          // "published a CodePen with X" → subject=X (project), object=CodePen (platform)
          if (match[1]) {
            subject = match[1].trim();
            object = pattern.platformOverride;
          }
        } else if (match[1] && match[2]) {
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
      } else if (pattern.relation === 'includes') {
        if (match[1] && match[2]) {
          subject = match[1].trim();
          object = match[2].trim();
        }
      } else if (pattern.relation === 'includes_object_only') {
        if (match[1]) {
          subject = 'unknown';
          object = match[1].trim();
        }
      }

      if (subject || object) {
        const cleanedSubject = subject ? cleanEntityName(subject) : subject;
        const cleanedObject = object ? cleanEntityName(object) : object;
        // Skip claim if both subject and object were cleaned to null
        if (!cleanedSubject && !cleanedObject) continue;

        // Skip claims where the subject is a sentence-starter word
        // (e.g., "So", "Explain", "Compare") — these are not real entities
        const sentenceStarters = new Set(['So', 'Okay', 'Now', 'Then', 'But',
          'And', 'Or', 'Was', 'Is', 'Are', 'Were', 'Has', 'Have', 'Had',
          'Did', 'Does', 'Do', 'Can', 'Could', 'Would', 'Should', 'Will',
          'What', 'How', 'Why', 'When', 'Where', 'Who', 'Which', 'Tell',
          'Give', 'Compare', 'Explain', 'The', 'A', 'An', 'This', 'That',
          'These', 'Those', 'His', 'Her', 'Their', 'He', 'She', 'They',
          'It', 'For', 'With', 'From', 'About', 'In', 'On', 'At', 'To',
          'Of', 'As', 'By', 'If', 'No', 'Yes', 'There',
          'Engineer', 'Engineers', 'Developer', 'Developers', 'Architect',
          'End', 'Stack', 'Front', 'Back', 'Full']);
        if (cleanedSubject && sentenceStarters.has(cleanedSubject)) continue;

        // Skip has_experience claims with generic objects
        // (e.g., "various front-end technologies", "building websites", "various projects")
        // But DON'T skip overclaim patterns — they need to be flagged, not silenced
        // EXCEPTION: proficient_in with generic objects like "front-end technologies"
        // is generic wording, not a specific tech overclaim, so filter it out
        if ((pattern.relation === 'has_experience' || pattern.relation === 'worked_at' ||
            pattern.relation === 'proficient_in' || pattern.relation === 'has_expertise' ||
            pattern.relation === 'has_extensive_experience' || pattern.relation === 'specializes_in' ||
            pattern.relation === 'adept_at') &&
            (!pattern.overclaim || pattern.relation === 'proficient_in')) {
          const objLower = (cleanedObject || '').toLowerCase();
          const genericObjects = ['various front-end technologies', 'building websites',
            'various projects', 'building projects', 'front-end development',
            'modern web development', 'web development', 'software development',
            'client-side development', 'various technologies',
            'this technology', 'these tasks', 'these technologies',
            'full stack', 'full-stack', 'full stack engineer',
            'serverless metadata workflows', 'static websites',
            'building and maintaining systems', 'building and maintaining frontend',
            'building websites using', 'building and maintaining',
            'websites', 'front-end', 'technologies', 'projects',
            'small projects', 'basic technologies', 'simple projects',
            'front-end technologies', 'modern', 'managing', 'creating systems',
            'static gen', 'building systems', 'building and maintaining systems that',
            'systems that ship', 'systems', 'building', 'maintaining',
            'both node.js', 'both react', 'both', 'full stack engineer end',
            'creating static uis', 'cloud computing', 'static uis'];
          if (genericObjects.some(g => objLower.includes(g))) continue;
        }

        // Clean trailing punctuation/extra text from object captures
        // (e.g., "Scout. It" → "Scout") — but preserve periods in tech names
        // like "Node.js", "Next.js", etc.
        if (cleanedObject) {
          // Only strip trailing period if followed by space + capital (sentence break)
          // or if it's at the very end after a non-tech-word character
          let cleanedObj = cleanedObject;
          // Strip trailing ". X" patterns (sentence continuation captured by regex)
          cleanedObj = cleanedObj.replace(/\.\s+[A-Z].*$/, '').trim();
          // Strip trailing commas and what follows
          cleanedObj = cleanedObj.replace(/,.*$/, '').trim();
          if (cleanedObj.length < 2) continue; // Skip if cleaning removed everything
          claims.push({
            subject: cleanedSubject,
            relation: pattern.relation,
            object: cleanedObj,
            type: sentenceType === 'INTERPRETATION' ? 'INTERPRETATION' : 'FACT',
            raw: sentence.trim(),
            overclaim: !!pattern.overclaim
          });
        } else {
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
  cleaned = cleaned.replace(/^(?:His|Her|Their|The|A|An|And)\s+/i, '');
  // Strip trailing possessive 's (e.g., "ProjectHub's" → "ProjectHub", "Scout's" → "Scout")
  cleaned = cleaned.replace(/['']s\b/i, '');
  // Strip leading possessive remnants (e.g., "s education" from "Scout's education")
  if (/^s\s+/i.test(cleaned) && cleaned.length > 3) {
    cleaned = cleaned.replace(/^s\s+/i, '');
  }
  // Truncate at common stop words that indicate the entity name has ended
  const stopWords = /\s+(?:as|for|in|at|to|from|with|by|on|of|is|was|are|were|and|or|but|including|such|like|part|which|that|while|during|because|since)(?:\s+|$)/i;
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
  const nonEntities = /^(?:that|this|these|those|which|where|when|what|project|tech|stack|backend|frontend|system|part|focus|focused|involves|involving|includes?|utilizes?|leveraged|developed|built|created|designed|implemented|used|uses|using|tech stack|that focused|that focuses|that used|that uses|that includes|that utilizes|that involves|that leverages|project where|project that|part of|part where|experience|mention|provided|explicit|knowledge|practice|background|overview|context|detail|details|it does not|it does|it doesn|it is not|it is|it was not|it was|it doesn'?t|ai-related|script tag|these technologies|those technologies|other technologies|various technologies|advanced technologies|modern technologies|these tools|those tools|other tools|various tools)$/i;
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
