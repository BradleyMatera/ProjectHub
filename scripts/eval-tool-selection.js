'use strict';

// Tool-Selection Evaluation
//
// Measures whether the model selects the correct tool for each question.
// Runs ONE reasoning step (no synthesis) and checks which tool the model
// requested. Reports:
//   * correct first tool %
//   * acceptable tool %
//   * unnecessary search_portfolio %
//   * invalid tool %
//   * no-tool (direct answer) correctly chosen %
//
// Usage: node scripts/eval-tool-selection.js [--model qwen2.5:0.5b]

const fs = require('fs');
const path = require('path');
const router = require('../lib/local-model-router');
const { buildReasoningPacket } = require('../lib/context-packet');
const { validateToolDecision, attemptJsonRepair } = require('../lib/grounding-validator');
const { allToolNames } = require('../lib/agent-engine');
const { selectAgentToolNames } = require('../lib/agent-tools');
const { getState, clearState } = require('../lib/session-state');
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');

const EVAL_PATH = path.join(__dirname, '..', 'data', 'tool-selection-eval.json');
const KNOWLEDGE_PATH = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
const evalData = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
const chunks = buildRagChunks(knowledge);
const bm25Index = new BM25Index(chunks);

function parseArgs() {
  const args = { model: null, verbose: false };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--model') args.model = process.argv[++i];
    else if (process.argv[i] === '--verbose') args.verbose = true;
  }
  return args;
}

async function getToolDecision(question, model) {
  const understood = understandQuery(question, [], chunks);
  const bm25Results = searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 5);
  const evidence = bm25Results.map(r => ({ kind: r.tag, name: '', description: r.text, evidenceScore: r.rrfScore }));
  const sessionId = 'tool-eval-' + Date.now();
  clearState(sessionId);
  const state = getState(sessionId);
  const hintTools = selectAgentToolNames(question);
  const toolHint = hintTools.length > 1 ? hintTools[hintTools.length - 1] : null;
  const packet = buildReasoningPacket({
    question,
    conversationState: state,
    evidence,
    toolNames: allToolNames(),
    phase: 'reason',
    toolHint
  });

  const result = await router.generate(model, [
    { role: 'system', content: packet.systemPrompt },
    { role: 'user', content: packet.userPrompt }
  ], {
    timeoutMs: 8000,
    temperature: 0.1,
    topP: 0.85,
    numPredict: 200,
    format: 'json'
  });

  if (!result.ok) return { tool: null, action: null, error: result.error, raw: result.text };
  let parsed;
  try { parsed = JSON.parse(result.text); } catch { parsed = attemptJsonRepair(result.text); }
  if (!parsed) return { tool: null, action: null, error: 'unparseable', raw: result.text };
  const validation = validateToolDecision(parsed, allToolNames());
  if (!validation.valid) return { tool: null, action: null, error: validation.error, raw: result.text };
  return {
    tool: validation.decision.tool || null,
    action: validation.decision.action,
    error: null,
    raw: result.text
  };
}

async function main() {
  const args = parseArgs();
  const model = args.model || router.agentModel();
  const questions = evalData.questions;

  console.log(`\n=== Tool-Selection Evaluation ===`);
  console.log(`Model: ${model}`);
  console.log(`Questions: ${questions.length}\n`);

  const results = [];
  for (const evalQ of questions) {
    const decision = await getToolDecision(evalQ.question, model);
    const correct = decision.tool === evalQ.correctTool;
    const acceptable = evalQ.acceptableTools.includes(decision.tool);
    const unnecessarySearch = decision.tool === 'search_portfolio' && evalQ.correctTool !== 'search_portfolio' && !evalQ.acceptableTools.includes('search_portfolio');
    const invalid = decision.tool && !allToolNames().includes(decision.tool);
    const directAnswer = decision.action === 'answer';

    const row = {
      id: evalQ.id,
      question: evalQ.question,
      correctTool: evalQ.correctTool,
      actualTool: decision.tool,
      action: decision.action,
      correct,
      acceptable,
      unnecessarySearch,
      invalid,
      directAnswer,
      error: decision.error
    };
    results.push(row);

    const status = correct ? '✓' : (acceptable ? '~' : (directAnswer ? '△' : '✗'));
    console.log(`[${status}] ${evalQ.id} expected=${evalQ.correctTool} got=${decision.tool || 'direct-answer'} ${decision.error ? 'err:'+decision.error : ''}`);
    if (args.verbose && decision.raw) console.log(`     raw: ${decision.raw.slice(0, 120)}`);
  }

  // Summary
  const correctCount = results.filter(r => r.correct).length;
  const acceptableCount = results.filter(r => r.acceptable).length;
  const unnecessarySearchCount = results.filter(r => r.unnecessarySearch).length;
  const invalidCount = results.filter(r => r.invalid).length;
  const directAnswerCount = results.filter(r => r.directAnswer).length;

  console.log(`\n=== Summary ===`);
  console.log(`Correct first tool:     ${correctCount}/${results.length} (${Math.round(correctCount / results.length * 100)}%)`);
  console.log(`Acceptable tool:        ${acceptableCount}/${results.length} (${Math.round(acceptableCount / results.length * 100)}%)`);
  console.log(`Unnecessary search:     ${unnecessarySearchCount}/${results.length}`);
  console.log(`Invalid tool:           ${invalidCount}/${results.length}`);
  console.log(`Direct answer (no tool): ${directAnswerCount}/${results.length}`);
  console.log(`Tool + direct combined:  ${acceptableCount + directAnswerCount}/${results.length} (${Math.round((acceptableCount + directAnswerCount) / results.length * 100)}%)`);

  // Per-tool breakdown
  console.log(`\n=== Per-Tool ===`);
  const tools = [...new Set(results.map(r => r.correctTool))];
  for (const tool of tools) {
    const toolResults = results.filter(r => r.correctTool === tool);
    const toolCorrect = toolResults.filter(r => r.correct).length;
    const toolAcceptable = toolResults.filter(r => r.acceptable).length;
    console.log(`  ${tool}: ${toolCorrect}/${toolResults.length} correct, ${toolAcceptable}/${toolResults.length} acceptable`);
  }

  // Save
  const outPath = path.join(__dirname, '..', 'data', 'tool-selection-results.json');
  fs.writeFileSync(outPath, JSON.stringify({ model, timestamp: new Date().toISOString(), results }, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
