'use strict';

// Hybrid retrieval: fuses BM25 and dense vector results using Reciprocal Rank
// Fusion (RRF), then applies Maximal Marginal Relevance (MMR) for diversity.
//
// RRF: score(d) = Σ 1/(k + rank_i(d))  — rank-based, no score calibration needed
// MMR: selects chunks that are both relevant and diverse (λ controls balance)

// RRF fusion constant — standard value from the original paper
const RRF_K = 60;

// MMR lambda — 1.0 = pure relevance, 0.0 = pure diversity
const MMR_LAMBDA = 0.7;

function reciprocalRankFusion(rankings, k = RRF_K) {
  const scores = new Map();

  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank++) {
      const chunk = ranking[rank];
      const key = chunk.idx !== undefined ? chunk.idx : chunk.text;
      const current = scores.get(key) || { ...chunk, score: 0 };
      current.score += 1 / (k + rank + 1);
      scores.set(key, current);
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score);
}

// Simple text similarity for MMR — word overlap ratio
function textSimilarity(a, b) {
  const wordsA = new Set(String(a || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(String(b || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  return intersection / Math.min(wordsA.size, wordsB.size);
}

function maximalMarginalRelevance(candidates, k, lambda = MMR_LAMBDA) {
  if (candidates.length <= k) return candidates;

  const selected = [];
  const remaining = [...candidates];

  // Always pick the top-ranked first
  selected.push(remaining.shift());

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      let maxSim = 0;
      for (const sel of selected) {
        const sim = textSimilarity(remaining[i].text, sel.text);
        if (sim > maxSim) maxSim = sim;
      }
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

// Tag-aware boosting — certain intents should boost certain chunk tags
const TAG_BOOSTS = {
  'role-fit': { faq: 1.15, experience: 1.15, story: 1.10 },
  'contact': { identity: 1.20 },
  'experience-detail': { experience: 1.15, story: 1.10 },
  'factual-lookup': { skills: 1.05, certification: 1.05 },
};

function applyTagBoosts(chunks, intent) {
  const boosts = TAG_BOOSTS[intent];
  if (!boosts) return chunks;
  return chunks.map(c => ({
    ...c,
    score: c.score * (boosts[c.tag] || 1),
  }));
}

// Main hybrid retrieval function
function hybridRetrieve(params) {
  const { bm25Results, denseResults, intent, k = 6 } = params;

  // Collect rankings for RRF
  const rankings = [];
  if (bm25Results && bm25Results.length > 0) rankings.push(bm25Results);
  if (denseResults && denseResults.length > 0) rankings.push(denseResults);

  if (rankings.length === 0) return [];

  // RRF fusion
  let fused = reciprocalRankFusion(rankings);

  // Tag-aware boosting
  fused = applyTagBoosts(fused, intent);

  // Re-sort after boosting
  fused.sort((a, b) => b.score - a.score);

  // MMR for diversity — take top 2k then select k
  const mmrPool = fused.slice(0, k * 2);
  const selected = maximalMarginalRelevance(mmrPool, k);

  return selected;
}

module.exports = {
  reciprocalRankFusion,
  maximalMarginalRelevance,
  hybridRetrieve,
  textSimilarity,
  applyTagBoosts,
  RRF_K,
  MMR_LAMBDA,
};
