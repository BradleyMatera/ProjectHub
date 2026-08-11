'use strict';

// Live integration test: run the Scout agent engine against the local Ollama
// model. This proves the real agent loop works end-to-end.
//
// Usage: node scripts/test-agent-live.js
// Requires Ollama running at OLLAMA_URL (default localhost:11434)

const fs = require('fs');
const path = require('path');
const { runAgentLoop, probeAgent } = require('../lib/agent-engine');
const router = require('../lib/local-model-router');
const { buildRawPacket } = require('../lib/context-packet');
const { getState, updateState, clearState } = require('../lib/session-state');

const KNOWLEDGE_PATH = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));

async function rawModelAnswer(question, model) {
  const packet = buildRawPacket({ question, agentName: 'Scout' });
  const result = await router.generate(model, [
    { role: 'system', content: packet.systemPrompt },
    { role: 'user', content: packet.userPrompt }
  ], { timeoutMs: 8000, numPredict: 80, temperature: 0.3 });
  return { ok: result.ok, text: result.text, latencyMs: result.latencyMs, error: result.error };
}

async function main() {
  const model = router.agentModel();
  console.log(`\n=== Scout Agent Live Test ===`);
  console.log(`Model: ${model}`);
  console.log(`Ollama URL: ${router.configuredOllamaUrl()}\n`);

  // 1. Probe
  console.log('--- Probe ---');
  const probe = await probeAgent(model);
  console.log(`Reachable: ${probe.reachable} | Structured JSON: ${probe.structuredOk} | Latency: ${probe.latencyMs}ms`);
  if (!probe.reachable) {
    console.log(`Ollama not reachable: ${probe.error}`);
    console.log('Run: ollama pull qwen2.5:0.5b');
    process.exit(1);
  }

  const questions = [
    'What did Bradley do with AWS?',
    'Does Bradley actually know DynamoDB?',
    'Compare ProjectHub and Voice Ops Platform.',
    'What is his strongest AWS project?',
    'Has Bradley used React?'
  ];

  console.log('\n--- Raw vs Scout-Assisted Comparison ---\n');
  const sessionId = 'live-test-' + Date.now();

  for (const question of questions) {
    console.log(`\nQ: ${question}`);

    // Raw model (no harness assistance)
    const raw = await rawModelAnswer(question, model);
    console.log(`  RAW [${raw.latencyMs}ms]: ${String(raw.text || raw.error).slice(0, 200)}`);

    // Scout-assisted
    clearState(sessionId);
    const state = getState(sessionId);
    // Use BM25 retrieval to get evidence (simplified: use agent-tools search)
    const { executeAgentTool } = require('../lib/agent-tools');
    const search = executeAgentTool('search_portfolio', { query: question, limit: 5 }, knowledge);
    const evidence = search.results;

    const agentResult = await runAgentLoop({
      question,
      conversationState: state,
      evidence,
      knowledge,
      sessionId,
      model
    });

    console.log(`  SCOUT [${agentResult.latencyMs}ms | ctx:${agentResult.contextTokens}tok | steps:${agentResult.steps.length} | fallback:${agentResult.fallback}]`);
    console.log(`  REPLY: ${String(agentResult.reply || '(fallback to grounded)').slice(0, 200)}`);
    console.log(`  EVENTS: ${agentResult.events.map(e => `${e.type}${e.tool ? ':' + e.tool : ''}`).join(' → ')}`);

    updateState(sessionId, question, agentResult.reply || '', knowledge, null);
  }

  console.log('\n=== Done ===\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
