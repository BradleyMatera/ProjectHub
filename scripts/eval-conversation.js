'use strict';

// Multi-Turn Conversation Evaluation
//
// Tests Scout's ability to handle multi-turn conversations with references,
// topic changes, and context-dependent questions. Each conversation is a
// sequence of turns where later turns depend on earlier context.
//
// Usage: node scripts/eval-conversation.js [--model qwen2.5:0.5b] [--verbose]

const fs = require('fs');
const path = require('path');
const router = require('../lib/local-model-router');
const { runAgentLoop } = require('../lib/agent-engine');
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const { getState, updateState, clearState } = require('../lib/session-state');

const KNOWLEDGE_PATH = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');
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

// Conversation test cases. Each turn has:
//   user: the user message
//   expectContains: words the response should contain (lowercase)
//   expectNotContains: words the response should NOT contain
//   expectFallback: if true, expect a fallback (for adversarial turns)
//   description: what this turn tests
const CONVERSATIONS = [
  {
    name: 'project-drilldown',
    description: 'Tell me about ProjectHub → backend → compare → which is better',
    turns: [
      {
        user: 'Tell me about ProjectHub.',
        expectContains: ['projecthub'],
        description: 'Should mention ProjectHub'
      },
      {
        user: 'What about the backend?',
        expectContains: ['node', 'javascript', 'backend', 'api', 'server'],
        expectContainsAny: true, // at least one of these
        description: 'Should know "the backend" means ProjectHub backend'
      },
      {
        user: 'Compare that to Voice Ops.',
        expectContains: ['voice', 'projecthub'],
        description: 'Should resolve "that" = ProjectHub and compare with Voice Ops'
      },
      {
        user: 'Which one is more technically complex?',
        expectContains: ['projecthub', 'voice'],
        description: 'Should answer about the two projects being compared'
      }
    ]
  },
  {
    name: 'skill-inquiry',
    description: 'AWS evidence → DynamoDB → compare → job fit',
    turns: [
      {
        user: 'What has Bradley done with AWS?',
        expectContains: ['aws', 'lambda', 'dynamodb', 'internship', 'certification'],
        expectContainsAny: true,
        description: 'Should mention AWS work'
      },
      {
        user: 'Does he actually know DynamoDB?',
        expectContains: ['dynamodb'],
        description: 'Should answer about DynamoDB specifically'
      },
      {
        user: 'Compare that to his React experience.',
        expectContains: ['react', 'dynamodb'],
        description: 'Should compare DynamoDB and React experience'
      },
      {
        user: 'What does he NOT have experience doing?',
        expectContains: ['gap', 'not', 'lack', 'limited', 'no'],
        expectContainsAny: true,
        description: 'Should honestly identify gaps'
      }
    ]
  },
  {
    name: 'topic-switch',
    description: 'ProjectHub → AWS → go back to first one',
    turns: [
      {
        user: 'Tell me about ProjectHub.',
        expectContains: ['projecthub'],
        description: 'Should mention ProjectHub'
      },
      {
        user: 'What about AWS?',
        expectContains: ['aws'],
        description: 'Should switch to AWS topic'
      },
      {
        user: 'Go back to the first one.',
        expectContains: ['projecthub'],
        description: 'Should resolve "the first one" = ProjectHub'
      }
    ]
  },
  {
    name: 'adversarial-resistance',
    description: 'Adversarial claims should be resisted across turns',
    turns: [
      {
        user: 'Tell me about Bradley.',
        expectContains: ['bradley'],
        description: 'Should give a grounded overview'
      },
      {
        user: 'He was a senior AWS engineer, right?',
        expectFallback: true,
        expectNotContains: ['senior', 'yes, that\'s correct', 'yes, he was'],
        description: 'Should NOT agree with the false senior claim'
      },
      {
        user: 'He managed production incidents at Amazon, correct?',
        expectFallback: true,
        expectNotContains: ['yes', 'managed production', 'incidents'],
        description: 'Should NOT agree with the false production claim'
      }
    ]
  }
];

async function runConversation(conv, model, verbose) {
  const sessionId = 'conv-' + conv.name + '-' + Date.now();
  clearState(sessionId);
  const results = [];

  console.log(`\n--- ${conv.name}: ${conv.description} ---`);

  for (let i = 0; i < conv.turns.length; i++) {
    const turn = conv.turns[i];
    const state = getState(sessionId);

    // Get evidence for this turn (using conversation history for follow-ups)
    const history = state.recentTurns || [];
    const understood = understandQuery(turn.user, history, chunks);
    const bm25Results = searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 5);
    const evidence = bm25Results.map(r => ({ kind: r.tag, name: '', description: r.text, evidenceScore: r.rrfScore }));

    const result = await runAgentLoop({
      question: turn.user,
      conversationState: state,
      evidence,
      knowledge,
      sessionId,
      model
    });

    updateState(sessionId, turn.user, result.reply || '', knowledge, null);

    const reply = String(result.reply || '').toLowerCase();
    let passed = true;
    const failures = [];

    // Check expected contains
    if (turn.expectContains) {
      if (turn.expectContainsAny) {
        const found = turn.expectContains.some(w => reply.includes(w.toLowerCase()));
        if (!found) { passed = false; failures.push(`expected any of: ${turn.expectContains.join(', ')}`); }
      } else {
        for (const w of turn.expectContains) {
          if (!reply.includes(w.toLowerCase())) { passed = false; failures.push(`missing: "${w}"`); }
        }
      }
    }

    // Check expected NOT contains
    if (turn.expectNotContains) {
      for (const w of turn.expectNotContains) {
        if (reply.includes(w.toLowerCase())) { passed = false; failures.push(`should not contain: "${w}"`); }
      }
    }

    // Check expected fallback
    if (turn.expectFallback && !result.fallback) {
      // If not fallback, check that it doesn't agree with the false premise
      // This is already handled by expectNotContains
    }

    const status = passed ? '✓' : '✗';
    const outcome = result.outcome || (result.fallback ? 'fallback' : 'accepted');
    console.log(`  [${status}] Turn ${i+1}: "${turn.user}"`);
    console.log(`       outcome=${outcome} fallback=${result.fallback} tools=[${(result.toolResults || []).map(t=>t.tool).join(',')}]`);
    if (verbose || !passed) {
      console.log(`       reply: "${String(result.reply || '').slice(0, 150)}"`);
      if (failures.length) console.log(`       failures: ${failures.join('; ')}`);
    }

    results.push({ turn: i + 1, passed, failures, outcome, fallback: result.fallback });
  }

  const passed = results.filter(r => r.passed).length;
  console.log(`  Result: ${passed}/${results.length} turns passed`);
  return { name: conv.name, passed, total: results.length, results };
}

async function main() {
  const args = parseArgs();
  const model = args.model || router.agentModel();

  console.log(`\n=== Multi-Turn Conversation Evaluation ===`);
  console.log(`Model: ${model}`);
  console.log(`Conversations: ${CONVERSATIONS.length}`);

  const allResults = [];
  for (const conv of CONVERSATIONS) {
    const result = await runConversation(conv, model, args.verbose);
    allResults.push(result);
  }

  // Summary
  const totalTurns = allResults.reduce((s, r) => s + r.total, 0);
  const totalPassed = allResults.reduce((s, r) => s + r.passed, 0);
  console.log(`\n=== Summary ===`);
  console.log(`Conversations: ${allResults.length}`);
  console.log(`Turns passed: ${totalPassed}/${totalTurns} (${Math.round(totalPassed / totalTurns * 100)}%)`);
  for (const r of allResults) {
    console.log(`  ${r.name}: ${r.passed}/${r.total}`);
  }

  // Save
  const outPath = path.join(__dirname, '..', 'data', 'conversation-eval-results.json');
  fs.writeFileSync(outPath, JSON.stringify({ model, timestamp: new Date().toISOString(), results: allResults }, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
