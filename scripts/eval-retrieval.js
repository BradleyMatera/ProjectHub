'use strict';

// Retrieval evaluation harness — measures Recall@k and MRR@k for
// BM25-only, dense-only, and hybrid retrieval against a golden set.
//
// Usage: node scripts/eval-retrieval.js
// Acceptance criteria: hybrid ≥ both baselines, Recall@6 ≥ 0.85

const fs = require('fs');
const path = require('path');
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');
const { understandQuery } = require('../lib/query-understanding');
const { VectorIndex, embedQuery } = require('../lib/vector-index');
const { hybridRetrieve } = require('../lib/hybrid-retrieve');

const KNOWLEDGE_PATH = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
const GOLDEN_PATH = path.join(__dirname, '..', 'data', 'eval-golden.json');
const K = 6;

function recallAtK(retrieved, expectedTags, expectedKeywords, k) {
  const topK = retrieved.slice(0, k);
  // Recall: did we retrieve at least one chunk with an expected tag or keyword?
  const hasExpectedTag = topK.some(r => expectedTags.includes(r.tag));
  const hasExpectedKeyword = topK.some(r => {
    const text = String(r.text || '').toLowerCase();
    return expectedKeywords.some(kw => text.includes(kw.toLowerCase()));
  });
  return (hasExpectedTag || hasExpectedKeyword) ? 1 : 0;
}

function mrrAtK(retrieved, expectedTags, expectedKeywords, k) {
  const topK = retrieved.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    const r = topK[i];
    if (expectedTags.includes(r.tag)) return 1 / (i + 1);
    const text = String(r.text || '').toLowerCase();
    if (expectedKeywords.some(kw => text.includes(kw.toLowerCase()))) return 1 / (i + 1);
  }
  return 0;
}

async function evaluateRetrieval(name, retrieveFn, golden, k) {
  let totalRecall = 0;
  let totalMrr = 0;
  let passed = 0;

  for (const item of golden) {
    const results = await retrieveFn(item.query, k);
    const recall = recallAtK(results, item.expectedTags, item.expectedKeywords, k);
    const mrr = mrrAtK(results, item.expectedTags, item.expectedKeywords, k);
    totalRecall += recall;
    totalMrr += mrr;
    if (recall === 1) passed++;
  }

  const n = golden.length;
  return {
    name,
    recallAtK: totalRecall / n,
    mrrAtK: totalMrr / n,
    passed,
    total: n,
  };
}

async function main() {
  console.log('=== Retrieval Evaluation ===\n');

  // Load knowledge and build chunks
  const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
  const chunks = buildRagChunks(knowledge);
  console.log(`Chunks: ${chunks.length}`);

  // Load golden set
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  console.log(`Golden queries: ${golden.length}\n`);

  // Build BM25 index
  const bm25Index = new BM25Index(chunks);

  // Evaluate BM25-only
  const bm25Results = await evaluateRetrieval('BM25-only', async (q, k) => {
    const understood = understandQuery(q, [], chunks);
    return bm25Index.search(understood.rewritten, k);
  }, golden, K);

  console.log(`BM25-only:     Recall@${K}=${bm25Results.recallAtK.toFixed(3)}  MRR@${K}=${bm25Results.mrrAtK.toFixed(3)}  (${bm25Results.passed}/${bm25Results.total})`);

  // Evaluate dense-only (if vectors available)
  const vectorIndex = VectorIndex.load();
  if (vectorIndex && vectorIndex.size > 0) {
    const denseResults = await evaluateRetrieval('Dense-only', async (q, k) => {
      const understood = understandQuery(q, [], chunks);
      const emb = await embedQuery(understood.rewritten);
      if (!emb) return [];
      return vectorIndex.search(emb, k);
    }, golden, K);
    console.log(`Dense-only:    Recall@${K}=${denseResults.recallAtK.toFixed(3)}  MRR@${K}=${denseResults.mrrAtK.toFixed(3)}  (${denseResults.passed}/${denseResults.total})`);

    // Evaluate hybrid
    const hybridResults = await evaluateRetrieval('Hybrid (RRF+MMR)', async (q, k) => {
      const understood = understandQuery(q, [], chunks);
      const bm25 = bm25Index.search(understood.rewritten, k);
      const emb = await embedQuery(understood.rewritten);
      if (!emb) return bm25;
      const dense = vectorIndex.search(emb, k);
      return hybridRetrieve({ bm25Results: bm25, denseResults: dense, intent: understood.intent, k });
    }, golden, K);
    console.log(`Hybrid:        Recall@${K}=${hybridResults.recallAtK.toFixed(3)}  MRR@${K}=${hybridResults.mrrAtK.toFixed(3)}  (${hybridResults.passed}/${hybridResults.total})`);

    // Acceptance check
    console.log('');
    if (hybridResults.recallAtK >= 0.85) {
      console.log(`PASS: Hybrid Recall@${K} ≥ 0.85`);
    } else {
      console.log(`FAIL: Hybrid Recall@${K} < 0.85 (${hybridResults.recallAtK.toFixed(3)})`);
    }
    if (hybridResults.recallAtK >= bm25Results.recallAtK && hybridResults.recallAtK >= denseResults.recallAtK) {
      console.log(`PASS: Hybrid ≥ both baselines on Recall@${K}`);
    } else {
      console.log(`FAIL: Hybrid does not dominate baselines`);
    }
  } else {
    console.log('\n(Vector index not available — skipping dense and hybrid evaluation)');
    console.log(`\nBM25-only acceptance: Recall@${K}=${bm25Results.recallAtK.toFixed(3)} (${bm25Results.passed}/${bm25Results.total})`);
    if (bm25Results.recallAtK >= 0.85) {
      console.log(`PASS: BM25 Recall@${K} ≥ 0.85`);
    } else {
      console.log(`FAIL: BM25 Recall@${K} < 0.85`);
    }
  }

  console.log('\n=== Done ===');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
