'use strict';

// Regression set runner — runs a specific subset of the 68-question suite
// through the LITE agent with corrected benchmark semantics (real history,
// c7 setup turn, both user+assistant turns preserved).
//
// Uses FIXED deterministic replies for prior turns so both engines see
// identical conversation context (apples-to-apples comparison).
//
// Usage: node scripts/run-regression-set.js <output-path> [runs-per-turn]
// Default runs-per-turn: 3

const fs = require('fs');
const path = require('path');
const { runLiteAgent } = require('../lib/lite-agent');
const { CONVERSATIONS, CONVERSATION_SETUPS } = require('../data/conversation-parity-suite');
const knowledge = require('../data/recruiter-knowledge.json');
const { BM25Index } = require('../lib/bm25');
const { buildRagChunks } = require('../lib/rag-chunks');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const sessionState = require('../lib/session-state');

const MODEL = process.env.OLLAMA_AGENT_MODEL || 'qwen2.5:1.5b';

// Regression set: all latest failures + representative GENERIC/FALLBACK
const REGRESSION_IDS = [
  // Safety errors from v3 audit
  'q2', 'q19', 'q22', 'q31', 'q35', 'q38', 'q42', 'q51', 'q58', 'q61', 'q62', 'q66', 'q67',
  // Representative GENERIC/FALLBACK
  'q20', 'q25', 'q40', 'q43', 'q47', 'q65'
];

// Fixed deterministic replies for prior turns.
// These are simple, entity-mentioning, neutral replies that give the
// conversation resolver enough context without favoring either engine.
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
  // c7 intermediate turns — must mention entities for coreference resolution
  'What did he use there?': 'He used AWS Lambda, DynamoDB, S3, and AWS Amplify in the AWS Serverless Metadata Extraction Workflow.',
  'Was that AWS?': 'Yes, the AWS Serverless Metadata Extraction Workflow is an AWS internship project.',
  'What about the other project?': 'The Interactive Pokedex is a static Gen 1 Pokedex UI with all 151 entries using JavaScript, HTML, and CSS.',
  'Did he do that professionally?': 'No, the Interactive Pokedex was a personal project, not professional production work.',
};

function getFixedReply(question) {
  // Try exact match first
  if (FIXED_REPLIES[question]) return FIXED_REPLIES[question];
  // Fallback: return a generic reply mentioning the question
  return `I can help with that question about the candidate.`;
}

async function runRegressionSet(outputPath, runsPerTurn) {
  console.log('=== Regression Set Run ===');
  console.log(`Model: ${MODEL}`);
  console.log(`Questions: ${REGRESSION_IDS.length}`);
  console.log(`Runs per turn: ${runsPerTurn}`);
  console.log('');

  const chunks = buildRagChunks(knowledge);
  const bm25Index = new BM25Index(chunks);
  const allResults = [];

  for (const targetId of REGRESSION_IDS) {
    const item = CONVERSATIONS.find(c => (c.id || `q${CONVERSATIONS.indexOf(c)+1}`) === targetId);
    if (!item) {
      console.error(`  ${targetId}: NOT FOUND in suite`);
      continue;
    }
    const convId = item.conv || 'default';

    for (let run = 1; run <= runsPerTurn; run++) {
      // Fresh session per run
      const sessionId = `regress-${convId}-${targetId}-r${run}-${Date.now()}`;

      // Apply setup turns (e.g., c7 comparison setup)
      for (const setup of CONVERSATION_SETUPS[convId] || []) {
        sessionState.updateState(sessionId, setup.question, setup.response, knowledge);
      }

      // Replay prior turns with FIXED deterministic replies
      const convTurns = CONVERSATIONS.filter(c => c.conv === convId);
      const targetIndex = convTurns.indexOf(item);
      for (let j = 0; j < targetIndex; j++) {
        const prior = convTurns[j];
        const reply = getFixedReply(prior.question);
        sessionState.updateState(sessionId, prior.question, reply, knowledge);
      }

      // Now run the target question
      const state = sessionState.getState(sessionId);
      const history = state.recentTurns || state.history || [];

      const understood = understandQuery(item.question, history, chunks);
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

      const visibleAnswer = result.reply || '';
      const isFallback = !!result.fallback;

      const historySnapshot = ((state.recentTurns || state.history) || []).flatMap(t => {
        if (t.role && t.text) return [{ role: t.role, text: t.text }];
        return [
          t.user ? { role: 'user', text: t.user } : null,
          t.assistant ? { role: 'assistant', text: t.assistant } : null
        ].filter(Boolean);
      });

      allResults.push({
        id: targetId,
        run,
        cat: item.category || item.cat,
        conv: item.conv,
        question: item.question,
        history: historySnapshot,
        rewritten: understood.rewritten,
        visibleAnswer,
        fallback: isFallback,
        outcome: result.outcome || (isFallback ? 'fallback' : 'accepted'),
        latencyMs: result.latencyMs,
        validation: result.validation || null,
        events: result.events || []
      });

      const tag = isFallback ? 'FB' : 'GEN';
      console.log(`  ${targetId} r${run}/${runsPerTurn} [${tag}] (${result.latencyMs}ms) ${visibleAnswer.slice(0, 80)}`);
    }
  }

  const output = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    questionsRun: REGRESSION_IDS.length,
    runsPerTurn,
    totalRuns: allResults.length,
    results: allResults
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${allResults.length} results to ${outputPath}`);

  let gen = 0, fb = 0;
  for (const r of allResults) {
    if (r.fallback) fb++; else gen++;
  }
  console.log(`Generated: ${gen} | Fallback: ${fb}`);
}

const outputPath = process.argv[2] || 'data/regression-set-results.json';
const runsPerTurn = parseInt(process.argv[3] || '3', 10);
runRegressionSet(outputPath, runsPerTurn).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
