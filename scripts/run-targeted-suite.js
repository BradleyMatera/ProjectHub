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

// Targeted question indices (0-based) — the ones that were problematic in postfix22
const TARGET_INDICES = [
  0,   // q1 — fabricated ProjectHub description
  2,   // q3 — fallback — "What did Bradley personally build?"
  3,   // q4 — fallback — context drift
  7,   // q8 — fallback — "Was that real production work?"
  10,  // q11 — terse — only 1 of 2 certs
  13,  // q14 — fallback — recruiter concerns
  16,  // q17 — MongoDB fabrication
  26,  // q27 — MongoDB + fabricated "token system for 364 Applications"
  29,  // q30 — fallback — persona confusion
  34,  // q35 — generic — "So what is this thing?"
  42,  // q43 — fallback — "proficiency in" overclaim
  43,  // q44 — fallback — "unknown" skill
  44,  // q45 — generic — comparison only mentions one entity
  48,  // q49 — fallback — Udemy/DSA
  52,  // q53 — fallback — adversarial Yes
  62,  // q63 — fallback — Netflix
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
