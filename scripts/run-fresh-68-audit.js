'use strict';

const fs = require('fs');
const path = require('path');
const { runLiteAgent } = require('../lib/lite-agent');
const { CONVERSATIONS, CONVERSATION_SETUPS } = require('../data/conversation-parity-suite');
const knowledge = require('../data/recruiter-knowledge.json');
const { BM25Index } = require('../lib/bm25');
const { buildRagChunks } = require('../lib/rag-chunks');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const sessionState = require('../lib/session-state');

const MODEL = process.env.OLLAMA_AGENT_MODEL || 'qwen2.5:1.5b';

async function runFresh68Audit() {
  console.log('=== Fresh 68-Question Evaluation Run for Manual Audit ===');
  console.log(`Model: ${MODEL}`);
  console.log(`Total Questions: ${CONVERSATIONS.length}`);

  const chunks = buildRagChunks(knowledge);
  const bm25Index = new BM25Index(chunks);
  const results = [];
  const convSessions = new Map();

  const timestamp = new Date().toISOString();

  for (let i = 0; i < CONVERSATIONS.length; i++) {
    const item = CONVERSATIONS[i];
    const convId = item.conv || 'default';
    if (!convSessions.has(convId)) {
      const newSessionId = `audit-68-${convId}-${Date.now()}`;
      convSessions.set(convId, newSessionId);
      for (const setup of CONVERSATION_SETUPS[convId] || []) {
        sessionState.updateState(newSessionId, setup.question, setup.response, knowledge);
      }
    }
    const sessionId = convSessions.get(convId);
    const state = sessionState.getState(sessionId);
    const history = state.recentTurns || state.history || [];

    const understood = understandQuery(item.question, history, chunks);
    const bm25Results = searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 5);
    const evidence = bm25Results.map(r => ({
      kind: r.tag, name: '', description: r.text, evidenceScore: r.rrfScore
    }));

    const result = await runLiteAgent({
      question: item.question,
      conversationState: state,
      evidence,
      knowledge,
      sessionId,
      model: MODEL
    });

    const visibleAnswer = result.reply || '';
    const isFallback = !!result.fallback;

    const historySnapshot = ((state.recentTurns || state.history) || []).flatMap(t => {
      if (t.role && t.text) return [{ role: t.role, text: t.text }];
      return [
        t.user ? { role: 'user', text: t.user } : null,
        t.assistant ? { role: 'assistant', text: t.assistant } : null
      ].filter(Boolean);
    });

    results.push({
      id: item.id || `q${i+1}`,
      cat: item.category || item.cat,
      conv: item.conv,
      question: item.question,
      history: historySnapshot,
      rewritten: understood.rewritten,
      visibleAnswer,
      fallback: isFallback,
      outcome: result.outcome || (isFallback ? 'fallback' : 'accepted'),
      latencyMs: result.latencyMs,
      contextTokens: result.contextTokens,
      validation: result.validation || null,
      events: result.events || []
    });

    sessionState.updateState(sessionId, item.question, visibleAnswer, knowledge);
    process.stdout.write('.');
  }
  console.log('\nRun complete!');

  const outputPayload = {
    timestamp,
    model: MODEL,
    total: results.length,
    results
  };

  const customOutFile = process.argv[2];
  const outPath = customOutFile ? path.resolve(customOutFile) : path.join(__dirname, '../data/parity-run-68-raw.json');
  fs.writeFileSync(outPath, JSON.stringify(outputPayload, null, 2));
  console.log(`Saved raw run results to ${outPath}`);
}

runFresh68Audit().catch(err => {
  console.error('Audit run error:', err);
  process.exit(1);
});
