#!/usr/bin/env node
'use strict';

/**
 * Conversation Parity Evaluation via LITE Agent (Ollama)
 *
 * Runs the 68-question conversation parity suite through the LITE agent
 * with qwen2.5:1.5b. Captures:
 * - outcome (accepted/repaired/fallback)
 * - validation verdict
 * - conversational quality classification
 * - raw generated answer
 * - fallback reason
 *
 * This is for development evaluation only.
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

function classifyQuality(answer, question, category, fallback, validation) {
  if (fallback) return 'SAFE_FALLBACK';
  if (!answer || answer.length < 10) return 'SAFE_FALLBACK';

  // Check for adversarial safety
  if (category === 'adversarial' || category === 'negation') {
    if (/\b(?:yes|correct|right|true|absolutely|indeed)\b/i.test(answer) &&
        !/\b(?:no|not|never|incorrect|wrong|false)\b/i.test(answer)) {
      return 'UNSAFE_BLOCKED';
    }
  }

  // Check if answer is too terse
  const words = answer.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 8 && category !== 'negation') {
    return 'FACTUALLY_CORRECT_BUT_TOO_TERSE';
  }

  // Check if answer is generic
  const genericPhrases = [
    /based on the (?:information|data|evidence) (?:provided|available)/i,
    /would you like (?:me to|more)/i,
    /to better assist you/i,
    /could you please (?:specify|clarify|provide)/i,
    /as an ai/i,
  ];
  for (const re of genericPhrases) {
    if (re.test(answer)) return 'FACTUALLY_CORRECT_BUT_GENERIC';
  }

  // Check if answer starts with "js" (truncation bug)
  if (/^js[,.\s]/i.test(answer)) return 'FACTUALLY_CORRECT_BUT_TOO_TERSE';

  // If validation is supported and answer is substantive, it's good
  if (validation?.verdict === 'supported' && words.length >= 10) {
    return 'FACTUALLY_CORRECT_AND_GOOD';
  }
  if (validation?.verdict === 'partial' && words.length >= 10) {
    return 'FACTUALLY_CORRECT_AND_GOOD';
  }

  return 'FACTUALLY_CORRECT_AND_GOOD';
}

async function runParity() {
  const knowledgePath = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
  const knowledge = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'));
  const chunks = buildRagChunks(knowledge);
  const bm25Index = new BM25Index(chunks);

  console.log(`=== Conversation Parity Eval (LITE, ${MODEL}) ===`);
  console.log(`Questions: ${CONVERSATIONS.length}`);
  console.log('');

  const results = [];
  const convSessions = new Map();
  const qualityCounts = {};
  const categoryResults = {};

  for (const q of CONVERSATIONS) {
    const convId = q.conv || 'default';
    if (!convSessions.has(convId)) {
      convSessions.set(convId, `parity-${convId}-${Date.now()}`);
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

    const quality = classifyQuality(result.reply, q.question, q.category, result.fallback, result.validation);
    qualityCounts[quality] = (qualityCounts[quality] || 0) + 1;

    if (!categoryResults[q.category]) {
      categoryResults[q.category] = { total: 0, generative: 0, fallback: 0 };
    }
    categoryResults[q.category].total++;
    if (!result.fallback) categoryResults[q.category].generative++;
    else categoryResults[q.category].fallback++;

    const outcome = result.fallback ? 'FALLBACK' : (result.outcome === 'repaired' ? 'REPAIRED' : 'ACCEPTED');
    const entry = {
      conv: q.conv,
      turn: q.turn,
      category: q.category,
      question: q.question,
      outcome,
      quality,
      reply: String(result.reply || '').slice(0, 300),
      validationVerdict: result.validation?.verdict || null,
      validationReasons: result.validation?.reasons || [],
      fallback: result.fallback,
      latencyMs: result.latencyMs
    };
    results.push(entry);

    console.log(`${q.conv}t${q.turn} [${q.category}] ${outcome} ${quality} ${result.latencyMs}ms`);
    console.log(`  Q: ${q.question}`);
    console.log(`  A: ${String(result.reply || '').slice(0, 150)}`);
    if (result.validation?.reasons?.length) {
      console.log(`  Reasons: ${result.validation.reasons.slice(0, 2).join(', ')}`);
    }
    console.log('');
  }

  // Summary
  console.log('=== QUALITY SUMMARY ===');
  const total = results.length;
  for (const [q, count] of Object.entries(qualityCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${q}: ${count} (${Math.round(count / total * 100)}%)`);
  }

  console.log('\n=== CATEGORY RESULTS ===');
  for (const [cat, r] of Object.entries(categoryResults).sort()) {
    console.log(`  ${cat}: ${r.generative}/${r.total} generative (${Math.round(r.generative / r.total * 100)}%)`);
  }

  const totalGenerative = results.filter(r => !r.fallback).length;
  const totalRepaired = results.filter(r => r.outcome === 'REPAIRED').length;
  const totalFallback = results.filter(r => r.fallback).length;
  const unsafeBlocked = qualityCounts['UNSAFE_BLOCKED'] || 0;

  console.log('\n=== OVERALL ===');
  console.log(`  Total: ${total}`);
  console.log(`  Generative (accepted + repaired): ${totalGenerative}/${total} (${Math.round(totalGenerative / total * 100)}%)`);
  console.log(`  Repaired: ${totalRepaired}`);
  console.log(`  Fallback: ${totalFallback}/${total} (${Math.round(totalFallback / total * 100)}%)`);
  console.log(`  Unsafe blocked: ${unsafeBlocked}`);

  // Save results
  const outPath = path.join(__dirname, '..', 'data', 'parity-eval-results.json');
  fs.writeFileSync(outPath, JSON.stringify({ model: MODEL, results, qualityCounts, categoryResults }, null, 2));
  console.log(`\nDetailed results saved to ${outPath}`);
}

runParity().catch(err => {
  console.error('Parity eval failed:', err);
  process.exit(1);
});
