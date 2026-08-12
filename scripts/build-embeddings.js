'use strict';

// Build-time embedding generation for the knowledge base.
// Uses Cloudflare Workers AI (@cf/baai/bge-small-en-v1.5, 384-d, free tier)
// to embed all RAG chunks and intent centroids.
//
// Output:
//   data/knowledge-vectors.json  — { knowledgeHash, model, vectors: [{idx, tag, text, embedding}] }
//   data/intent-centroids.json   — { model, centroids: { intent: { embedding, examples } } }
//
// Usage: node scripts/build-embeddings.js
// Requires: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in env.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildRagChunks } = require('../lib/rag-chunks');

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || '@cf/baai/bge-small-en-v1.5';
const KNOWLEDGE_PATH = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
const VECTORS_PATH = path.join(__dirname, '..', 'data', 'knowledge-vectors.json');
const CENTROIDS_PATH = path.join(__dirname, '..', 'data', 'intent-centroids.json');

// Intent examples for centroid computation
const INTENT_EXAMPLES = {
  'role-fit': [
    'Is he a fit for a junior frontend role?',
    'Would you hire him for a cloud support position?',
    'Is he suitable for a DevOps role?',
    'What roles is he targeting?',
    'Is he qualified for a junior web developer position?',
  ],
  'factual-lookup': [
    'What is his tech stack?',
    'What programming languages does he know?',
    'Where is he based?',
    'What certifications does he have?',
    'What is his education background?',
  ],
  'experience-detail': [
    'Tell me about his AWS experience',
    'What did he do at CIRIS?',
    'Tell me about his military background',
    'What was his role in the Army?',
    'Describe his internship work',
  ],
  'contact': [
    'How do I contact him?',
    'What is his email?',
    'Does he have a LinkedIn?',
    'What is his GitHub profile?',
    'How can I reach him?',
  ],
  'smalltalk': [
    'Hi there',
    'Hello',
    'Hey, thanks for the info',
    'Goodbye',
    'Thanks',
  ],
  'meta': [
    'What can you do?',
    'How do you work?',
    'Are you a chatbot?',
    'What are you?',
    'Who is Scout?',
  ],
};

async function embedBatch(texts) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required');
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`;
  const allEmbeddings = [];

  // Batch in groups of 50 to stay within CF limits
  const BATCH_SIZE = 50;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    console.log(`  Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)} (${batch.length} texts)`);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: batch }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Cloudflare embedding API failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!data.result || !Array.isArray(data.result.data)) {
      throw new Error('Unexpected Cloudflare API response shape');
    }

    for (const item of data.result.data) {
      allEmbeddings.push(Float32Array.from(item));
    }
  }

  return allEmbeddings;
}

function computeCentroid(embeddings) {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const centroid = new Float32Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) centroid[i] += emb[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= embeddings.length;
  return Array.from(centroid);
}

async function main() {
  console.log('=== Build Embeddings ===');
  console.log(`Model: ${EMBEDDING_MODEL}`);
  console.log(`Knowledge: ${KNOWLEDGE_PATH}`);

  // Load knowledge
  const knowledgeRaw = fs.readFileSync(KNOWLEDGE_PATH, 'utf8');
  const knowledge = JSON.parse(knowledgeRaw);
  const knowledgeHash = crypto.createHash('sha256').update(knowledgeRaw).digest('hex').slice(0, 16);
  console.log(`Knowledge hash: ${knowledgeHash}`);

  // Build chunks
  const chunks = buildRagChunks(knowledge);
  console.log(`Chunks: ${chunks.length}`);

  // Embed all chunks
  console.log('\nEmbedding chunks...');
  const chunkTexts = chunks.map(c => c.text);
  const chunkEmbeddings = await embedBatch(chunkTexts);

  // Write vectors
  const vectors = {
    knowledgeHash,
    model: EMBEDDING_MODEL,
    dim: chunkEmbeddings[0]?.length || 384,
    vectors: chunks.map((c, i) => ({
      idx: i,
      tag: c.tag,
      text: c.text,
      embedding: Array.from(chunkEmbeddings[i]),
    })),
  };
  fs.writeFileSync(VECTORS_PATH, JSON.stringify(vectors, null, 2));
  console.log(`\nWrote ${vectors.vectors.length} vectors to ${VECTORS_PATH}`);

  // Embed intent examples and compute centroids
  console.log('\nEmbedding intent centroids...');
  const centroids = { model: EMBEDDING_MODEL, centroids: {} };
  for (const [intent, examples] of Object.entries(INTENT_EXAMPLES)) {
    console.log(`  Intent: ${intent} (${examples.length} examples)`);
    const emb = await embedBatch(examples);
    centroids.centroids[intent] = {
      embedding: computeCentroid(emb),
      examples,
    };
  }
  fs.writeFileSync(CENTROIDS_PATH, JSON.stringify(centroids, null, 2));
  console.log(`\nWrote intent centroids to ${CENTROIDS_PATH}`);

  console.log('\n=== Done ===');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
