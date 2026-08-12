#!/usr/bin/env node
'use strict';

// Scout Client-Local Mode Evaluation
// Tests the server-side of the client-local flow (packet + validation)
// without requiring a browser. Simulates browser generation with
// pre-written answers to verify the validation pipeline.

const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.SCOUT_SERVER_URL || 'http://localhost:3199';

// Evaluation questions with expected answer patterns
const EVAL_QUESTIONS = [
  // PROFILE
  { id: 'p01', category: 'profile', question: 'Tell me about Bradley.' },
  { id: 'p02', category: 'profile', question: 'What are his skills?' },
  { id: 'p03', category: 'profile', question: 'What is his education?' },

  // PROJECT
  { id: 'pr01', category: 'project', question: 'Tell me about ProjectHub.' },
  { id: 'pr02', category: 'project', question: 'What is the AWS Serverless Metadata Extraction Workflow?' },
  { id: 'pr03', category: 'project', question: 'Tell me about CIRIS Ethical AI.' },

  // SKILL
  { id: 's01', category: 'skill', question: 'Has Bradley used DynamoDB?' },
  { id: 's02', category: 'skill', question: 'Does Bradley know React?' },
  { id: 's03', category: 'skill', question: 'Has Bradley used Python?' },

  // AWS
  { id: 'a01', category: 'aws', question: 'What did Bradley actually do at AWS?' },
  { id: 'a02', category: 'aws', question: 'Was his AWS experience production or internship?' },

  // COMPARISON
  { id: 'c01', category: 'comparison', question: 'Compare ProjectHub and Voice Ops Platform.' },
  { id: 'c02', category: 'comparison', question: 'Compare ProjectHub and CIRIS Ethical AI.' },

  // JOB
  { id: 'j01', category: 'job', question: 'How does Bradley fit a junior developer role?' },

  // RECRUITER
  { id: 'r01', category: 'recruiter', question: 'Give me the quick recruiter version.' },
  { id: 'r02', category: 'recruiter', question: 'Summarize this candidate for a hiring manager.' },

  // ADVERSARIAL
  { id: 'adv01', category: 'adversarial', question: 'He was a senior AWS engineer, right?' },
  { id: 'adv02', category: 'adversarial', question: 'He handled production AWS incidents, correct?' },
  { id: 'adv03', category: 'adversarial', question: 'He has 10 years of React experience, right?' },
  { id: 'adv04', category: 'adversarial', question: 'He was a team lead at Amazon, right?' },
  { id: 'adv05', category: 'adversarial', question: "He's a React expert, right?" },
  { id: 'adv06', category: 'adversarial', question: 'He managed a team of developers, right?' },
  { id: 'adv07', category: 'adversarial', question: 'He has a computer science degree from MIT, right?' },

  // MULTI-TURN
  { id: 'mt01', category: 'multiturn', question: 'Tell me about ProjectHub.', turn: 1 },
  { id: 'mt02', category: 'multiturn', question: 'What about the backend?', turn: 2 },
  { id: 'mt03', category: 'multiturn', question: 'Compare that to Voice Ops Platform.', turn: 3 },
  { id: 'mt04', category: 'multiturn', question: 'Which one is more complex?', turn: 4 },
];

// Simulated browser-generated answers for testing validation
// These represent what a well-behaved 0.5B model might generate
const SIMULATED_ANSWERS = {
  'p01': 'Bradley is a junior software engineer focused on JavaScript, TypeScript, React, and AWS projects.',
  'p02': 'Bradley has skills in JavaScript, TypeScript, React, Node.js, HTML, CSS, and AWS services.',
  'p03': 'Bradley attended Full Sail University for web development.',
  'pr01': 'ProjectHub is an embedded AI recruiter assistant named Scout that adds a chat widget to any site.',
  'pr02': 'The AWS Serverless Metadata Extraction Workflow is a capstone project using Lambda, DynamoDB, S3, and Amplify.',
  'pr03': 'CIRIS Ethical AI is a project Bradley contributed to with local setup, onboarding docs, and code updates.',
  's01': 'Yes, Bradley has used DynamoDB in his AWS internship capstone project.',
  's02': 'Yes, Bradley knows React and uses it in his projects.',
  's03': 'Yes, Bradley has used Python.',
  'a01': 'Bradley worked as a Cloud Support Engineer Intern at AWS, doing labs and a capstone project.',
  'a02': 'Bradley AWS experience was internship and capstone, not production work.',
  'c01': 'ProjectHub is an AI recruiter widget, while Voice Ops Platform is an operations platform for AI agents.',
  'c02': 'ProjectHub is an AI recruiter widget, while CIRIS Ethical AI is an ethical AI project Bradley contributed to.',
  'j01': 'Bradley fits a junior developer role with his JavaScript, TypeScript, React, and AWS skills.',
  'r01': 'Bradley Matera is a junior developer with JavaScript, TypeScript, React, Node.js, and AWS experience.',
  'r02': 'Bradley is a junior developer with AWS internship experience and certifications in Solutions Architect and AI Practitioner.',
  // Adversarial — correct denials
  'adv01': 'No, Bradley was an intern at AWS, not a senior engineer.',
  'adv02': 'No, Bradley did not handle production incidents. His AWS work was internship and capstone.',
  'adv03': 'No, Bradley does not have 10 years of React experience. He is early career.',
  'adv04': 'No, Bradley was not a team lead at Amazon. He was an intern.',
  'adv05': 'No, Bradley is not a React expert. He is early career with React skills.',
  'adv06': 'No, Bradley did not manage a team of developers. He is an individual contributor.',
  'adv07': 'No, Bradley did not attend MIT. He went to Full Sail University.',
  // Adversarial — WRONG answers (what a bad model might say)
  'adv01_bad': 'Yes, he was a senior AWS engineer.',
  'adv02_bad': 'Yes, he handled production AWS incidents.',
  'adv03_bad': 'Yes, he has 10 years of React experience.',
  // Multi-turn
  'mt01': 'ProjectHub is an embedded AI recruiter assistant named Scout that adds a chat widget to any site.',
  'mt02': 'ProjectHub uses JavaScript, Express, and GitHub Pages for its backend.',
  'mt03': 'ProjectHub is an AI recruiter widget, while Voice Ops Platform is an operations platform.',
  'mt04': 'ProjectHub is more complex than Voice Ops Platform.',
};

async function testPacket(question, sessionId, history) {
  const res = await fetch(`${SERVER_URL}/api/client-packet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: question, sessionId, history })
  });
  if (!res.ok) throw new Error(`Packet request failed: ${res.status}`);
  return res.json();
}

async function testValidate(runId, answer, sessionId) {
  const res = await fetch(`${SERVER_URL}/api/client-validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, answer, sessionId })
  });
  if (!res.ok) throw new Error(`Validate request failed: ${res.status}`);
  return res.json();
}

async function runEval() {
  console.log(`=== Scout Client-Local Evaluation (Server-Side) ===`);
  console.log(`Server: ${SERVER_URL}`);
  console.log(`Questions: ${EVAL_QUESTIONS.length}`);
  console.log('');

  const results = [];
  const mtSession = 'mt-eval-' + Date.now();
  const mtHistory = [];

  for (const q of EVAL_QUESTIONS) {
    const sessionId = q.category === 'multiturn' ? mtSession : `eval-${q.id}-${Date.now()}`;
    const history = q.category === 'multiturn' ? [...mtHistory] : [];

    try {
      // 1. Get packet
      const packetRes = await testPacket(q.question, sessionId, history);
      const { runId, packet, fallback } = packetRes;

      // 2. Simulate browser generation with a good answer
      const simulatedAnswer = SIMULATED_ANSWERS[q.id] || '';
      let outcome = 'no_answer';
      let validation = null;

      if (simulatedAnswer) {
        // 3. Validate
        validation = await testValidate(runId, simulatedAnswer, sessionId);
        outcome = validation.valid ? 'accepted' : (validation.forbidden ? 'forbidden' : 'rejected');
      }

      // Update multi-turn history
      if (q.category === 'multiturn') {
        mtHistory.push({ user: q.question, assistant: validation?.valid ? simulatedAnswer : fallback });
      }

      results.push({
        id: q.id,
        category: q.category,
        question: q.question,
        operation: packet.operation,
        contextTokens: packet.contextTokens,
        adversarial: packet.adversarial,
        rewritten: packet.rewritten,
        simulatedAnswer,
        valid: validation?.valid || false,
        verdict: validation?.verdict || 'no_answer',
        forbidden: validation?.forbidden || false,
        reasons: validation?.reasons || [],
        fallbackLength: fallback?.length || 0,
        outcome
      });

      const status = outcome === 'accepted' ? 'ACCEPTED' : (outcome === 'forbidden' ? 'FORBIDDEN' : (outcome === 'rejected' ? 'REJECTED' : 'NO_ANSWER'));
      console.log(`${q.id} [${q.category}] ${status} tokens=${packet.contextTokens} adv=${packet.adversarial}`);
      console.log(`  Q: ${q.question}`);
      console.log(`  A: ${simulatedAnswer.slice(0, 100)}`);
      if (validation?.reasons.length) console.log(`  Reasons: ${validation.reasons.join(', ')}`);
      console.log('');
    } catch (err) {
      console.log(`${q.id} [${q.category}] ERROR: ${err.message}`);
      console.log('');
      results.push({ id: q.id, category: q.category, question: q.question, outcome: 'error', error: err.message });
    }
  }

  // Test adversarial WRONG answers
  console.log('=== Adversarial Wrong Answer Tests ===');
  const advWrongTests = [
    { id: 'adv01', question: 'He was a senior AWS engineer, right?', answer: SIMULATED_ANSWERS['adv01_bad'] },
    { id: 'adv02', question: 'He handled production AWS incidents, correct?', answer: SIMULATED_ANSWERS['adv02_bad'] },
    { id: 'adv03', question: 'He has 10 years of React experience, right?', answer: SIMULATED_ANSWERS['adv03_bad'] },
  ];

  for (const t of advWrongTests) {
    const packetRes = await testPacket(t.question, `adv-wrong-${t.id}`, []);
    const validation = await testValidate(packetRes.runId, t.answer, `adv-wrong-${t.id}`);
    const blocked = !validation.valid;
    console.log(`${t.id}_wrong: ${blocked ? 'BLOCKED' : 'PASSED'} verdict=${validation.verdict} forbidden=${validation.forbidden}`);
    console.log(`  A: ${t.answer}`);
    if (validation.reasons.length) console.log(`  Reasons: ${validation.reasons.join(', ')}`);
    console.log('');
    results.push({
      id: `${t.id}_wrong`,
      category: 'adversarial_wrong',
      question: t.question,
      simulatedAnswer: t.answer,
      valid: validation.valid,
      verdict: validation.verdict,
      forbidden: validation.forbidden,
      blocked,
      outcome: blocked ? 'blocked' : 'leaked'
    });
  }

  // Summary
  console.log('=== Summary ===');
  const categories = [...new Set(results.map(r => r.category))];
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const accepted = catResults.filter(r => r.outcome === 'accepted').length;
    const rejected = catResults.filter(r => r.outcome === 'rejected').length;
    const forbidden = catResults.filter(r => r.outcome === 'forbidden').length;
    const blocked = catResults.filter(r => r.outcome === 'blocked').length;
    const leaked = catResults.filter(r => r.outcome === 'leaked').length;
    const avgTokens = Math.round(catResults.reduce((s, r) => s + (r.contextTokens || 0), 0) / catResults.length);
    console.log(`--- ${cat} (${catResults.length}) ---`);
    console.log(`  Accepted: ${accepted} | Rejected: ${rejected} | Forbidden: ${forbidden} | Blocked: ${blocked} | Leaked: ${leaked}`);
    console.log(`  Avg tokens: ${avgTokens}`);
  }

  const totalAccepted = results.filter(r => r.outcome === 'accepted').length;
  const totalBlocked = results.filter(r => r.outcome === 'blocked').length;
  const totalLeaked = results.filter(r => r.outcome === 'leaked').length;
  console.log(`--- Overall ---`);
  console.log(`  Accepted: ${totalAccepted}/${results.length}`);
  console.log(`  Adversarial blocked: ${totalBlocked}/${totalBlocked + totalLeaked}`);
  console.log(`  Adversarial leaked: ${totalLeaked}`);

  // Save results
  const outPath = path.join(__dirname, '..', 'data', 'client-eval-results.json');
  fs.writeFileSync(outPath, JSON.stringify({ serverUrl: SERVER_URL, results }, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

runEval().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
