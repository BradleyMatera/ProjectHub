#!/usr/bin/env node
'use strict';

/**
 * Detailed Fallback Audit for Parity Suite
 *
 * Re-runs the 68-question parity suite and captures raw model output,
 * validation reasons, and repair attempts for every fallback.
 * Classifies each fallback by root cause.
 */

const { runLiteAgent } = require('../lib/lite-agent');
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const sessionState = require('../lib/session-state');
const { CONVERSATIONS } = require('../data/conversation-parity-suite');
const fs = require('fs');
const path = require('path');

const MODEL = process.env.OLLAMA_AGENT_MODEL || 'qwen2.5:1.5b';

function classifyFallback(events, fallback) {
  const genOk = events.find(e => e.type === 'lite_generate_ok');
  const valEvt = events.find(e => e.type === 'lite_validation');
  const repairEvt = events.find(e => e.type === 'lite_repair_result');
  const advEvt = events.find(e => e.type === 'lite_adversarial_confirmed');
  const raw = genOk?.rawAnswer || genOk?.rawGenText || '';

  if (advEvt) return 'MODEL_ADVERSARIAL_CONFIRMATION';
  if (!raw || raw.length < 5) return 'MODEL_EMPTY_OUTPUT';

  const reasons = valEvt?.reasons || [];

  // Check for hallucinated entity
  if (reasons.some(r => r.startsWith('fabricated_entity:') || r.startsWith('entity_not_grounded:'))) {
    return 'MODEL_HALLUCINATED_ENTITY';
  }
  // Overclaim
  if (reasons.some(r => r.startsWith('expanded_overclaim:') || r.startsWith('relationship_overclaim:') || r === 'overclaim_language')) {
    return 'MODEL_OVERCLAIM';
  }
  // Wrong relationship
  if (reasons.some(r => r.startsWith('unsupported_relationship:'))) {
    // Check if it's a wrong relationship or just a terse answer that got extracted weirdly
    if (raw.length < 50) return 'MODEL_TOO_SHORT';
    return 'MODEL_WRONG_RELATIONSHIP';
  }
  // Persona
  if (reasons.some(r => r.includes('persona') || r.includes('first_person'))) {
    return 'PERSONA_ERROR';
  }
  // Too short
  if (reasons.includes('too_short') || raw.trim().length < 15) {
    return 'MODEL_TOO_SHORT';
  }
  // Insufficient content overlap
  if (reasons.includes('insufficient_content_overlap')) {
    if (raw.length < 50) return 'MODEL_TOO_SHORT';
    return 'MODEL_INCOMPLETE';
  }
  // Repair failed
  if (repairEvt && repairEvt.verdict !== 'supported') {
    if (raw.length < 50) return 'MODEL_TOO_SHORT';
    if (reasons.length === 0) return 'REPAIR_FAILED';
    return 'REPAIR_FAILED';
  }
  // Generic
  if (/based on the (?:information|data)/i.test(raw) || /would you like/i.test(raw)) {
    return 'MODEL_GENERIC';
  }
  if (reasons.length === 0) return 'OTHER';
  return 'OTHER';
}

async function main() {
  const knowledgePath = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
  const knowledge = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'));
  const chunks = buildRagChunks(knowledge);
  const bm25Index = new BM25Index(chunks);

  console.log(`=== Parity Fallback Audit (LITE, ${MODEL}) ===`);
  console.log(`Questions: ${CONVERSATIONS.length}`);
  console.log('');

  const results = [];
  const convSessions = new Map();
  const fallbackDetails = [];

  for (const q of CONVERSATIONS) {
    const convId = q.conv || 'default';
    if (!convSessions.has(convId)) {
      convSessions.set(convId, `audit-${convId}-${Date.now()}`);
    }
    const sessionId = convSessions.get(convId);

    const understood = understandQuery(q.question, [], chunks);
    const bm25Results = searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 5);
    const evidence = bm25Results.map(r => ({
      kind: r.tag, name: '', description: r.text, evidenceScore: r.rrfScore
    }));

    const state = sessionState.getState(sessionId);

    const result = await runLiteAgent({
      question: q.question,
      conversationState: state,
      evidence,
      knowledge,
      sessionId,
      model: MODEL
    });

    sessionState.updateState(sessionId, q.question, result.reply || '', knowledge);

    const genOk = result.events?.find(e => e.type === 'lite_generate_ok');
    const valEvt = result.events?.find(e => e.type === 'lite_validation');
    const repairEvt = result.events?.find(e => e.type === 'lite_repair_result');

    const entry = {
      conv: q.conv,
      turn: q.turn,
      category: q.category,
      question: q.question,
      outcome: result.fallback ? 'FALLBACK' : (result.outcome === 'repaired' ? 'REPAIRED' : 'ACCEPTED'),
      reply: String(result.reply || '').slice(0, 300),
      rawGen: genOk?.rawAnswer || genOk?.rawGenText || '',
      validationVerdict: valEvt?.verdict || null,
      validationReasons: valEvt?.reasons || [],
      repairVerdict: repairEvt?.verdict || null,
      repairReasons: repairEvt?.reasons || [],
      repairRaw: repairEvt?.rawAnswer || '',
      fallback: result.fallback,
      latencyMs: result.latencyMs
    };
    results.push(entry);

    if (result.fallback) {
      const rootCause = classifyFallback(result.events || [], true);
      entry.rootCause = rootCause;
      fallbackDetails.push(entry);
      console.log(`${q.conv}t${q.turn} [${q.category}] ${rootCause} ${result.latencyMs}ms`);
      console.log(`  Q: ${q.question}`);
      console.log(`  Raw: ${entry.rawGen.slice(0, 150)}`);
      console.log(`  Val: ${entry.validationReasons.slice(0, 2).join(', ')}`);
      if (entry.repairRaw) console.log(`  Repair: ${entry.repairRaw.slice(0, 100)}`);
      console.log('');
    } else {
      console.log(`${q.conv}t${q.turn} [${q.category}] ${entry.outcome} ${result.latencyMs}ms`);
    }
  }

  // Summary
  const counts = {};
  for (const f of fallbackDetails) {
    counts[f.rootCause] = (counts[f.rootCause] || 0) + 1;
  }
  console.log('\n=== FALLBACK ROOT CAUSE SUMMARY ===');
  console.log(`Total: ${results.length} | Accepted: ${results.filter(r => !r.fallback).length} | Fallback: ${fallbackDetails.length}`);
  for (const [cause, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cause}: ${count}`);
  }

  const outPath = path.join(__dirname, '..', 'data', 'parity-fallback-audit-results.json');
  fs.writeFileSync(outPath, JSON.stringify({ model: MODEL, results, fallbackDetails, counts }, null, 2));
  console.log(`\nDetailed results saved to ${outPath}`);
}

main().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
