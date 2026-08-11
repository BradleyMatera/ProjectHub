'use strict';

// Scout Evaluation Harness
//
// Runs the Scout evaluation dataset against:
//   1. RAW local model (minimal context)
//   2. SCOUT-ASSISTED model (full harness: retrieval, context, tools, validation)
//
// Measures:
//   * answer produced (or fallback)
//   * grounding verdict (supported/partial/unsupported)
//   * unsupported claim rate
//   * tool-selection accuracy (did the model request a relevant tool?)
//   * structured-output success rate (did the model produce valid JSON?)
//   * latency
//   * context tokens
//
// Usage: node scripts/eval-scout.js [--model qwen2.5:0.5b] [--raw-only] [--scout-only]
// Requires Ollama running locally.

const fs = require('fs');
const path = require('path');
const router = require('../lib/local-model-router');
const { runAgentLoop, probeAgent } = require('../lib/agent-engine');
const { buildRawPacket } = require('../lib/context-packet');
const { validateAnswer, OVERCLAIM_RE } = require('../lib/grounding-validator');
const { executeAgentTool } = require('../lib/agent-tools');
const { getState, updateState, clearState } = require('../lib/session-state');

const EVAL_PATH = path.join(__dirname, '..', 'data', 'scout-eval.json');
const KNOWLEDGE_PATH = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
const evalData = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));

function parseArgs() {
  const args = { model: null, rawOnly: false, scoutOnly: false, verbose: false };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--model') args.model = process.argv[++i];
    else if (process.argv[i] === '--raw-only') args.rawOnly = true;
    else if (process.argv[i] === '--scout-only') args.scoutOnly = true;
    else if (process.argv[i] === '--verbose') args.verbose = true;
  }
  return args;
}

async function rawModelAnswer(question, model) {
  const packet = buildRawPacket({ question, agentName: 'Scout' });
  const result = await router.generate(model, [
    { role: 'system', content: packet.systemPrompt },
    { role: 'user', content: packet.userPrompt }
  ], { timeoutMs: 10000, numPredict: 100, temperature: 0.3 });
  return { ok: result.ok, text: result.text, latencyMs: result.latencyMs, error: result.error, tokens: packet.estimatedTokens };
}

async function scoutAssisted(question, model, sessionId) {
  clearState(sessionId);
  const state = getState(sessionId);
  const search = executeAgentTool('search_portfolio', { query: question, limit: 5 }, knowledge);
  const evidence = search.results;
  const result = await runAgentLoop({
    question,
    conversationState: state,
    evidence,
    knowledge,
    sessionId,
    model
  });
  updateState(sessionId, question, result.reply || '', knowledge, null);
  return result;
}

// Score an answer against the eval question's expectations.
function scoreAnswer(answer, evalQ, sourceText) {
  const text = String(answer || '').toLowerCase();
  const result = {
    produced: !!answer && answer.length >= 20,
    grounded: false,
    overclaim: false,
    forbiddenClaims: [],
    keyEntitiesFound: [],
    verdict: 'none'
  };

  if (!result.produced) return result;

  // Grounding validation
  const validation = validateAnswer(answer, sourceText || '', evalQ.question);
  result.grounded = validation.valid;
  result.verdict = validation.verdict;

  // Overclaim check
  result.overclaim = OVERCLAIM_RE.test(answer);

  // Forbidden claims
  if (evalQ.mustNotClaim) {
    for (const forbidden of evalQ.mustNotClaim) {
      if (text.includes(forbidden.toLowerCase())) {
        result.forbiddenClaims.push(forbidden);
      }
    }
  }

  // Key entities
  if (evalQ.keyEntities) {
    for (const entity of evalQ.keyEntities) {
      if (text.includes(entity.toLowerCase())) {
        result.keyEntitiesFound.push(entity);
      }
    }
  }

  return result;
}

function buildSourceFromEvidence(evidence) {
  return (evidence || []).map(e => JSON.stringify(e)).join(' ');
}

async function main() {
  const args = parseArgs();
  const model = args.model || router.agentModel();
  const questions = evalData.questions.filter(q => q.category !== 'conversational'); // conversational needs multi-turn setup

  console.log(`\n=== Scout Evaluation ===`);
  console.log(`Model: ${model}`);
  console.log(`Questions: ${questions.length}`);
  console.log(`Ollama: ${router.configuredOllamaUrl()}\n`);

  // Probe
  const probe = await probeAgent(model);
  if (!probe.reachable) {
    console.log(`Ollama not reachable: ${probe.error}`);
    process.exit(1);
  }
  console.log(`Probe: reachable=${probe.reachable} structured=${probe.structuredOk} latency=${probe.latencyMs}ms\n`);

  const results = [];
  const sessionId = 'eval-' + Date.now();

  for (const evalQ of questions) {
    const row = { id: evalQ.id, category: evalQ.category, question: evalQ.question };
    const search = executeAgentTool('search_portfolio', { query: evalQ.question, limit: 5 }, knowledge);
    const sourceText = buildSourceFromEvidence(search.results) + ' ' + JSON.stringify(knowledge).slice(0, 8000);

    // Raw model
    if (!args.scoutOnly) {
      const raw = await rawModelAnswer(evalQ.question, model);
      row.raw = {
        produced: raw.ok && raw.text && raw.text.length >= 20,
        answer: String(raw.text || '').slice(0, 200),
        latencyMs: raw.latencyMs,
        tokens: raw.tokens,
        score: scoreAnswer(raw.text, evalQ, sourceText)
      };
      row.raw.score.grounded = row.raw.produced && row.raw.score.grounded;
    }

    // Scout-assisted
    if (!args.rawOnly) {
      const scout = await scoutAssisted(evalQ.question, model, sessionId + '-' + evalQ.category);
      row.scout = {
        produced: !scout.fallback && !!scout.reply,
        answer: String(scout.reply || '').slice(0, 200),
        fallback: scout.fallback,
        latencyMs: scout.latencyMs,
        contextTokens: scout.contextTokens,
        steps: scout.steps.length,
        tools: scout.toolResults.map(t => t.tool),
        score: scoreAnswer(scout.reply, evalQ, sourceText)
      };
    }

    results.push(row);

    if (args.verbose || (!args.rawOnly && !args.scoutOnly)) {
      console.log(`[${evalQ.id}] ${evalQ.question}`);
      if (row.raw) {
        console.log(`  RAW: grounded=${row.raw.score.grounded} overclaim=${row.raw.score.overclaim} forbidden=${row.raw.score.forbiddenClaims.length} [${row.raw.latencyMs}ms]`);
        if (args.verbose) console.log(`       "${row.raw.answer}"`);
      }
      if (row.scout) {
        console.log(`  SCOUT: grounded=${row.scout.score.grounded} fallback=${row.scout.fallback} forbidden=${row.scout.score.forbiddenClaims.length} tools=[${row.scout.tools.join(',')}] ctx=${row.scout.contextTokens}tok [${row.scout.latencyMs}ms]`);
        if (args.verbose) console.log(`       "${row.scout.answer}"`);
      }
      console.log();
    }
  }

  // Summary
  console.log('=== Summary ===\n');
  const categories = ['factual', 'adversarial'];
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    if (catResults.length === 0) continue;
    console.log(`--- ${cat} (${catResults.length} questions) ---`);
    if (!args.scoutOnly) {
      const rawGrounded = catResults.filter(r => r.raw?.score.grounded).length;
      const rawOverclaim = catResults.filter(r => r.raw?.score.overclaim).length;
      const rawForbidden = catResults.filter(r => r.raw?.score.forbiddenClaims.length > 0).length;
      const rawProduced = catResults.filter(r => r.raw?.produced).length;
      console.log(`  RAW:      produced=${rawProduced}/${catResults.length} grounded=${rawGrounded}/${catResults.length} overclaim=${rawOverclaim} forbidden=${rawForbidden}`);
    }
    if (!args.rawOnly) {
      const scoutGrounded = catResults.filter(r => r.scout?.score.grounded).length;
      const scoutFallback = catResults.filter(r => r.scout?.fallback).length;
      const scoutForbidden = catResults.filter(r => r.scout?.score.forbiddenClaims.length > 0).length;
      const scoutProduced = catResults.filter(r => r.scout?.produced).length;
      const avgLatency = Math.round(catResults.reduce((s, r) => s + (r.scout?.latencyMs || 0), 0) / catResults.length);
      const avgCtx = Math.round(catResults.reduce((s, r) => s + (r.scout?.contextTokens || 0), 0) / catResults.length);
      console.log(`  SCOUT:    produced=${scoutProduced}/${catResults.length} grounded=${scoutGrounded}/${catResults.length} fallback=${scoutFallback} forbidden=${scoutForbidden} avgLatency=${avgLatency}ms avgCtx=${avgCtx}tok`);
    }
    console.log();
  }

  // Overall
  console.log('--- Overall ---');
  if (!args.scoutOnly) {
    const rawGrounded = results.filter(r => r.raw?.score.grounded).length;
    const rawOverclaim = results.filter(r => r.raw?.score.overclaim).length;
    console.log(`  RAW:   grounded=${rawGrounded}/${results.length} (${Math.round(rawGrounded / results.length * 100)}%) overclaim=${rawOverclaim}/${results.length}`);
  }
  if (!args.rawOnly) {
    const scoutGrounded = results.filter(r => r.scout?.score.grounded).length;
    const scoutFallback = results.filter(r => r.scout?.fallback).length;
    const scoutForbidden = results.filter(r => r.scout?.score.forbiddenClaims.length > 0).length;
    console.log(`  SCOUT: grounded=${scoutGrounded}/${results.length} (${Math.round(scoutGrounded / results.length * 100)}%) fallback=${scoutFallback} forbidden=${scoutForbidden}/${results.length}`);
  }

  // Save results
  const outPath = path.join(__dirname, '..', 'data', 'scout-eval-results.json');
  fs.writeFileSync(outPath, JSON.stringify({ model, timestamp: new Date().toISOString(), results }, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
