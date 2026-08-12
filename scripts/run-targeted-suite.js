'use strict';

const fs = require('fs');
const path = require('path');
const { runLiteAgent } = require('../lib/lite-agent');
const { CONVERSATIONS } = require('../data/conversation-parity-suite');
const knowledge = require('../data/recruiter-knowledge.json');
const { BM25Index } = require('../lib/bm25');
const { buildRagChunks } = require('../lib/rag-chunks');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const sessionState = require('../lib/session-state');

const MODEL = process.env.OLLAMA_AGENT_MODEL || 'qwen2.5:1.5b';

// Targeted question indices (0-based) — the ones that were weak in Stability Y
// Focus on non-fallback weak answers that need to become GOOD
const TARGET_INDICES = [
  1,   // q2 — generic — "what's actually interesting about it?"
  2,   // q3 — generic — "What did Bradley personally build?"
  8,   // q9 — generic after repair — "what did he learn there?"
  11,  // q12 — terse — "Give me the quick version"
  12,  // q13 — generic after repair — "Why would I interview him?"
  16,  // q17 — generic — "strongest evidence he can build software"
  19,  // q20 — generic — "What about Node.js?"
  20,  // q21 — generic — "What's he best at?"
  21,  // q22 — fact wrong — "What does he still need to learn?"
  23,  // q24 — generic — "explain it technically"
  26,  // q27 — terse after repair — "What does he actually do?"
  30,  // q31 — broken — "What did he use there?"
  32,  // q33 — terse — "What about the other project?"
  33,  // q34 — generic after repair — "Did he do that professionally?"
  34,  // q35 — generic — "So what is this thing?"
  36,  // q37 — generic — "What's the cool part?"
  39,  // q40 — generic — "What's he best at?"
  49,  // q50 — generic after repair — "gaps in his background"
  54,  // q55 — terse after repair — "MIT degree"
  59,  // q60 — fact wrong — "production incidents"
  64,  // q65 — terse after repair — "most interesting project"
  67,  // q68 — generic — "worth interviewing?"
];

async function runTargetedSuite(runLabel) {
  const chunks = buildRagChunks(knowledge);
  const bm25Index = new BM25Index(chunks);
  const results = [];
  const convSessions = new Map();

  const targeted = TARGET_INDICES.map(i => ({ ...CONVERSATIONS[i], id: `q${i+1}`, idx: i }));

  for (const item of targeted) {
    const convId = item.conv || 'default';
    if (!convSessions.has(convId)) {
      convSessions.set(convId, `targeted-${convId}-${Date.now()}`);
    }
    const sessionId = convSessions.get(convId);
    const state = sessionState.getState(sessionId);

    const understood = understandQuery(item.question, [], chunks);
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
    const valEvent = (result.events || []).find(e => e.type === 'lite_validation');
    const reasons = valEvent?.reasons || [];

    results.push({
      id: item.id,
      cat: item.category || item.cat,
      question: item.question,
      visibleAnswer,
      fallback: isFallback,
      outcome: result.outcome || (isFallback ? 'fallback' : 'accepted'),
      reasons: reasons.slice(0, 3),
      latencyMs: result.latencyMs
    });

    sessionState.updateState(sessionId, item.question, visibleAnswer, knowledge);
    process.stdout.write('.');
  }

  return results;
}

async function main() {
  const RUNS = parseInt(process.env.TARGETED_RUNS || '3', 10);
  console.log(`=== Targeted Suite (${TARGET_INDICES.length} questions × ${RUNS} runs) ===`);
  console.log(`Model: ${MODEL}`);

  const allRuns = [];

  for (let run = 0; run < RUNS; run++) {
    console.log(`\n--- Run ${run + 1}/${RUNS} ---`);
    const results = await runTargetedSuite(run);
    allRuns.push(results);

    const fb = results.filter(r => r.fallback).length;
    const accepted = results.filter(r => r.outcome === 'accepted').length;
    const repaired = results.filter(r => r.outcome === 'repaired' || r.outcome === 'completeness_repaired').length;
    console.log(`\nFallbacks: ${fb} | Accepted: ${accepted} | Repaired: ${repaired}`);

    // Show details
    results.forEach(r => {
      const status = r.fallback ? 'FB' : r.outcome === 'repaired' || r.outcome === 'completeness_repaired' ? 'RP' : 'OK';
      console.log(`  ${r.id} [${status}] ${r.question.substring(0, 50)}`);
      console.log(`    A: ${r.visibleAnswer.substring(0, 100).replace(/\n/g, ' ')}`);
      if (r.reasons.length > 0) console.log(`    R: ${r.reasons.join(', ')}`);
    });
  }

  // Summary across runs
  console.log('\n=== Cross-Run Summary ===');
  TARGET_INDICES.forEach((idx, i) => {
    const id = `q${idx+1}`;
    const outcomes = allRuns.map(run => {
      const r = run.find(x => x.id === id);
      return r ? (r.fallback ? 'FB' : r.outcome === 'repaired' || r.outcome === 'completeness_repaired' ? 'RP' : 'OK') : '?';
    });
    const fbCount = outcomes.filter(o => o === 'FB').length;
    const okCount = outcomes.filter(o => o === 'OK').length;
    const rpCount = outcomes.filter(o => o === 'RP').length;
    console.log(`  ${id}: ${outcomes.join('/')} (OK:${okCount} RP:${rpCount} FB:${fbCount})`);
  });

  const totalFb = allRuns.map(run => run.filter(r => r.fallback).length);
  console.log(`\nFallbacks per run: ${totalFb.join(', ')}`);
  console.log(`Average fallbacks: ${(totalFb.reduce((a, b) => a + b, 0) / totalFb.length).toFixed(1)}`);
}

main().catch(err => {
  console.error('Targeted suite error:', err);
  process.exit(1);
});
