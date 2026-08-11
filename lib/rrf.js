'use strict';

// Reciprocal Rank Fusion combines independent ranked views without requiring
// their raw scores to share a scale. ProjectHub uses it entirely locally to
// fuse BM25 results for the visitor's literal wording, alias-expanded wording,
// and conversation-aware rewrite.

function resultKey(item) {
  if (Number.isInteger(item?.idx)) return `idx:${item.idx}`;
  return `${item?.tag || ''}\u0000${item?.text || ''}`;
}

function reciprocalRankFuse(rankedLists, options = {}) {
  const smoothing = Number.isFinite(options.smoothing) ? options.smoothing : 60;
  const limit = Number.isFinite(options.limit) ? options.limit : 6;
  const fused = new Map();

  for (const list of rankedLists || []) {
    if (!Array.isArray(list)) continue;
    list.forEach((item, index) => {
      if (!item) return;
      const key = resultKey(item);
      const current = fused.get(key) || {
        item,
        rrfScore: 0,
        ranks: [],
      };
      const rank = index + 1;
      current.rrfScore += 1 / (smoothing + rank);
      current.ranks.push(rank);
      fused.set(key, current);
    });
  }

  return [...fused.values()]
    .sort((left, right) => right.rrfScore - left.rrfScore
      || Math.min(...left.ranks) - Math.min(...right.ranks))
    .slice(0, Math.max(0, limit))
    .map(entry => ({
      ...entry.item,
      score: entry.rrfScore,
      rrfScore: entry.rrfScore,
      rrfRanks: entry.ranks,
    }));
}

function searchBm25WithRrf(index, queries, limit = 6, options = {}) {
  if (!index || typeof index.search !== 'function') return [];
  const uniqueQueries = [...new Set((queries || [])
    .map(query => String(query || '').trim())
    .filter(Boolean))];
  if (uniqueQueries.length === 0) return [];

  const candidateDepth = Number.isFinite(options.candidateDepth)
    ? options.candidateDepth
    : Math.max(limit * 3, 12);
  const rankedLists = uniqueQueries.map(query => index.search(query, candidateDepth));
  return reciprocalRankFuse(rankedLists, {
    smoothing: options.smoothing,
    limit,
  });
}

module.exports = { reciprocalRankFuse, searchBm25WithRrf, resultKey };
