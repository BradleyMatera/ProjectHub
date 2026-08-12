'use strict';

// Query understanding: normalization, typo correction, intent classification,
// and contextual query rewriting (anaphora/ellipsis resolution).
// Pure JS, no dependencies. Used before retrieval to improve chunk matching.

// ============ TYPO MAP ============
const TYPO_MAP = {
  'recruter': 'recruiter', 'recruitr': 'recruiter',
  'certifcation': 'certification', 'certifcate': 'certificate',
  'experiance': 'experience', 'experence': 'experience',
  'educaton': 'education', 'eduction': 'education',
  'projct': 'project', 'porject': 'project',
  'skils': 'skills', 'sklls': 'skills',
  'javscript': 'javascript', 'javascrpt': 'javascript',
  'typescript': 'typescript',
  'engineer': 'engineer',
  'developr': 'developer',
  'intren': 'intern', 'intership': 'internship',
  'comunicat': 'communicate',
  'reliab': 'reliable',
  'portfolo': 'portfolio',
  'contact': 'contact',
};

// ============ INTENT CLASSIFICATION ============
const INTENT_RULES = [
  { intent: 'safety', re: /^(ignore|inject|system prompt|\.env|api key|password|hack|bypass|social security|birth date)/i },
  { intent: 'contact', re: /\b(email|phone|reach|linkedin|github|contact)\b/i },
  { intent: 'role-fit', re: /\b(fit|role|candidate|hire|position|target|looking for|suitable|qualified)\b/i },
  { intent: 'experience-detail', re: /\b(experience|intern|work|job|career|army|military|ciris|aws)\b/i },
  { intent: 'factual-lookup', re: /\b(skills?|certification|education|degree|gpa|project|tech|stack|language|location|based)\b/i },
  { intent: 'smalltalk', re: /^(hi|hello|hey|thanks|thank you|bye|goodbye|sup|howdy)\b/i },
  { intent: 'meta', re: /\b(scout|assistant|chatbot|widget|how do you work|what can you do)\b/i },
];

// ============ DAMERAU-LEVENSHTEIN ============
function damerauLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// ============ NORMALIZATION ============
function normalizeQuery(query) {
  let q = String(query || '')
    .toLowerCase()
    .replace(/[^\w\s\?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Apply typo map
  const words = q.split(/\s+/);
  const corrected = words.map(w => TYPO_MAP[w] || w);
  return corrected.join(' ');
}

// ============ TYPO CORRECTION ============
function correctTypos(query, vocabulary, maxDistance = 2) {
  const words = query.split(/\s+/);
  const corrected = words.map(w => {
    if (w.length <= 3) return w;
    if (vocabulary.has(w)) return w;
    // Find closest vocabulary term within maxDistance
    let best = w;
    let bestDist = maxDistance + 1;
    for (const term of vocabulary) {
      if (Math.abs(term.length - w.length) > maxDistance) continue;
      const dist = damerauLevenshtein(w, term);
      if (dist < bestDist) {
        bestDist = dist;
        best = term;
      }
    }
    return best;
  });
  return corrected.join(' ');
}

// Build vocabulary from knowledge chunks for typo correction
function buildVocabulary(chunks) {
  const vocab = new Set();
  for (const chunk of chunks) {
    const words = String(chunk.text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);
    for (const w of words) vocab.add(w);
  }
  return vocab;
}

// ============ INTENT CLASSIFICATION ============
function classifyIntent(query) {
  const q = String(query || '').toLowerCase();
  for (const rule of INTENT_RULES) {
    if (rule.re.test(q)) return rule.intent;
  }
  return 'factual-lookup'; // default
}

// ============ CONTEXTUAL QUERY REWRITING ============
// Resolve pronouns and ellipsis from conversation history.
// "What about his time as a medic?" → "Bradley medic experience relevance to [previous topic]"
function rewriteQuery(query, history) {
  const q = String(query || '').trim();
  const qLower = q.toLowerCase();

  if (!Array.isArray(history) || history.length === 0) return q;

  const lastTurn = history[history.length - 1];
  if (!lastTurn || !lastTurn.user) return q;

  const lastUser = String(lastTurn.user || '').toLowerCase();
  const lastAssistant = String(lastTurn.assistant || '').toLowerCase();

  // Detect anaphora/ellipsis patterns
  const isBareFollowup = /^(\s*)(what about|how about|and his|also what|tell me about his|his|that|it|he|more about)\b/i.test(qLower);
  const isShortQuery = qLower.split(/\s+/).length < 8;

  if (!isBareFollowup && !isShortQuery) return q;

  // Extract salient nouns from the previous user question
  const lastUserWords = lastUser
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !['about', 'what', 'how', 'tell', 'does', 'would', 'could', 'should', 'bradley', 'matera'].includes(w));

  // Extract topic keywords from the previous assistant reply
  const lastAssistantWords = lastAssistant
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !['about', 'what', 'how', 'tell', 'does', 'would', 'could', 'should', 'bradley', 'matera', 'based', 'davis', 'illinois'].includes(w));

  // Combine: keep the new query's content words + salient nouns from prior context
  const queryWords = qLower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !['what', 'about', 'how', 'and', 'also', 'tell', 'more', 'his', 'her', 'that', 'this', 'it', 'he', 'she'].includes(w));

  // Merge unique words: query first, then context
  const merged = [...new Set([...queryWords, ...lastUserWords.slice(0, 3), ...lastAssistantWords.slice(0, 3)])];

  if (merged.length < 3) return q;

  // Build rewritten query
  const rewritten = merged.slice(0, 10).join(' ');
  return rewritten;
}

// ============ FULL QUERY UNDERSTANDING PIPELINE ============
function understandQuery(query, history, chunks) {
  // 1. Normalize
  let normalized = normalizeQuery(query);

  // 2. Correct typos against vocabulary
  if (chunks && chunks.length > 0) {
    const vocab = buildVocabulary(chunks);
    normalized = correctTypos(normalized, vocab);
  }

  // 3. Classify intent
  const intent = classifyIntent(normalized);

  // 4. Contextual rewrite
  const rewritten = rewriteQuery(normalized, history);

  return {
    original: String(query || '').trim(),
    normalized,
    rewritten,
    intent,
  };
}

module.exports = {
  normalizeQuery,
  correctTypos,
  buildVocabulary,
  classifyIntent,
  rewriteQuery,
  understandQuery,
  damerauLevenshtein,
  TYPO_MAP,
  INTENT_RULES,
};
