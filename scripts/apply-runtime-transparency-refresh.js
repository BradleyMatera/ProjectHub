'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const SERVER = path.join(ROOT, 'server-gemini.js');

function replaceExact(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly 1 match, found ${count}`);
  }
  return text.replace(before, after);
}

function replaceSection(text, heading, replacement) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<section class="card-section">\\s*<h2>${escaped}<\\/h2>[\\s\\S]*?<\\/section>`);
  const matches = text.match(new RegExp(re.source, 'g')) || [];
  if (matches.length !== 1) {
    throw new Error(`${heading}: expected exactly 1 section, found ${matches.length}`);
  }
  return text.replace(re, replacement.trim());
}

function refreshServerTelemetry() {
  let text = fs.readFileSync(SERVER, 'utf8');
  text = replaceExact(
    text,
`    local: {
      only: true,
      generation: activeProvider,
      embeddings: 'hash-vector-local',
      persistence: true
    },`,
`    local: {
      only: activeProvider === 'ollama',
      generation: activeProvider,
      deterministicWork: ['session-context', 'bm25-rrf', 'evidence-selection', 'factual-validation'],
      embeddings: 'hash-vector-local',
      persistence: true
    },
    execution: {
      generationProvider: activeProvider,
      generationLocation: activeProvider === 'cloudflare' ? 'cloud' : (activeProvider === 'ollama' ? 'local' : 'external-or-none'),
      ragRetrieval: 'local',
      validation: 'local'
    },`,
    'server local/cloud execution telemetry'
  );
  fs.writeFileSync(SERVER, text, 'utf8');
}

function refreshIndexCopy() {
  let text = fs.readFileSync(INDEX, 'utf8');

  text = text.replace('100% free stack', 'free-tier constrained stack');
  text = text.replace(
    'Model: <code>@cf/meta/llama-3.2-3b-instruct</code> on Cloudflare free tier. Lite agent mode with up to 3 recovery attempts.',
    'Model: <code>@cf/meta/llama-3.2-3b-instruct</code>. RAG evidence is primary; one factual repair is allowed if the first generated answer fails validation.'
  );
  text = text.replace(
    'Every request has a hard 15,000 ms budget. If generation exceeds it, Scout falls back to a grounded constrained recovery.',
    'Every request has a hard 15,000 ms budget. A factually invalid answer gets at most one generative repair; if that still fails, Scout fails closed instead of returning known-invalid prose.'
  );
  text = text.replace(
    'Free-tier inference with <code>@cf/meta/llama-3.2-3b-instruct</code>. Neuron-based pricing with generous free allocation.',
    'Generative inference with <code>@cf/meta/llama-3.2-3b-instruct</code>. The included allocation is 10,000 neurons per day, resetting at 00:00 UTC; the page now exposes live estimated usage.'
  );

  text = replaceSection(text, 'Scout pipeline', `
      <section class="card-section">
        <h2>Scout pipeline</h2>
        <div class="flow-box">
          <div class="flow-step">Visitor message</div><div class="flow-arrow">→</div>
          <div class="flow-step">Conversation-aware query</div><div class="flow-arrow">→</div>
          <div class="flow-step">BM25 + RRF top candidates</div><div class="flow-arrow">→</div>
          <div class="flow-step">Ranked evidence packet</div><div class="flow-arrow">→</div>
          <div class="flow-step">Cloudflare generation</div><div class="flow-arrow">→</div>
          <div class="flow-step">Factual validation</div><div class="flow-arrow">→</div>
          <div class="flow-step">Scout reply</div>
        </div>
        <h3>How it works now</h3>
        <p>
          ProjectHub first resolves the current conversation into a retrieval query and always runs local BM25/RRF search.
          The highest-value evidence blocks become the model's primary context; structured tools may add evidence but do not replace RAG.
          Cloudflare Workers AI generates the conversational answer from that scoped packet. Factual validation then checks unsupported
          entities, relationships, project-to-technology attribution, employment, certifications, temporal claims, and overclaiming.
          If the first generation is factually invalid, Scout gets one evidence-guided generative repair. If the repair is still invalid,
          the request fails closed with a technical error instead of exposing known-invalid prose.
        </p>
      </section>`);

  text = replaceSection(text, 'Inference efficiency', `
      <section class="card-section">
        <h2>Inference efficiency</h2>
        <p>
          Scout saves hosted-model work by shrinking the context before generation rather than trying to replace the model with hard-coded answers.
        </p>
        <ul class="feature-list">
          <li><strong>Local retrieval first:</strong> BM25/RRF searches the verified knowledge without a model call.</li>
          <li><strong>Small evidence packet:</strong> only the highest-value evidence blocks are sent to Cloudflare instead of the entire knowledge base.</li>
          <li><strong>One normal generation:</strong> most successful requests use one provider call; a second call is reserved for factual repair.</li>
          <li><strong>Visible accounting:</strong> each reply exposes provider calls, input/output tokens, neurons, model latency, RAG selection, and repairs.</li>
          <li><strong>Fail closed:</strong> validation cannot silently return a known-invalid answer just to save a provider call.</li>
        </ul>
      </section>`);

  text = text.replace(
    /Active development on feat\/architecture-refactor\.[\s\S]*?all validated, all grounded\./,
    'Active development on the RAG-first restoration line. Cloudflare Workers AI is the current generative provider; local ProjectHub code owns conversation context, BM25/RRF retrieval, evidence selection, validation, telemetry, and persistence. RAG evidence is primary, and Ollama is only an optional fallback when explicitly configured.'
  );

  text = text.replace(
    /Active branch: <code>feat\/agent-systems-network<\/code>\.[\s\S]*?the dev backend\./,
    'Active branch: <code>feat/rag-primary-restoration</code>. The dev surface is validating the RAG-first pipeline, factual validator restoration, privacy controls, and live token/neuron/cost telemetry against the separate dev backend.'
  );

  fs.writeFileSync(INDEX, text, 'utf8');
}

function main() {
  refreshServerTelemetry();
  refreshIndexCopy();
  console.log('runtime transparency refresh: PASS');
}

if (require.main === module) main();

module.exports = { replaceExact, replaceSection, refreshServerTelemetry, refreshIndexCopy };
