#!/usr/bin/env node
'use strict';

// Phase 1 instrumentation: trace current RAG context loss in Scout LITE mode.
// Does not change answer semantics; stubs the LLM call to capture the prompt.

process.env.SCOUT_LITE_ENABLE_REPAIR = 'false';

const fs = require('fs');
const path = require('path');

const knowledge = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'recruiter-knowledge.json'), 'utf8')
);
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const sessionState = require('../lib/session-state');
const { classifyResponsePolicy } = require('../lib/response-policy');

const agentTools = require('../lib/agent-tools');
const origExecuteAgentTool = agentTools.executeAgentTool;
agentTools.executeAgentTool = function traceExecuteAgentTool(name, args, knowledgeBase) {
  global.__lastToolCall = { tool: name, args };
  return origExecuteAgentTool(name, args, knowledgeBase);
};

const { runLiteAgent } = require('../lib/lite-agent');
const router = require('../lib/local-model-router');

const STUB_ANSWER = '[STUB] Concise answer synthesized from the provided facts.';

router.generate = async function traceGenerate(model, messages, options) {
  const system = messages.find(m => m.role === 'system')?.content || '';
  const user = messages.find(m => m.role === 'user')?.content || '';
  if (!global.__generateCalls) global.__generateCalls = [];
  global.__generateCalls.push({ system, user, callIndex: global.__generateCalls.length });
  return {
    ok: true,
    text: JSON.stringify({ answer: STUB_ANSWER }),
    usage: {
      provider: 'stub',
      promptEvalCount: Math.ceil((system.length + user.length) / 4),
      evalCount: 12
    },
    latencyMs: 0,
    startedAt: Date.now(),
    endedAt: Date.now()
  };
};

const chunks = buildRagChunks(knowledge);
const bm25Index = new BM25Index(chunks);

const QUESTIONS = [
  { id: 'q1', text: 'Tell me about Bradley\'s AWS experience.' },
  { id: 'q2', text: 'What did he actually do during his AWS internship?' },
  { id: 'q3', text: 'What projects show that he can work with APIs?' },
  { id: 'q4', text: 'What kind of developer is Bradley?' },
  { id: 'q5', text: 'How does ProjectHub work?' },
  { id: 'q6', text: 'What has he done with AI?' },
  { id: 'q7', text: 'What experience does he have that would help with an ERP support role?' },
  { id: 'q8', text: 'Compare ProjectHub with his AWS capstone.' },
  { id: 'q9', text: 'What are some things he still needs to learn?' },
  { id: 'q10', text: 'Based on his projects and experience, what kind of technical work is he strongest at?' }
];

function estimatedTokens(text) {
  const str = String(text || '');
  const words = str.split(/\s+/).filter(Boolean).length;
  const punct = (str.match(/[.,;:!?()[\]{ }"'`/\\@#$%^&*+=|<>~]/g) || []).length;
  return Math.ceil((words * 1.3 + punct * 0.5) * 1.15);
}

function findSectionEnd(prompt, startIdx, headers) {
  const indices = headers
    .map(h => prompt.indexOf(h, startIdx + 1))
    .filter(i => i !== -1);
  return indices.length ? Math.min(...indices) : prompt.length;
}

function parsePromptSections(prompt) {
  const baseEnd = prompt.indexOf('RESPONSE INSTRUCTIONS:');
  const contractStart = prompt.indexOf('RESPONSE INSTRUCTIONS:');
  const planStart = prompt.indexOf('ANSWER GUIDE:');
  const relStart = prompt.indexOf('RELATIONSHIPS (verified only):');
  const factsStart = prompt.indexOf('FACTS:');

  const baseChars = contractStart !== -1 ? contractStart : factsStart !== -1 ? factsStart : prompt.length;

  function slice(start, header, nextHeaders) {
    if (start === -1) return '';
    const bodyStart = prompt.indexOf('\n', start);
    if (bodyStart === -1) return '';
    const end = findSectionEnd(prompt, bodyStart, nextHeaders);
    return prompt.slice(bodyStart + 1, end).trim();
  }

  const contractText = slice(contractStart, 'RESPONSE INSTRUCTIONS:', ['ANSWER GUIDE:', 'RELATIONSHIPS (verified only):', 'FACTS:']);
  const planText = slice(planStart, 'ANSWER GUIDE:', ['RELATIONSHIPS (verified only):', 'FACTS:']);
  const relText = slice(relStart, 'RELATIONSHIPS (verified only):', ['FACTS:']);
  const factsText = slice(factsStart, 'FACTS:', []);

  return {
    baseInstructionChars: baseChars,
    contractChars: contractText.length,
    planChars: planText.length,
    relationshipChars: relText.length,
    factsChars: factsText.length,
    factsText,
    baseInstructions: prompt.slice(0, baseChars).trim()
  };
}

function analyzeEvidence(ragResults, factsText) {
  const ragIds = ragResults.map((r, i) => ({
    rank: i + 1,
    tag: r.tag,
    name: r.title || r.name || '',
    score: r.rrfScore,
    text: r.text
  }));

  const dropped = [];
  for (const r of ragIds) {
    const excerpt = r.text.slice(0, 80).replace(/\s+/g, ' ');
    const stillInFacts = factsText.includes(excerpt) || factsText.includes(r.text.slice(0, 60));
    if (!stillInFacts) {
      dropped.push({ rank: r.rank, tag: r.tag, snippet: r.text.slice(0, 160) });
    }
  }
  return { ragIds, dropped };
}

async function traceQuestion(item) {
  const sessionId = `trace-${item.id}-${Date.now()}`;
  sessionState.clearState(sessionId);
  const state = sessionState.getState(sessionId);

  const understood = understandQuery(item.text, [], chunks);
  const rewritten = understood.rewritten || item.text;

  const bm25Results = searchBm25WithRrf(
    bm25Index,
    [understood.normalized, understood.expanded, understood.rewritten],
    8
  );
  const evidence = bm25Results.map(r => ({
    kind: r.tag,
    name: r.title || r.name || '',
    description: r.text,
    evidenceScore: r.rrfScore
  }));

  const policy = classifyResponsePolicy(item.text, [], knowledge);
  const policyContract = { mode: policy.mode, ...policy };
  delete policyContract.contract;

  global.__lastToolCall = null;
  global.__generateCalls = [];

  const result = await runLiteAgent({
    question: item.text,
    conversationState: state,
    evidence,
    knowledge,
    sessionId,
    policyContract
  });

  const toolCall = global.__lastToolCall || { tool: result.operation || 'unknown', args: null };
  const primaryCall = (global.__generateCalls || [])[0] || { system: '', user: '' };
  const prompt = primaryCall;
  const sections = parsePromptSections(prompt.system);

  const compressedCharsEvent = result.events.find(e => e.type === 'lite_compress');
  const compressedChars = compressedCharsEvent ? compressedCharsEvent.compressedChars : 0;
  const supplementFired = Boolean(compressedCharsEvent && compressedCharsEvent.compressedChars < 200 && evidence.length);

  const { ragIds, dropped } = analyzeEvidence(bm25Results, sections.factsText);

  const toolResult = (result.toolResults && result.toolResults[0]) ? result.toolResults[0].result : null;

  return {
    id: item.id,
    question: item.text,
    rewritten,
    bm25Results: ragIds,
    preRoute: {
      operation: result.operation,
      tool: toolCall.tool,
      args: toolCall.args
    },
    toolResult: toolResult,
    compressedChars,
    supplementFired,
    finalFactsText: sections.factsText,
    finalFactsChars: sections.factsChars,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    droppedEvidence: dropped,
    promptBreakdown: {
      baseInstructions: sections.baseInstructionChars,
      responseContract: sections.contractChars,
      answerGuide: sections.planChars,
      relationships: sections.relationshipChars,
      facts: sections.factsChars,
      userPrompt: prompt.user.length,
      totalChars: prompt.system.length + prompt.user.length,
      estimatedTokens: estimatedTokens(prompt.system) + estimatedTokens(prompt.user)
    },
    stubAnswer: result.reply,
    validatorVerdict: result.validation?.verdict || null,
    validatorReasons: result.validation?.reasons || null,
    outcome: result.outcome,
    events: result.events.map(e => ({ type: e.type, ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'type')) }))
  };
}

async function main() {
  const traces = [];
  for (const q of QUESTIONS) {
    try {
      const trace = await traceQuestion(q);
      traces.push(trace);
      console.log(`${q.id}: ${q.text}`);
      console.log(`  operation=${trace.preRoute.operation} tool=${trace.preRoute.tool}`);
      console.log(`  compressed=${trace.compressedChars} supplementFired=${trace.supplementFired} factsChars=${trace.finalFactsChars}`);
      console.log(`  droppedChunks=${trace.droppedEvidence.length} verdict=${trace.validatorVerdict}`);
      console.log(`  totalPrompt=${trace.promptBreakdown.totalChars} tokens=${trace.promptBreakdown.estimatedTokens}`);
      console.log();
    } catch (err) {
      console.error(`${q.id} FAILED:`, err.message);
      traces.push({ id: q.id, question: q.text, error: err.message, stack: err.stack });
    }
  }

  const outPath = path.join(__dirname, '..', 'data', 'trace-rag-loss.json');
  fs.writeFileSync(outPath, JSON.stringify(traces, null, 2));
  console.log(`Trace written to ${outPath}`);

  let totalRag = 0;
  let totalDropped = 0;
  let supplementCount = 0;
  let contractChars = 0;
  let planChars = 0;
  let relChars = 0;
  let factsChars = 0;
  let baseChars = 0;
  let totalTokens = 0;

  for (const t of traces) {
    if (t.error) continue;
    totalRag += t.bm25Results.length;
    totalDropped += t.droppedEvidence.length;
    if (t.supplementFired) supplementCount++;
    contractChars += t.promptBreakdown.responseContract;
    planChars += t.promptBreakdown.answerGuide;
    relChars += t.promptBreakdown.relationships;
    factsChars += t.promptBreakdown.facts;
    baseChars += t.promptBreakdown.baseInstructions;
    totalTokens += t.promptBreakdown.estimatedTokens;
  }

  const count = traces.filter(t => !t.error).length;
  console.log('=== Summary ===');
  console.log(`questions: ${count}`);
  console.log(`avg retrieved chunks: ${(totalRag / count).toFixed(1)}`);
  console.log(`avg dropped chunks: ${(totalDropped / count).toFixed(1)}`);
  console.log(`supplement-gate fired: ${supplementCount}/${count}`);
  console.log(`avg base instruction chars: ${Math.round(baseChars / count)}`);
  console.log(`avg contract chars: ${Math.round(contractChars / count)}`);
  console.log(`avg plan chars: ${Math.round(planChars / count)}`);
  console.log(`avg relationship chars: ${Math.round(relChars / count)}`);
  console.log(`avg facts chars: ${Math.round(factsChars / count)}`);
  console.log(`avg total tokens: ${Math.round(totalTokens / count)}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
