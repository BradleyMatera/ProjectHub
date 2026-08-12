'use strict';

// Vector index for dense retrieval — loads pre-built embeddings from
// data/knowledge-vectors.json into a contiguous Float32Array for fast
// brute-force cosine similarity search.
//
// Query embedding is done at runtime via Cloudflare Workers AI.
// If the embedding API is unavailable, falls back to BM25-only mode.

const fs = require('fs');
const path = require('path');

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || '@cf/baai/bge-small-en-v1.5';
const VECTORS_PATH = path.join(__dirname, '..', 'data', 'knowledge-vectors.json');

class VectorIndex {
  constructor(vectorsData) {
    this.model = vectorsData.model;
    this.knowledgeHash = vectorsData.knowledgeHash;
    this.dim = vectorsData.dim || 384;
    this.chunks = [];
    this.vectors = null; // Float32Array, contiguous

    if (vectorsData.vectors && vectorsData.vectors.length > 0) {
      this.chunks = vectorsData.vectors.map(v => ({ tag: v.tag, text: v.text, idx: v.idx }));
      const total = vectorsData.vectors.length * this.dim;
      this.vectors = new Float32Array(total);
      for (let i = 0; i < vectorsData.vectors.length; i++) {
        const emb = vectorsData.vectors[i].embedding;
        const offset = i * this.dim;
        for (let j = 0; j < this.dim && j < emb.length; j++) {
          this.vectors[offset + j] = emb[j];
        }
      }
    }
  }

  static load(filePath) {
    const fp = filePath || VECTORS_PATH;
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      return new VectorIndex(JSON.parse(raw));
    } catch (e) {
      console.error('[vector-index] Failed to load vectors:', e.message);
      return null;
    }
  }

  get size() { return this.chunks.length; }

  // Cosine similarity between query vector and a chunk vector at index i
  cosineSim(queryVec, chunkIdx) {
    const offset = chunkIdx * this.dim;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < this.dim; i++) {
      const a = queryVec[i];
      const b = this.vectors[offset + i];
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Search for top-k chunks by cosine similarity
  search(queryEmbedding, k = 6) {
    if (!this.vectors || this.chunks.length === 0) return [];
    const queryVec = Float32Array.from(queryEmbedding);
    const scored = this.chunks.map((c, i) => ({
      ...c,
      score: this.cosineSim(queryVec, i),
    }));
    return scored
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  // Check if the loaded vectors match the current knowledge hash
  isStale(currentHash) {
    return this.knowledgeHash !== currentHash;
  }
}

// Runtime query embedding via Cloudflare Workers AI
async function embedQuery(text) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) return null;

  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: [text] }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json();
    if (!data.result || !Array.isArray(data.result.data) || data.result.data.length === 0) return null;
    return data.result.data[0];
  } catch (e) {
    console.error('[vector-index] embedQuery failed:', e.message);
    return null;
  }
}

module.exports = { VectorIndex, embedQuery };
