'use strict';

// HTTP-based evaluation runner — sends all test traffic through the production
// request path: test runner → HTTP → api:3000/api/chat → RAG/harness → inference:11434
//
// Supports two modes:
//   --regression   : runs the 19-question regression set (3 runs each = 57 outputs)
//   --targeted     : runs the 18-turn targeted generative set (3 runs each = 54 outputs)
//   --full68       : runs the actual corrected 68-question benchmark
//
// Usage:
//   node scripts/run-http-eval.js --regression  [output-path] [runs-per-turn]
//   node scripts/run-http-eval.js --targeted    [output-path] [runs-per-turn]
//   node scripts/run-http-eval.js --full68      [output-path] [runs-per-turn]
//
// Environment:
//   API_URL  — base URL of the API (default: http://localhost:3000)

const fs = require('fs');
const path = require('path');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const ENDPOINT = `${API_URL}/api/chat`;

// Shared data
const { CONVERSATIONS, CONVERSATION_SETUPS } = require('../data/conversation-parity-suite');
const knowledge = require('../data/recruiter-knowledge.json');

// Regression IDs (same as run-regression-set.js)
const REGRESSION_IDS = [
  'q2', 'q19', 'q22', 'q31', 'q35', 'q38', 'q42', 'q51', 'q58', 'q61', 'q62', 'q66', 'q67',
  'q20', 'q25', 'q40', 'q43', 'q47', 'q65'
];

// Fixed deterministic replies for prior turns (same as run-regression-set.js)
const FIXED_REPLIES = {
  'Tell me about ProjectHub.': 'ProjectHub is an embeddable AI recruiter assistant named Scout. It uses JavaScript, Node.js, and Express.',
  'Okay now explain it technically.': 'ProjectHub uses JavaScript, Node.js, Express, Ollama with Qwen 2.5, and BM25 retrieval.',
  'Explain ProjectHub like I\'m not technical.': 'ProjectHub is a chat widget that answers recruiter questions about Bradley.',
  'Does he know React?': 'Yes, he has experience with React.',
  'How well? Like, can he actually build something with it?': 'He has built projects using React.',
  'What about Node.js?': 'He has experience with Node.js from ProjectHub and Voice Ops Platform.',
  'What\'s he best at?': 'He is best at JavaScript, HTML, and CSS frontend development.',
  'How does he fit a junior frontend developer role requiring React and TypeScript?': 'He has experience with React and TypeScript from his projects.',
  'How does he fit a cloud support role requiring AWS and troubleshooting?': 'He has AWS experience from his internship and certifications.',
  'Compare ProjectHub and CIRIS Ethical AI.': 'ProjectHub is an AI recruiter assistant. CIRIS Ethical AI is a freelance ethical AI project.',
  'Compare ProjectHub and the Interactive Pokedex.': 'ProjectHub is an AI recruiter assistant using Node.js. Interactive Pokedex is a static frontend using JavaScript, HTML, and CSS.',
  'Okay but what did he actually build?': 'He built the Interactive Pokedex, a static Gen 1 Pokedex UI with all 151 entries.',
  'What\'s the cool part?': 'The cool part is the client-side search and filtering for all 151 Pokemon entries.',
  'Why should I care about that?': 'It demonstrates his frontend JavaScript skills.',
  'Is that actually impressive?': 'It shows entry-level frontend skills.',
  'What project do you think is the most interesting?': 'ProjectHub seems the most interesting because it uses AI and retrieval.',
  'If you had to bet on him succeeding in one type of role, what would it be?': 'Frontend development seems like the best fit for his skills.',
  'What did he use there?': 'He used AWS Lambda, DynamoDB, S3, and AWS Amplify in the AWS Serverless Metadata Extraction Workflow.',
  'Was that AWS?': 'Yes, the AWS Serverless Metadata Extraction Workflow is an AWS internship project.',
  'What about the other project?': 'The Interactive Pokedex is a static Gen 1 Pokedex UI with all 151 entries using JavaScript, HTML, and CSS.',
  'Did he do that professionally?': 'No, the Interactive Pokedex was a personal project, not professional production work.',
};

function getFixedReply(question) {
  if (FIXED_REPLIES[question]) return FIXED_REPLIES[question];
  return `I can help with that question about the candidate.`;
}

// Targeted turns (same as run-targeted-generative.js)
const TARGETED_TURNS = [
  { id: 't01_skill_node', label: 'Skill evidence: Node.js follow-up',
    setup: [{ role: 'user', text: 'What is he best at?' }, { role: 'assistant', text: 'He is best at JavaScript and React, with Node.js on the backend.' }],
    question: 'What about Node.js?' },
  { id: 't02_skill_react', label: 'Skill evidence: React direct', setup: [], question: 'Does he have React experience?' },
  { id: 't03_rationale_projecthub', label: 'Rationale: why build ProjectHub that way',
    setup: [{ role: 'user', text: 'Tell me about ProjectHub.' }, { role: 'assistant', text: 'ProjectHub is an AI recruiter assistant chatbot called Scout.' }],
    question: 'Why did he build it that way?' },
  { id: 't04_comparison_complex', label: 'Comparison: which project is most complex',
    setup: [{ role: 'user', text: 'Compare ProjectHub and the Interactive Pokedex.' }, { role: 'assistant', text: 'ProjectHub is an AI chatbot with multiple components. The Interactive Pokedex is a static UI with 151 entries.' }],
    question: 'Which project is the most complex?' },
  { id: 't05_comparison_interesting', label: 'Comparison: most interesting project (opinion)', setup: [], question: 'What project do you think is the most interesting?' },
  { id: 't06_jobfit_fullstack', label: 'Job fit: full-stack Node.js + React', setup: [], question: 'How does he fit a full-stack role requiring Node.js and React?' },
  { id: 't07_jobfit_devops', label: 'Job fit: DevOps (should be NOT_FIT)', setup: [], question: 'How does he fit a DevOps role requiring Kubernetes and CI/CD?' },
  { id: 't08_recruiter_interview', label: 'Recruiter: worth interviewing?', setup: [], question: 'Is he someone worth interviewing?' },
  { id: 't09_coref_there', label: 'Coref: "there" after project mention',
    setup: [{ role: 'user', text: 'Tell me about the AWS Serverless Metadata Extraction Workflow.' }, { role: 'assistant', text: 'It is an AWS capstone project using Lambda, DynamoDB, and S3 for metadata extraction.' }],
    question: 'What did he use there?' },
  { id: 't10_coref_other_project', label: 'Coref: "the other project" after single project',
    setup: [{ role: 'user', text: 'Tell me about ProjectHub.' }, { role: 'assistant', text: 'ProjectHub is an AI recruiter assistant called Scout.' }],
    question: 'What about the other project?' },
  { id: 't11_coref_this_thing', label: 'Coref: "this thing" after project discussion',
    setup: [
      { role: 'user', text: 'What about the other project?' }, { role: 'assistant', text: 'The Interactive Pokedex is a static Gen 1 Pokedex UI with 151 entries, search, and filtering.' },
      { role: 'user', text: 'Did he do that professionally?' }, { role: 'assistant', text: 'No, it was a personal project.' },
    ],
    question: 'So what is this thing?' },
  { id: 't12_ambig_no_history', label: 'Ambiguity: "there" with no history', setup: [], question: 'What did he use there?' },
  { id: 't13_professional_boundary', label: 'Professional boundary: did he do AWS professionally?',
    setup: [{ role: 'user', text: 'Tell me about the AWS Serverless Metadata Extraction Workflow.' }, { role: 'assistant', text: 'It is an AWS capstone project using Lambda and DynamoDB.' }],
    question: 'Did he do that professionally?' },
  { id: 't14_project_details_pokedex', label: 'Project details: what did he actually build (Pokedex)',
    setup: [{ role: 'user', text: 'What about the other project?' }, { role: 'assistant', text: 'The Interactive Pokedex is a static Gen 1 Pokedex UI.' }],
    question: 'Okay but what did he actually build?' },
  { id: 't15_strength_best_at', label: 'Strength: what is he best at?', setup: [], question: "What's he best at?" },
  { id: 't16_cross_entity_projecthub', label: 'Cross-entity: ProjectHub description (no CIRIS drift)', setup: [], question: 'Tell me about ProjectHub.' },
  { id: 't17_yesno_aws', label: 'Yes/No: was that AWS?',
    setup: [{ role: 'user', text: 'Tell me about the AWS Serverless Metadata Extraction Workflow.' }, { role: 'assistant', text: 'It uses Lambda, DynamoDB, and S3 for metadata extraction.' }],
    question: 'Was that AWS?' },
  { id: 't18_profile_summary', label: 'Profile: quick version of who he is', setup: [], question: 'Give me a quick version of who he is.' },
];

// Send a chat request through HTTP
async function sendChatRequest(message, sessionId, history) {
  const body = JSON.stringify({ message, sessionId, history });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal
    });
    const data = await resp.json();
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// Classify SOURCE from the API response
function classifySource(apiResponse) {
  if (apiResponse.error === 'INFERENCE_UNAVAILABLE') return 'ERROR';
  const meta = apiResponse.agentMeta || {};
  const outcome = meta.outcome || apiResponse.outcome;
  if (outcome === 'inference_unavailable') return 'ERROR';
  if (outcome === 'recovery') return 'RECOVERY_GENERATION';
  if (outcome === 'repaired') return 'REPAIR_GENERATION';
  if (outcome === 'accepted' && !apiResponse.fallback) return 'FIRST_GENERATION';
  if (apiResponse.fallback && !outcome) return 'ERROR';
  if (apiResponse.fallback && outcome === 'recovery') return 'RECOVERY_GENERATION';
  // If generated is true and not fallback, it's first generation
  if (!apiResponse.fallback && apiResponse.reply) return 'FIRST_GENERATION';
  return 'ERROR';
}

// Extract per-attempt latency breakdown from agent events
function extractAttemptLatencies(events) {
  const attempts = [];
  // Primary generation
  const genOk = events.find(e => e.type === 'lite_generate_ok');
  const genError = events.find(e => e.type === 'lite_generate_error');
  if (genOk) attempts.push({ attempt: 'primary', latencyMs: genOk.latencyMs || 0, result: 'ok' });
  else if (genError) attempts.push({ attempt: 'primary', latencyMs: genError.latencyMs || 0, result: genError.error || 'error' });

  // Recovery attempts
  for (const e of events) {
    if (e.type === 'lite_recovery_ok') {
      attempts.push({ attempt: `recovery_${e.attempt || '?'}`, latencyMs: e.latencyMs || 0, result: 'ok' });
    } else if (e.type === 'lite_recovery_validation_reject') {
      attempts.push({ attempt: `recovery_${e.attempt || '?'}`, latencyMs: e.latencyMs || 0, result: 'validation_reject', reasons: e.reasons });
    } else if (e.type === 'lite_recovery_error') {
      attempts.push({ attempt: `recovery_${e.attempt || '?'}`, latencyMs: 0, result: e.error || 'error' });
    }
  }

  // Repair attempt
  const repairOk = events.find(e => e.type === 'lite_repair_result' && e.verdict === 'valid');
  const repairFail = events.find(e => e.type === 'lite_repair_result' && e.verdict !== 'valid');
  if (repairOk) attempts.push({ attempt: 'repair', latencyMs: repairOk.latencyMs || 0, result: 'ok' });
  else if (repairFail) attempts.push({ attempt: 'repair', latencyMs: repairFail.latencyMs || 0, result: repairFail.verdict || 'fail' });

  return attempts;
}

// Run a single regression turn through HTTP
async function runRegressionTurn(item, run, runsPerTurn) {
  const convId = item.conv || 'default';
  const sessionId = `regress-http-${convId}-${item.id}-r${run}-${Date.now()}`;

  // Build history from setup turns + prior conversation turns with fixed replies
  const history = [];

  // Apply setup turns
  for (const setup of CONVERSATION_SETUPS[convId] || []) {
    history.push({ role: 'user', text: setup.question });
    history.push({ role: 'assistant', text: setup.response });
  }

  // Replay prior turns with FIXED deterministic replies
  const convTurns = CONVERSATIONS.filter(c => c.conv === convId);
  const targetIndex = convTurns.indexOf(item);
  for (let j = 0; j < targetIndex; j++) {
    const prior = convTurns[j];
    history.push({ role: 'user', text: prior.question });
    history.push({ role: 'assistant', text: getFixedReply(prior.question) });
  }

  // Send the target question through HTTP
  const apiResp = await sendChatRequest(item.question, sessionId, history);

  const source = classifySource(apiResp);
  const reply = apiResp.reply || '';
  const latencyMs = apiResp.latencyMs || 0;
  const meta = apiResp.agentMeta || {};
  const generationAttempts = meta.generationAttempts || (source === 'FIRST_GENERATION' ? 1 : 0);
  const attemptLatencies = extractAttemptLatencies(apiResp.agentEvents || []);

  return {
    id: item.id || `q${CONVERSATIONS.indexOf(item) + 1}`,
    run,
    cat: item.category || item.cat,
    conv: item.conv,
    question: item.question,
    history,
    visibleAnswer: reply,
    source,
    outcome: meta.outcome || (apiResp.fallback ? 'fallback' : 'accepted'),
    latencyMs,
    generationAttempts,
    attemptLatencies,
    validationFailures: (apiResp.agentEvents || []).filter(e => e.type.includes('reject') || e.type.includes('error')).map(e => e.type),
    inferenceUnavailable: apiResp.error === 'INFERENCE_UNAVAILABLE',
    events: apiResp.agentEvents || []
  };
}

// Run a single targeted turn through HTTP
async function runTargetedTurn(turn, run) {
  const sessionId = `targeted-http-${turn.id}-r${run}-${Date.now()}`;

  // Build history from setup
  const history = [];
  for (const setupTurn of turn.setup) {
    if (setupTurn.role === 'user') history.push({ role: 'user', text: setupTurn.text });
    if (setupTurn.role === 'assistant') history.push({ role: 'assistant', text: setupTurn.text });
  }

  const apiResp = await sendChatRequest(turn.question, sessionId, history);

  const source = classifySource(apiResp);
  const reply = apiResp.reply || '';
  const latencyMs = apiResp.latencyMs || 0;
  const meta = apiResp.agentMeta || {};
  const generationAttempts = meta.generationAttempts || (source === 'FIRST_GENERATION' ? 1 : 0);
  const attemptLatencies = extractAttemptLatencies(apiResp.agentEvents || []);

  return {
    id: turn.id,
    label: turn.label,
    question: turn.question,
    run,
    visibleAnswer: reply,
    source,
    outcome: meta.outcome || (apiResp.fallback ? 'fallback' : 'accepted'),
    latencyMs,
    generationAttempts,
    attemptLatencies,
    validationFailures: (apiResp.agentEvents || []).filter(e => e.type.includes('reject') || e.type.includes('error')).map(e => e.type),
    inferenceUnavailable: apiResp.error === 'INFERENCE_UNAVAILABLE',
  };
}

// Compute latency statistics
function latencyStats(latencies) {
  if (latencies.length === 0) return { p50: 0, p95: 0, max: 0, over15s: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const max = sorted[sorted.length - 1];
  const over15s = latencies.filter(l => l > 15000).length;
  return { p50, p95, max, over15s };
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const mode = args.find(a => a.startsWith('--')) || '--regression';
  const outputPath = args.find(a => !a.startsWith('--')) || `data/${mode.slice(2)}-http-results.json`;
  const runsPerTurn = parseInt(args.find(a => !a.startsWith('--') && a !== outputPath) || '3', 10);

  console.log(`=== HTTP Eval: ${mode} ===`);
  console.log(`API: ${ENDPOINT}`);
  console.log(`Runs per turn: ${runsPerTurn}`);
  console.log('');

  // Health check
  try {
    const health = await fetch(`${API_URL}/health`);
    const hd = await health.json();
    console.log(`Health: ${hd.ok ? 'OK' : 'FAIL'} | model: ${hd.genModel || 'unknown'} | localOnly: ${hd.localOnly}`);
  } catch (e) {
    console.error(`API not reachable at ${API_URL}: ${e.message}`);
    process.exit(1);
  }

  const allResults = [];

  if (mode === '--regression' || mode === '--full68') {
    const ids = mode === '--regression' ? REGRESSION_IDS : CONVERSATIONS.map((c, i) => c.id || `q${i + 1}`);

    for (const targetId of ids) {
      const item = CONVERSATIONS.find(c => (c.id || `q${CONVERSATIONS.indexOf(c) + 1}`) === targetId);
      if (!item) {
        console.error(`  ${targetId}: NOT FOUND`);
        continue;
      }

      for (let run = 1; run <= runsPerTurn; run++) {
        process.stdout.write(`  ${targetId} r${run}/${runsPerTurn}...`);
        try {
          const result = await runRegressionTurn(item, run, runsPerTurn);
          allResults.push(result);
          console.log(` [${result.source}] (${result.latencyMs}ms) ${result.visibleAnswer.slice(0, 80)}`);
        } catch (err) {
          console.log(` ERROR: ${err.message}`);
          allResults.push({
            id: targetId, run, question: item.question, visibleAnswer: `ERROR: ${err.message}`,
            source: 'ERROR', outcome: 'error', latencyMs: 0, generationAttempts: 0,
            validationFailures: [], inferenceUnavailable: false
          });
        }
      }
    }
  } else if (mode === '--targeted') {
    for (let runIdx = 0; runIdx < runsPerTurn; runIdx++) {
      console.log(`\n--- Run ${runIdx + 1}/${runsPerTurn} ---`);
      for (const turn of TARGETED_TURNS) {
        process.stdout.write(`  ${turn.id}...`);
        try {
          const result = await runTargetedTurn(turn, runIdx + 1);
          allResults.push(result);
          console.log(` [${result.source}] (${result.latencyMs}ms) ${result.visibleAnswer.slice(0, 80)}`);
        } catch (err) {
          console.log(` ERROR: ${err.message}`);
          allResults.push({
            id: turn.id, label: turn.label, question: turn.question, run: runIdx + 1,
            visibleAnswer: `ERROR: ${err.message}`, source: 'ERROR', outcome: 'error',
            latencyMs: 0, generationAttempts: 0, validationFailures: [], inferenceUnavailable: false
          });
        }
      }
    }
  }

  // Compute summary
  const sourceCounts = {};
  for (const r of allResults) {
    sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1;
  }

  const latencies = allResults.map(r => r.latencyMs).filter(l => l > 0);
  const stats = latencyStats(latencies);

  // Per-source latency breakdown
  const sourceLatencies = {};
  for (const src of ['FIRST_GENERATION', 'REPAIR_GENERATION', 'RECOVERY_GENERATION', 'ERROR']) {
    const lats = allResults.filter(r => r.source === src).map(r => r.latencyMs).filter(l => l > 0);
    sourceLatencies[src] = latencyStats(lats);
  }

  const output = {
    timestamp: new Date().toISOString(),
    mode,
    api: ENDPOINT,
    runsPerTurn,
    totalOutputs: allResults.length,
    sourceCounts,
    latency: stats,
    sourceLatencies,
    avgGenerationAttempts: (allResults.reduce((s, r) => s + (r.generationAttempts || 0), 0) / allResults.length).toFixed(2),
    results: mode === '--targeted' ? groupByTurn(allResults) : allResults
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n=== Summary ===`);
  console.log(`Total outputs: ${allResults.length}`);
  console.log(`Source counts:`, sourceCounts);
  console.log(`Latency p50: ${stats.p50}ms | p95: ${stats.p95}ms | max: ${stats.max}ms | >15s: ${stats.over15s}`);
  console.log(`Avg generation attempts: ${output.avgGenerationAttempts}`);
  console.log(`Saved to ${outputPath}`);
}

function groupByTurn(results) {
  const byTurn = {};
  for (const r of results) {
    if (!byTurn[r.id]) byTurn[r.id] = { label: r.label, question: r.question, runs: [] };
    byTurn[r.id].runs.push({
      run: r.run,
      visibleAnswer: r.visibleAnswer,
      source: r.source,
      outcome: r.outcome,
      latencyMs: r.latencyMs,
      generationAttempts: r.generationAttempts,
      attemptLatencies: r.attemptLatencies,
      validationFailures: r.validationFailures,
      inferenceUnavailable: r.inferenceUnavailable,
    });
  }
  return byTurn;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
