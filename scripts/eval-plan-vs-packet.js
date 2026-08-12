'use strict';

/**
 * Plan vs Current Packet Comparison
 *
 * Runs the parity suite twice:
 * A: current hybrid evidence packet (no response plan)
 * B: semantic response plan + minimal evidence
 */

const { runLiteAgent } = require('../lib/lite-agent');
const { CONVERSATIONS } = require('../data/conversation-parity-suite');
const knowledge = require('../data/recruiter-knowledge.json');
const { BM25Index } = require('../lib/bm25');
const { buildRagChunks } = require('../lib/rag-chunks');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const sessionState = require('../lib/session-state');

const MODEL = process.env.OLLAMA_AGENT_MODEL || 'qwen2.5:1.5b';

async function runSuite(label, usePlan) {
  if (!usePlan) {
    process.env.SCOUT_DISABLE_RESPONSE_PLAN = 'true';
  } else {
    delete process.env.SCOUT_DISABLE_RESPONSE_PLAN;
  }

  const chunks = buildRagChunks(knowledge);
  const bm25Index = new BM25Index(chunks);

  const results = [];
  let totalPromptTokens = 0;
  let totalLatency = 0;
  const convSessions = new Map();

  for (let i = 0; i < CONVERSATIONS.length; i++) {
    const item = CONVERSATIONS[i];
    const convId = item.conv || 'default';
    if (!convSessions.has(convId)) {
      convSessions.set(convId, `plan-comp-${label}-${convId}-${Date.now()}`);
    }
    const sessionId = convSessions.get(convId);

    // Build conversation state for follow-up resolution
    const state = sessionState.getState(sessionId);

    // Retrieval
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

    const promptTokens = result.contextTokens || 0;
    totalPromptTokens += promptTokens;
    totalLatency += result.latencyMs || 0;

    let quality = 'GOOD';
    let rootCause = null;
    if (result.fallback) {
      quality = 'FALLBACK';
      rootCause = result.outcome || 'FALLBACK';
    } else {
      const reply = result.reply || '';
      const words = reply.split(/\s+/).filter(w => w.length > 0);
      if (words.length < 8) {
        quality = 'TERSE';
        rootCause = 'TOO_SHORT';
      } else if (/as an ai|based on the information|would you like/i.test(reply)) {
        quality = 'GENERIC';
        rootCause = 'GENERIC_FILLER';
      }
    }

    results.push({
      ...item,
      reply: result.reply || '',
      fallback: result.fallback,
      quality,
      rootCause,
      latencyMs: result.latencyMs,
      promptTokens,
      validationReasons: result.validation?.reasons || []
    });

    sessionState.updateState(sessionId, item.question, result.reply || '', knowledge);

    process.stdout.write('.');
  }
  console.log('');

  const good = results.filter(r => r.quality === 'GOOD').length;
  const terse = results.filter(r => r.quality === 'TERSE').length;
  const generic = results.filter(r => r.quality === 'GENERIC').length;
  const fallback = results.filter(r => r.fallback).length;
  const hallucinated = results.filter(r =>
    r.validationReasons.some(reason =>
      reason.startsWith('entity_not_grounded:') ||
      reason.startsWith('fabricated_entity:')
    )
  ).length;
  const wrongRel = results.filter(r =>
    r.validationReasons.some(reason => reason.startsWith('unsupported_relationship:'))
  ).length;
  const overclaim = results.filter(r =>
    r.validationReasons.some(reason =>
      reason.startsWith('expanded_overclaim:') ||
      reason.startsWith('relationship_overclaim:') ||
      reason === 'overclaim_language'
    )
  ).length;

  return {
    label,
    total: results.length,
    good,
    terse,
    generic,
    fallback,
    hallucinated,
    wrongRel,
    overclaim,
    avgPromptTokens: Math.round(totalPromptTokens / results.length),
    avgLatency: Math.round(totalLatency / results.length),
    results
  };
}

async function main() {
  console.log('=== Plan vs Current Packet Comparison ===');
  console.log(`Model: ${MODEL}`);
  console.log(`Questions: ${CONVERSATIONS.length}`);
  console.log('');

  console.log('Running A (current packet, no plan)...');
  const a = await runSuite('CURRENT', false);
  console.log(`A (current): good=${a.good} terse=${a.terse} generic=${a.generic} fallback=${a.fallback} halluc=${a.hallucinated} wrongRel=${a.wrongRel} overclaim=${a.overclaim} tokens=${a.avgPromptTokens} latency=${a.avgLatency}ms`);

  console.log('Running B (response plan)...');
  const b = await runSuite('PLAN', true);
  console.log(`B (plan):    good=${b.good} terse=${b.terse} generic=${b.generic} fallback=${b.fallback} halluc=${b.hallucinated} wrongRel=${b.wrongRel} overclaim=${b.overclaim} tokens=${b.avgPromptTokens} latency=${b.avgLatency}ms`);

  console.log('');
  console.log('=== DELTA ===');
  console.log(`good:      ${b.good - a.good >= 0 ? '+' : ''}${b.good - a.good}`);
  console.log(`terse:     ${b.terse - a.terse >= 0 ? '+' : ''}${b.terse - a.terse}`);
  console.log(`fallback:  ${b.fallback - a.fallback >= 0 ? '+' : ''}${b.fallback - a.fallback}`);
  console.log(`halluc:    ${b.hallucinated - a.hallucinated >= 0 ? '+' : ''}${b.hallucinated - a.hallucinated}`);
  console.log(`wrongRel:  ${b.wrongRel - a.wrongRel >= 0 ? '+' : ''}${b.wrongRel - a.wrongRel}`);
  console.log(`overclaim: ${b.overclaim - a.overclaim >= 0 ? '+' : ''}${b.overclaim - a.overclaim}`);
  console.log(`tokens:    ${b.avgPromptTokens - a.avgPromptTokens >= 0 ? '+' : ''}${b.avgPromptTokens - a.avgPromptTokens}`);
  console.log(`latency:   ${b.avgLatency - a.avgLatency >= 0 ? '+' : ''}${b.avgLatency - a.avgLatency}ms`);

  // Save detailed results
  const fs = require('fs');
  fs.writeFileSync('data/plan-vs-packet-results.json', JSON.stringify({ a, b }, null, 2));
  console.log('\nDetailed results saved to data/plan-vs-packet-results.json');
}

main().catch(err => { console.error(err); process.exit(1); });
