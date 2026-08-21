#!/usr/bin/env node
'use strict';

// Trace the new RAG-first agent to confirm retrieved evidence is primary and the
// prompt is substantially simpler than the old lite path.

process.env.SCOUT_RAG_ENABLE_REPAIR = 'false';

const fs = require('fs');
const path = require('path');
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'recruiter-knowledge.json'), 'utf8'));
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const sessionState = require('../lib/session-state');
const { classifyResponsePolicy } = require('../lib/response-policy');
const router = require('../lib/local-model-router');
const { runRagPrimaryAgent } = require('../lib/rag-agent');

const chunks = buildRagChunks(knowledge);
const bm25Index = new BM25Index(chunks);

router.generate = async function traceGenerate(model, messages, options) {
  const system = messages.find(m => m.role === 'system')?.content || '';
  const user = messages.find(m => m.role === 'user')?.content || '';
  if (!global.__generateCalls) global.__generateCalls = [];
  global.__generateCalls.push({ system, user });
  return {
    ok: true,
    text: JSON.stringify({ answer: '[STUB] Concise answer synthesized from the provided facts.' }),
    usage: { provider: 'stub', promptEvalCount: Math.ceil((system.length + user.length) / 4), evalCount: 12 },
    latencyMs: 0,
    startedAt: Date.now(),
    endedAt: Date.now()
  };
};

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

function countRagChunksInFacts(factsText, ragResults) {
  let kept = 0;
  for (const r of ragResults) {
    const snippet = r.text.slice(0, 60).replace(/\s+/g, ' ');
    if (factsText.includes(snippet)) kept++;
  }
  return kept;
}

function stripEnrichment(system) {
  const idx = system.indexOf('ENRICHMENT:');
  return idx !== -1 ? system.slice(0, idx).trim() : system;
}

function stripEvidence(system) {
  const idx = system.indexOf('EVIDENCE:');
  const end = system.indexOf('ENRICHMENT:');
  if (idx === -1) return system;
  return system.slice(0, idx) + (end !== -1 ? system.slice(end) : '');
}

async function trace(q, idx) {
  const sessionId = `rag-trace-${idx}-${Date.now()}`;
  sessionState.clearState(sessionId);
  const state = sessionState.getState(sessionId);

  const understood = understandQuery(q.text, [], chunks);
  const rewritten = understood.rewritten || q.text;
  const bm25Results = searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 8);
  const evidence = bm25Results.map(r => ({
    kind: r.tag,
    name: r.title || r.name || '',
    description: r.text,
    evidenceScore: r.rrfScore
  }));

  const policy = classifyResponsePolicy(q.text, [], knowledge);
  const policyContract = { mode: policy.mode, ...policy };
  delete policyContract.contract;

  global.__generateCalls = [];

  const result = await runRagPrimaryAgent({
    question: q.text,
    conversationState: state,
    evidence,
    knowledge,
    sessionId,
    policyContract
  });

  const primary = (global.__generateCalls || [])[0] || { system: '', user: '' };
  const system = primary.system;
  const factsMatch = system.match(/EVIDENCE:\n([\s\S]*?)(?:\n\nENRICHMENT:|\n\nQ: |$)/);
  const factsText = factsMatch ? factsMatch[1].trim() : '';
  const kept = countRagChunksInFacts(factsText, bm25Results);
  const guardrails = system.includes('GUARDRAILS:') ? system.match(/GUARDRAILS:\n([\s\S]*?)(?:\n\nEVIDENCE:|$)/)?.[1].trim().length || 0 : 0;
  const instructionChars = stripEvidence(system).length;
  const factsChars = factsText.length;

  return {
    id: q.id,
    question: q.text,
    rewritten,
    operation: result.operation,
    outcome: result.outcome,
    retrievedChunks: bm25Results.length,
    keptChunks: kept,
    factsChars,
    guardrailChars: guardrails,
    instructionChars,
    userPromptChars: primary.user.length,
    totalPromptChars: primary.system.length + primary.user.length,
    estimatedTokens: result.contextTokens,
    systemPrompt: system,
    userPrompt: primary.user,
    validation: result.validation,
    events: result.events
  };
}

async function main() {
  const traces = [];
  for (const q of QUESTIONS) {
    try {
      const t = await trace(q, QUESTIONS.indexOf(q));
      traces.push(t);
      console.log(`${t.id}: ${t.question}`);
      console.log(`  op=${t.operation} outcome=${t.outcome}`);
      console.log(`  retrieved=${t.retrievedChunks} kept=${t.keptChunks} factsChars=${t.factsChars}`);
      console.log(`  guardrailChars=${t.guardrailChars} instructionChars=${t.instructionChars} totalTokens=${t.estimatedTokens}`);
      console.log();
    } catch (err) {
      console.error(`${q.id} FAILED:`, err.message);
      traces.push({ id: q.id, error: err.message });
    }
  }

  fs.writeFileSync(path.join(__dirname, '..', 'data', 'trace-rag-primary.json'), JSON.stringify(traces, null, 2));

  const ok = traces.filter(t => !t.error);
  const avgKept = ok.reduce((s, t) => s + t.keptChunks, 0) / ok.length;
  const avgFacts = ok.reduce((s, t) => s + t.factsChars, 0) / ok.length;
  const avgGuard = ok.reduce((s, t) => s + t.guardrailChars, 0) / ok.length;
  const avgInstr = ok.reduce((s, t) => s + t.instructionChars, 0) / ok.length;
  const avgTokens = ok.reduce((s, t) => s + t.estimatedTokens, 0) / ok.length;
  console.log('=== RAG-first summary ===');
  console.log(`questions: ${ok.length}`);
  console.log(`avg kept chunks: ${avgKept.toFixed(1)}`);
  console.log(`avg facts chars: ${Math.round(avgFacts)}`);
  console.log(`avg guardrail chars: ${Math.round(avgGuard)}`);
  console.log(`avg instruction chars: ${Math.round(avgInstr)}`);
  console.log(`avg total tokens: ${Math.round(avgTokens)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
