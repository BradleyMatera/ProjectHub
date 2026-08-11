'use strict';

// Offline retrieval evaluation. No network or model API is required.
const fs = require('fs');
const path = require('path');
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');
const { understandQuery } = require('../lib/query-understanding');

const KNOWLEDGE_PATH = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
const GOLDEN_PATH = path.join(__dirname, '..', 'data', 'eval-golden.json');
const K = 6;

function matches(result, expectedTags, expectedKeywords) {
  if (expectedTags.includes(result.tag)) return true;
  const text = String(result.text || '').toLowerCase();
  return expectedKeywords.some(keyword => text.includes(keyword.toLowerCase()));
}

function evaluate(index, chunks, golden) {
  let recalled = 0;
  let reciprocalRanks = 0;
  const misses = [];

  for (const item of golden) {
    const understood = understandQuery(item.query, [], chunks);
    const results = index.search(understood.rewritten, K);
    const rank = results.findIndex(result => matches(result, item.expectedTags, item.expectedKeywords));
    if (rank >= 0) {
      recalled++;
      reciprocalRanks += 1 / (rank + 1);
    } else {
      misses.push({ query: item.query, rewritten: understood.rewritten });
    }
  }

  return {
    recall: recalled / golden.length,
    mrr: reciprocalRanks / golden.length,
    recalled,
    total: golden.length,
    misses
  };
}

function main() {
  const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const chunks = buildRagChunks(knowledge);
  const result = evaluate(new BM25Index(chunks), chunks, golden);

  console.log(`BM25 chunks: ${chunks.length}`);
  console.log(`Recall@${K}: ${result.recall.toFixed(3)} (${result.recalled}/${result.total})`);
  console.log(`MRR@${K}: ${result.mrr.toFixed(3)}`);
  if (result.misses.length) console.log('Misses:', JSON.stringify(result.misses, null, 2));

  if (result.recall < 0.90) {
    console.error(`FAIL: Recall@${K} must be at least 0.90`);
    process.exit(1);
  }
  console.log('PASS: offline retrieval meets the acceptance threshold');
}

main();
