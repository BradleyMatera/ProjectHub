#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'recruiter-knowledge.json'), 'utf8'));
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const { classifyResponsePolicy } = require('../lib/response-policy');
const { runRagPrimaryAgent } = require('../lib/rag-agent');

const chunks = buildRagChunks(knowledge);
const bm25Index = new BM25Index(chunks);

require('../lib/local-model-router').generate = async function(model, messages, options) {
  console.log('======== SYSTEM PROMPT ========');
  console.log(messages.find(m => m.role === 'system').content);
  console.log('======== USER PROMPT ========');
  console.log(messages.find(m => m.role === 'user').content);
  return { ok: true, text: JSON.stringify({ answer: '[STUB]' }), usage: { provider: 'stub' }, latencyMs: 0, startedAt: Date.now(), endedAt: Date.now() };
};

const question = process.argv[2] || 'Tell me about Bradley.';
const understood = understandQuery(question, [], chunks);
const evidence = searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 8).map(r => ({
  kind: r.tag, name: r.title || r.name || '', description: r.text, evidenceScore: r.rrfScore
}));
const policy = classifyResponsePolicy(question, [], knowledge);

runRagPrimaryAgent({
  question,
  conversationState: { recentTurns: [] },
  evidence,
  knowledge,
  sessionId: 'inspect',
  policyContract: { mode: policy.mode, ...policy }
}).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
