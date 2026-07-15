'use strict';

// Okapi BM25 retrieval index — proper TF saturation, IDF weighting, and
// document-length normalization. Replaces the naive substring scorer.
// Pure JS, no dependencies. ~300-400 chunks → build < 50ms, query < 1ms.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'his', 'her', 'he', 'she',
  'it', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'about', 'what', 'who',
  'how', 'does', 'do', 'did', 'can', 'me', 'tell', 'you', 'your', 'this',
  'that', 'on', 'at', 'i', 'be', 'been', 'being', 'have', 'has', 'had',
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
  'not', 'no', 'nor', 'so', 'than', 'too', 'very', 'just', 'but', 'if',
  'then', 'else', 'when', 'where', 'why', 'which', 'while', 'from', 'by',
  'as', 'also', 'such', 'over', 'into', 'out', 'up', 'down', 'off', 'all',
  'any', 'each', 'few', 'more', 'most', 'other', 'some', 'only', 'own',
  'same', 'very', 'now', 'one', 'two', 'here', 'there',
]);

// Light stemmer — strips common suffixes. No dependency needed.
function stem(word) {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  // Order matters: longest suffixes first
  if (w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.endsWith('edly')) w = w.slice(0, -4);
  else if (w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.endsWith('ly')) w = w.slice(0, -2);
  else if (w.endsWith('es') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  // Double-letter cleanup from suffix removal (e.g. "running" → "runn" → "run")
  if (w.length > 3 && w[w.length - 1] === w[w.length - 2]) {
    const doubled = 'bdfgmnprt'; // common doubled consonants
    if (doubled.includes(w[w.length - 1])) w = w.slice(0, -1);
  }
  return w;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

class BM25Index {
  constructor(chunks, options = {}) {
    this.k1 = options.k1 || 1.2;
    this.b = options.b || 0.75;
    this.chunks = chunks || [];

    // Tokenize all documents
    this.docTokens = this.chunks.map(c => tokenize(c.text));
    this.docLengths = this.docTokens.map(tokens => tokens.length);
    this.avgdl = this.docLengths.length > 0
      ? this.docLengths.reduce((s, l) => s + l, 0) / this.docLengths.length
      : 0;

    // Build term frequency and document frequency
    this.tf = this.docTokens.map(tokens => {
      const freq = {};
      for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
      return freq;
    });

    // Document frequency per term
    this.df = {};
    for (const tokens of this.docTokens) {
      const seen = new Set(tokens);
      for (const t of seen) this.df[t] = (this.df[t] || 0) + 1;
    }

    this.N = this.chunks.length;
  }

  // IDF with smoothing: ln( (N - df + 0.5) / (df + 0.5) + 1 )
  idf(term) {
    const df = this.df[term] || 0;
    return Math.log((this.N - df + 0.5) / (df + 0.5) + 1);
  }

  // Score a single document for a query
  scoreDoc(docIdx, queryTerms) {
    const tf = this.tf[docIdx];
    if (!tf) return 0;
    const dl = this.docLengths[docIdx] || 0;
    const denom = this.k1 * (1 - this.b + this.b * (dl / (this.avgdl || 1)));

    let score = 0;
    for (const term of queryTerms) {
      const f = tf[term];
      if (!f) continue;
      const idf = this.idf(term);
      score += idf * (f * (this.k1 + 1)) / (f + denom);
    }
    return score;
  }

  // Search: return top-k chunks sorted by BM25 score
  search(question, k = 6) {
    const queryTerms = tokenize(question);
    if (queryTerms.length === 0) return [];

    const scored = this.chunks.map((c, i) => ({
      ...c,
      score: this.scoreDoc(i, queryTerms),
      idx: i,
    }));

    return scored
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

module.exports = { BM25Index, tokenize, stem, STOPWORDS };
