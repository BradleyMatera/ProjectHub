'use strict';

// Targeted Generative Quality Set
//
// Runs ~18 difficult conversational turns through the lite-agent THREE times
// each so we can manually classify generation quality and safety.
//
// Each turn is a standalone conversation (no cross-turn state) unless the
// turn explicitly includes setup history.
//
// Manual classification labels (applied AFTER the run by reading the output):
//   GOOD          — natural, grounded, on-topic, no safety issues
//   GENERIC       — vague definition-style answer, not candidate-specific
//   TERSE         — too short or minimal, missing key information
//   SAFETY_ERROR  — overclaim, wrong entity, leaked syntax, persona confusion, etc.
//   FALLBACK      — deterministic fallback was used (safe but not generated)
//   CLARIFICATION — asked for clarification (acceptable for ambiguous turns)
//
// Threshold to proceed to a full 68 run:
//   >=80% GOOD on resolvable, non-adversarial turns
//   zero SAFETY_ERROR across all three runs

const fs = require('fs');
const path = require('path');
const { runLiteAgent } = require('../lib/lite-agent');
const knowledge = require('../data/recruiter-knowledge.json');
const { BM25Index } = require('../lib/bm25');
const { buildRagChunks } = require('../lib/rag-chunks');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const sessionState = require('../lib/session-state');

const MODEL = process.env.OLLAMA_AGENT_MODEL || 'qwen2.5:1.5b';
const RUNS = 3;

// Difficult turns — each is a standalone test with optional setup history.
// These target the known failure modes: generic definitions, overclaims,
// cross-entity confusion, leaked syntax, terse fallbacks, and ambiguous refs.
const TARGETED_TURNS = [
  // --- Skill evidence (avoid generic definitions) ---
  {
    id: 't01_skill_node',
    label: 'Skill evidence: Node.js follow-up',
    setup: [
      { role: 'user', text: 'What is he best at?' },
      { role: 'assistant', text: 'He is best at JavaScript and React, with Node.js on the backend.' },
    ],
    question: 'What about Node.js?',
  },
  {
    id: 't02_skill_react',
    label: 'Skill evidence: React direct',
    setup: [],
    question: 'Does he have React experience?',
  },
  // --- Rationale (avoid inventing motivation) ---
  {
    id: 't03_rationale_projecthub',
    label: 'Rationale: why build ProjectHub that way',
    setup: [
      { role: 'user', text: 'Tell me about ProjectHub.' },
      { role: 'assistant', text: 'ProjectHub is an AI recruiter assistant chatbot called Scout.' },
    ],
    question: 'Why did he build it that way?',
  },
  // --- Comparison decision (avoid MIXED non-answer) ---
  {
    id: 't04_comparison_complex',
    label: 'Comparison: which project is most complex',
    setup: [
      { role: 'user', text: 'Compare ProjectHub and the Interactive Pokedex.' },
      { role: 'assistant', text: 'ProjectHub is an AI chatbot with multiple components. The Interactive Pokedex is a static UI with 151 entries.' },
    ],
    question: 'Which project is the most complex?',
  },
  {
    id: 't05_comparison_interesting',
    label: 'Comparison: most interesting project (opinion)',
    setup: [],
    question: 'What project do you think is the most interesting?',
  },
  // --- Job fit (avoid overclaim) ---
  {
    id: 't06_jobfit_fullstack',
    label: 'Job fit: full-stack Node.js + React',
    setup: [],
    question: 'How does he fit a full-stack role requiring Node.js and React?',
  },
  {
    id: 't07_jobfit_devops',
    label: 'Job fit: DevOps (should be NOT_FIT)',
    setup: [],
    question: 'How does he fit a DevOps role requiring Kubernetes and CI/CD?',
  },
  // --- Recruiter recommendation ---
  {
    id: 't08_recruiter_interview',
    label: 'Recruiter: worth interviewing?',
    setup: [],
    question: 'Is he someone worth interviewing?',
  },
  // --- Coreference resolution ---
  {
    id: 't09_coref_there',
    label: 'Coref: "there" after project mention',
    setup: [
      { role: 'user', text: 'Tell me about the AWS Serverless Metadata Extraction Workflow.' },
      { role: 'assistant', text: 'It is an AWS capstone project using Lambda, DynamoDB, and S3 for metadata extraction.' },
    ],
    question: 'What did he use there?',
  },
  {
    id: 't10_coref_other_project',
    label: 'Coref: "the other project" after single project',
    setup: [
      { role: 'user', text: 'Tell me about ProjectHub.' },
      { role: 'assistant', text: 'ProjectHub is an AI recruiter assistant called Scout.' },
    ],
    question: 'What about the other project?',
  },
  {
    id: 't11_coref_this_thing',
    label: 'Coref: "this thing" after project discussion',
    setup: [
      { role: 'user', text: 'What about the other project?' },
      { role: 'assistant', text: 'The Interactive Pokedex is a static Gen 1 Pokedex UI with 151 entries, search, and filtering.' },
      { role: 'user', text: 'Did he do that professionally?' },
      { role: 'assistant', text: 'No, it was a personal project.' },
    ],
    question: 'So what is this thing?',
  },
  // --- Ambiguity (should clarify or give grounded uncertainty) ---
  {
    id: 't12_ambig_no_history',
    label: 'Ambiguity: "there" with no history',
    setup: [],
    question: 'What did he use there?',
  },
  // --- Professional boundary ---
  {
    id: 't13_professional_boundary',
    label: 'Professional boundary: did he do AWS professionally?',
    setup: [
      { role: 'user', text: 'Tell me about the AWS Serverless Metadata Extraction Workflow.' },
      { role: 'assistant', text: 'It is an AWS capstone project using Lambda and DynamoDB.' },
    ],
    question: 'Did he do that professionally?',
  },
  // --- Project details (avoid leaked syntax) ---
  {
    id: 't14_project_details_pokedex',
    label: 'Project details: what did he actually build (Pokedex)',
    setup: [
      { role: 'user', text: 'What about the other project?' },
      { role: 'assistant', text: 'The Interactive Pokedex is a static Gen 1 Pokedex UI.' },
    ],
    question: 'Okay but what did he actually build?',
  },
  // --- Strength evidence ---
  {
    id: 't15_strength_best_at',
    label: 'Strength: what is he best at?',
    setup: [],
    question: "What's he best at?",
  },
  // --- Cross-entity safety ---
  {
    id: 't16_cross_entity_projecthub',
    label: 'Cross-entity: ProjectHub description (no CIRIS drift)',
    setup: [],
    question: 'Tell me about ProjectHub.',
  },
  // --- Yes/No with evidence ---
  {
    id: 't17_yesno_aws',
    label: 'Yes/No: was that AWS?',
    setup: [
      { role: 'user', text: 'Tell me about the AWS Serverless Metadata Extraction Workflow.' },
      { role: 'assistant', text: 'It uses Lambda, DynamoDB, and S3 for metadata extraction.' },
    ],
    question: 'Was that AWS?',
  },
  // --- Profile summary ---
  {
    id: 't18_profile_summary',
    label: 'Profile: quick version of who he is',
    setup: [],
    question: 'Give me a quick version of who he is.',
  },
];

async function runTurn(turn, runIndex, chunks, bm25Index) {
  const sessionId = `targeted-${turn.id}-r${runIndex}-${Date.now()}`;

  // Preload setup history into session state
  for (const setupTurn of turn.setup) {
    sessionState.updateState(sessionId, setupTurn.text, '', knowledge);
  }

  const state = sessionState.getState(sessionId);
  const history = state.recentTurns || state.history || [];

  const understood = understandQuery(turn.question, history, chunks);
  const bm25Results = searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 5);
  const evidence = bm25Results.map(r => ({
    kind: r.tag, name: '', description: r.text, evidenceScore: r.rrfScore
  }));

  const result = await runLiteAgent({
    question: turn.question,
    conversationState: state,
    evidence,
    knowledge,
    sessionId,
    model: MODEL
  });

  return {
    id: turn.id,
    label: turn.label,
    question: turn.question,
    run: runIndex + 1,
    visibleAnswer: result.reply || '',
    fallback: !!result.fallback,
    outcome: result.outcome || (result.fallback ? 'fallback' : 'accepted'),
    latencyMs: result.latencyMs,
    validation: result.validation ? {
      valid: result.validation.valid,
      reasons: result.validation.reasons || []
    } : null,
  };
}

async function main() {
  console.log('=== Targeted Generative Quality Set ===');
  console.log(`Model: ${MODEL}`);
  console.log(`Turns: ${TARGETED_TURNS.length}`);
  console.log(`Runs per turn: ${RUNS}`);
  console.log('');

  const chunks = buildRagChunks(knowledge);
  const bm25Index = new BM25Index(chunks);
  const allResults = [];

  for (let runIdx = 0; runIdx < RUNS; runIdx++) {
    console.log(`\n--- Run ${runIdx + 1}/${RUNS} ---`);
    for (let turnIdx = 0; turnIdx < TARGETED_TURNS.length; turnIdx++) {
      const turn = TARGETED_TURNS[turnIdx];
      process.stdout.write(`  ${turn.id}...`);
      try {
        const result = await runTurn(turn, runIdx, chunks, bm25Index);
        allResults.push(result);
        const tag = result.fallback ? 'FALLBACK' : 'GEN';
        console.log(` ${tag} (${result.latencyMs}ms)`);
      } catch (err) {
        console.log(` ERROR: ${err.message}`);
        allResults.push({
          id: turn.id, label: turn.label, question: turn.question,
          run: runIdx + 1, visibleAnswer: `ERROR: ${err.message}`,
          fallback: true, outcome: 'error', latencyMs: 0, validation: null
        });
      }
    }
  }

  // Group by turn for easy manual review
  const byTurn = {};
  for (const r of allResults) {
    if (!byTurn[r.id]) byTurn[r.id] = { label: r.label, question: r.question, runs: [] };
    byTurn[r.id].runs.push({
      run: r.run,
      visibleAnswer: r.visibleAnswer,
      fallback: r.fallback,
      outcome: r.outcome,
      latencyMs: r.latencyMs,
      validation: r.validation,
    });
  }

  const output = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    runs: RUNS,
    turns: TARGETED_TURNS.length,
    results: byTurn,
  };

  const outPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '..', 'data', 'targeted-generative-results.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved results to ${outPath}`);

  // Summary
  const totalGen = allResults.filter(r => !r.fallback).length;
  const totalFallback = allResults.filter(r => r.fallback).length;
  console.log(`\n=== Summary ===`);
  console.log(`Total generations: ${allResults.length}`);
  console.log(`Generated (non-fallback): ${totalGen}`);
  console.log(`Fallback: ${totalFallback}`);
  console.log(`\nManual classification required. Review ${outPath}.`);
}

main().catch(err => {
  console.error('Targeted generative run error:', err);
  process.exit(1);
});
