'use strict';

// Fallback root-cause analyzer: runs the Scout eval and captures the exact
// validation rejection reasons, the model's raw output, and the evidence
// for every fallback case. Classifies each as:
//   MODEL_FAILURE        — model produced garbage, too-short, or unparseable output
//   VALIDATOR_FALSE_REJ  — validator rejected an accurate paraphrase
//   CONTEXT_FAILURE      — retrieval didn't find relevant evidence
//   TOOL_FAILURE         — model requested wrong tool or tool returned nothing
//   PROMPT_FAILURE       — model returned prose instead of JSON or wrong schema
//
// Usage: node scripts/analyze-fallbacks.js

const fs = require('fs');
const path = require('path');
const router = require('../lib/local-model-router');
const { runAgentLoop } = require('../lib/agent-engine');
const { buildSynthesisPacket, buildReasoningPacket } = require('../lib/context-packet');
const { executeAgentTool, TOOL_DEFINITIONS } = require('../lib/agent-tools');
const { validateAnswer, validateToolDecision, attemptJsonRepair } = require('../lib/grounding-validator');
const { getState, clearState } = require('../lib/session-state');
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');

const KNOWLEDGE_PATH = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
const EVAL_PATH = path.join(__dirname, '..', 'data', 'scout-eval.json');
const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
const evalData = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));

const chunks = buildRagChunks(knowledge);
const bm25Index = new BM25Index(chunks);

function getEvidence(question) {
  const understood = understandQuery(question, [], chunks);
  const results = searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 5);
  return results.map(r => ({ kind: r.tag, name: '', description: r.text, evidenceScore: r.rrfScore }));
}

async function analyzeQuestion(evalQ) {
  const question = evalQ.question;
  const evidence = getEvidence(question);
  const sessionId = 'fallback-analysis-' + evalQ.id;
  clearState(sessionId);
  const state = getState(sessionId);

  const result = await runAgentLoop({
    question, conversationState: state, evidence, knowledge, sessionId,
    model: router.agentModel()
  });

  const analysis = {
    id: evalQ.id,
    question,
    fallback: result.fallback,
    reply: result.reply,
    events: result.events,
    steps: result.steps,
    toolResults: result.toolResults,
    evidenceCount: evidence.length,
    evidencePreview: evidence.slice(0, 3).map(e => e.description?.slice(0, 100)),
    classification: null,
    rejectionReasons: []
  };

  if (!result.fallback) {
    analysis.classification = 'ACCEPTED';
    return analysis;
  }

  // Classify the fallback
  const events = result.events || [];
  const reasoningFailed = events.some(e => e.type === 'reasoning_failed');
  const synthesisFailed = events.some(e => e.type === 'synthesis_failed');
  const synthesisRejected = events.some(e => e.type === 'synthesis_rejected');
  const directAnswerRejected = events.some(e => e.type === 'direct_answer_rejected');
  const duplicateTool = events.some(e => e.type === 'duplicate_tool_rejected');
  const budgetExceeded = events.some(e => e.type === 'budget_exceeded');

  // Extract rejection reasons from validation events
  for (const evt of events) {
    if (evt.type === 'validation' && evt.verdict !== 'supported') {
      analysis.rejectionReasons.push({ verdict: evt.verdict, reasons: evt.reasons });
    }
  }

  // Check if evidence was relevant
  const hasRelevantEvidence = evidence.length > 0 && evidence.some(e =>
    e.description && e.description.length > 20
  );

  if (reasoningFailed && !synthesisRejected) {
    analysis.classification = 'MODEL_FAILURE';
    analysis.detail = 'Reasoning step failed (timeout, unparseable JSON, or error)';
  } else if (synthesisFailed && !synthesisRejected) {
    analysis.classification = 'MODEL_FAILURE';
    analysis.detail = 'Synthesis step failed (timeout, unparseable JSON, or error)';
  } else if (synthesisRejected || directAnswerRejected) {
    // Check if the rejection was a false positive
    const reasons = analysis.rejectionReasons.flatMap(r => r.reasons || []);
    const hasOverclaim = reasons.some(r => r === 'overclaim_language' || r.startsWith('upgrade:'));
    const hasEntityIssue = reasons.some(r => r.startsWith('entity_not_grounded:'));
    const hasNumberIssue = reasons.some(r => r.startsWith('number_not_grounded:'));
    const hasOverlapIssue = reasons.includes('insufficient_content_overlap');
    const hasRelevanceIssue = reasons.includes('not_relevant_to_question');
    const hasSlopIssue = reasons.includes('ai_slop');
    const hasLengthIssue = reasons.includes('too_short') || reasons.includes('too_long');
    const hasStructureIssue = reasons.includes('no_terminal_punctuation') || reasons.includes('too_many_sentences');

    if (hasOverclaim || hasSlopIssue) {
      analysis.classification = 'MODEL_FAILURE';
      analysis.detail = `Model used overclaim/slop language: ${reasons.filter(r => r === 'overclaim_language' || r.startsWith('upgrade:') || r === 'ai_slop').join(', ')}`;
    } else if (hasRelevanceIssue) {
      analysis.classification = 'MODEL_FAILURE';
      analysis.detail = 'Answer was not relevant to the question';
    } else if (hasEntityIssue || hasNumberIssue) {
      analysis.classification = 'MODEL_FAILURE';
      analysis.detail = `Model introduced unsupported entities/numbers: ${reasons.filter(r => r.startsWith('entity_not_grounded:') || r.startsWith('number_not_grounded:')).join(', ')}`;
    } else if (hasOverlapIssue) {
      // This could be a false rejection — the model paraphrased accurately
      // but didn't share enough content words with the source
      analysis.classification = 'VALIDATOR_FALSE_REJ';
      analysis.detail = 'Validator rejected for insufficient content overlap — may be accurate paraphrase';
    } else if (hasLengthIssue || hasStructureIssue) {
      analysis.classification = 'MODEL_FAILURE';
      analysis.detail = `Answer too short/long or structurally invalid: ${reasons.filter(r => r.includes('too_') || r.includes('punctuation') || r.includes('sentences')).join(', ')}`;
    } else if (!hasRelevantEvidence) {
      analysis.classification = 'CONTEXT_FAILURE';
      analysis.detail = 'No relevant evidence retrieved';
    } else {
      analysis.classification = 'PROMPT_FAILURE';
      analysis.detail = `Other rejection: ${reasons.join(', ')}`;
    }
  } else if (duplicateTool) {
    analysis.classification = 'TOOL_FAILURE';
    analysis.detail = 'Model repeatedly requested the same tool';
  } else if (budgetExceeded) {
    analysis.classification = 'MODEL_FAILURE';
    analysis.detail = 'Budget exceeded before completing';
  } else if (!hasRelevantEvidence) {
    analysis.classification = 'CONTEXT_FAILURE';
    analysis.detail = 'No relevant evidence retrieved';
  } else {
    analysis.classification = 'OTHER';
    analysis.detail = 'Unclassified fallback';
  }

  return analysis;
}

async function main() {
  const questions = evalData.questions.filter(q => q.category !== 'conversational');
  console.log(`\n=== Fallback Root-Cause Analysis ===`);
  console.log(`Model: ${router.agentModel()}`);
  console.log(`Questions: ${questions.length}\n`);

  const results = [];
  for (const evalQ of questions) {
    const analysis = await analyzeQuestion(evalQ);
    results.push(analysis);
    if (analysis.fallback) {
      console.log(`[${analysis.id}] ${analysis.question.slice(0, 50)}`);
      console.log(`  CLASSIFICATION: ${analysis.classification}`);
      console.log(`  DETAIL: ${analysis.detail}`);
      console.log(`  REJECTION REASONS: ${JSON.stringify(analysis.rejectionReasons)}`);
      console.log(`  EVIDENCE: ${analysis.evidenceCount} items`);
      console.log();
    }
  }

  // Summary
  const accepted = results.filter(r => r.classification === 'ACCEPTED').length;
  const fallbacks = results.filter(r => r.fallback);
  const classifications = {};
  for (const r of fallbacks) {
    classifications[r.classification] = (classifications[r.classification] || 0) + 1;
  }

  console.log('=== Summary ===');
  console.log(`Accepted: ${accepted}/${results.length}`);
  console.log(`Fallback: ${fallbacks.length}/${results.length}`);
  console.log(`Classifications:`);
  for (const [cls, count] of Object.entries(classifications).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${count}`);
  }

  // Save
  const outPath = path.join(__dirname, '..', 'data', 'fallback-analysis.json');
  fs.writeFileSync(outPath, JSON.stringify({ model: router.agentModel(), timestamp: new Date().toISOString(), results }, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
