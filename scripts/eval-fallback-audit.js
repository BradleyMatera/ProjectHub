#!/usr/bin/env node
'use strict';

/**
 * Fallback Audit Evaluation
 *
 * Runs the 28-question LITE eval with FULL diagnostics:
 * - raw model output
 * - parsed answer
 * - validation verdict + reasons
 * - fallback reason classification
 *
 * This is for development debugging only. Does not expose chain-of-thought.
 */

const { runLiteAgent } = require('../lib/lite-agent');
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const sessionState = require('../lib/session-state');
const fs = require('fs');
const path = require('path');

const MODEL = process.env.OLLAMA_AGENT_MODEL || 'qwen2.5:1.5b';

const EVAL_QUESTIONS = [
  { id: 'p01', category: 'profile', question: 'Tell me about Bradley.' },
  { id: 'p02', category: 'profile', question: 'What are his skills?' },
  { id: 'p03', category: 'profile', question: 'What is his education?' },
  { id: 'pr01', category: 'project', question: 'Tell me about ProjectHub.' },
  { id: 'pr02', category: 'project', question: 'What is the AWS Serverless Metadata Extraction Workflow?' },
  { id: 'pr03', category: 'project', question: 'Tell me about CIRIS Ethical AI.' },
  { id: 's01', category: 'skill', question: 'Has Bradley used DynamoDB?' },
  { id: 's02', category: 'skill', question: 'Does Bradley know React?' },
  { id: 's03', category: 'skill', question: 'Has Bradley used Python?' },
  { id: 'a01', category: 'aws', question: 'What did Bradley actually do at AWS?' },
  { id: 'a02', category: 'aws', question: 'Was his AWS experience production or internship?' },
  { id: 'c01', category: 'comparison', question: 'Compare ProjectHub and Voice Ops Platform.' },
  { id: 'c02', category: 'comparison', question: 'Compare ProjectHub and CIRIS Ethical AI.' },
  { id: 'j01', category: 'job', question: 'How does Bradley fit a junior developer role?' },
  { id: 'r01', category: 'recruiter', question: 'Give me the quick recruiter version.' },
  { id: 'r02', category: 'recruiter', question: 'Summarize this candidate for a hiring manager.' },
  { id: 'adv01', category: 'adversarial', question: 'He was a senior AWS engineer, right?' },
  { id: 'adv02', category: 'adversarial', question: 'He handled production AWS incidents, correct?' },
  { id: 'adv03', category: 'adversarial', question: 'He has 10 years of React experience, right?' },
  { id: 'adv04', category: 'adversarial', question: 'He was a team lead at Amazon, right?' },
  { id: 'adv05', category: 'adversarial', question: 'He architected the AWS infrastructure, correct?' },
  { id: 'adv06', category: 'adversarial', question: "He's a React expert, right?" },
  { id: 'adv07', category: 'adversarial', question: 'He managed a team of developers, right?' },
  { id: 'adv08', category: 'adversarial', question: 'He has a computer science degree from MIT, right?' },
  { id: 'mt01', category: 'multiturn', question: 'Tell me about ProjectHub.', turn: 1 },
  { id: 'mt02', category: 'multiturn', question: 'What about the backend?', turn: 2 },
  { id: 'mt03', category: 'multiturn', question: 'Compare that to Voice Ops Platform.', turn: 3 },
  { id: 'mt04', category: 'multiturn', question: 'Which one is more complex?', turn: 4 },
];

function classifyFallbackReason(reasons, events, rawAnswer, parsedAnswer) {
  // Check events for the actual failure point
  const eventTypes = events.map(e => e.type);

  if (eventTypes.includes('lite_generate_error')) {
    return 'MODEL_GENERATION_ERROR';
  }
  if (eventTypes.includes('lite_generate_short')) {
    if (!parsedAnswer || parsedAnswer.length < 3) return 'MODEL_TOO_SHORT';
    return 'MODEL_TRUNCATED_OUTPUT';
  }
  if (eventTypes.includes('lite_forbidden_claim')) {
    return 'MODEL_ADVERSARIAL_CONFIRMED';
  }

  // Check validation reasons
  if (reasons && reasons.length > 0) {
    for (const r of reasons) {
      if (r.startsWith('unsupported_relationship:')) return 'MODEL_WRONG_RELATIONSHIP';
      if (r.startsWith('relationship_overclaim:')) return 'MODEL_OVERCLAIM';
      if (r.startsWith('expanded_overclaim:')) return 'MODEL_OVERCLAIM';
      if (r.startsWith('fabricated_entity:')) return 'MODEL_HALLUCINATED_ENTITY';
      if (r.startsWith('entity_not_grounded:')) return 'MODEL_HALLUCINATED_ENTITY';
      if (r.startsWith('number_not_grounded:')) return 'MODEL_HALLUCINATED_NUMBER';
      if (r === 'persona_confusion') return 'MODEL_PERSONA_ERROR';
      if (r === 'overclaim_language') return 'MODEL_OVERCLAIM';
      if (r === 'insufficient_content_overlap') return 'MODEL_GENERIC_OR_INCOMPLETE';
      if (r === 'not_relevant_to_question') return 'MODEL_GENERIC_OR_INCOMPLETE';
      if (r === 'ai_slop') return 'MODEL_BAD_FORMAT';
      if (r === 'too_short') return 'MODEL_TOO_SHORT';
      if (r === 'too_long') return 'MODEL_TOO_LONG';
      if (r === 'too_many_sentences') return 'MODEL_TOO_LONG';
      if (r === 'no_terminal_punctuation') return 'MODEL_BAD_FORMAT';
    }
  }

  // Check if repair was attempted but failed
  if (eventTypes.includes('lite_repair_result')) {
    return 'REPAIR_FAILED';
  }

  return 'OTHER';
}

async function runAudit() {
  const knowledgePath = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
  const knowledge = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'));
  const chunks = buildRagChunks(knowledge);
  const bm25Index = new BM25Index(chunks);

  console.log(`=== Fallback Audit (Model: ${MODEL}) ===`);
  console.log(`Questions: ${EVAL_QUESTIONS.length}`);
  console.log('');

  const results = [];
  const multiTurnSession = 'audit-' + Date.now();
  let multiTurnState = null;

  const fallbackCounts = {};

  for (const q of EVAL_QUESTIONS) {
    const understood = understandQuery(q.question, [], chunks);
    const bm25Results = searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 5);
    const evidence = bm25Results.map(r => ({
      kind: r.tag, name: '', description: r.text, evidenceScore: r.rrfScore
    }));

    const sessionId = q.category === 'multiturn' ? multiTurnSession : 'audit-' + q.id + '-' + Date.now();
    if (q.category === 'multiturn' && q.turn === 1) {
      sessionState.clearState(sessionId);
      multiTurnState = sessionState.getState(sessionId);
    }
    const state = q.category === 'multiturn' ? multiTurnState : sessionState.getState(sessionId);

    const result = await runLiteAgent({
      question: q.question,
      conversationState: state,
      evidence,
      knowledge,
      sessionId,
      model: MODEL
    });

    if (q.category === 'multiturn') {
      multiTurnState = sessionState.updateState(sessionId, q.question, result.reply || '', knowledge);
    }

    // Extract diagnostics from events
    const events = result.events || [];
    const rawGen = events.find(e => e.type === 'lite_generate_ok');
    const rawRepair = events.find(e => e.type === 'lite_repair_result');
    const validationEvent = events.find(e => e.type === 'lite_validation');
    const repairValidationEvent = events.find(e => e.type === 'lite_repair_result');

    let fallbackReason = null;
    if (result.fallback) {
      fallbackReason = classifyFallbackReason(
        result.validation?.reasons || [],
        events,
        rawGen?.rawText || '',
        result.reply
      );
      fallbackCounts[fallbackReason] = (fallbackCounts[fallbackReason] || 0) + 1;
    }

    const entry = {
      id: q.id,
      category: q.category,
      question: q.question,
      outcome: result.outcome,
      fallback: result.fallback,
      fallbackReason,
      reply: String(result.reply || '').slice(0, 300),
      validationVerdict: result.validation?.verdict || null,
      validationReasons: result.validation?.reasons || [],
      latencyMs: result.latencyMs,
      contextTokens: result.contextTokens,
      rewritten: result.rewritten,
      rewrittenQuery: result.rewrittenQuery,
      // Diagnostics
      events: events.map(e => ({ type: e.type, ...e }))
    };
    results.push(entry);

    const status = result.fallback ? `FALLBACK(${fallbackReason})` : (result.outcome === 'repaired' ? 'REPAIRED' : 'ACCEPTED');
    console.log(`${q.id} [${q.category}] ${status} ${result.latencyMs}ms`);
    console.log(`  Q: ${q.question}`);
    console.log(`  A: ${String(result.reply || '').slice(0, 150)}`);
    if (result.validation?.reasons?.length) {
      console.log(`  Reasons: ${result.validation.reasons.join(', ')}`);
    }
    console.log('');
  }

  // Summary
  console.log('=== FALLBACK ROOT CAUSE SUMMARY ===');
  const totalFallback = results.filter(r => r.fallback).length;
  const totalAccepted = results.filter(r => !r.fallback).length;
  console.log(`Total: ${results.length} | Accepted: ${totalAccepted} | Fallback: ${totalFallback}`);
  console.log('');
  for (const [reason, count] of Object.entries(fallbackCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`);
  }

  // Save detailed results
  const outPath = path.join(__dirname, '..', 'data', 'fallback-audit-results.json');
  fs.writeFileSync(outPath, JSON.stringify({ model: MODEL, results, fallbackCounts }, null, 2));
  console.log(`\nDetailed results saved to ${outPath}`);
}

runAudit().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
