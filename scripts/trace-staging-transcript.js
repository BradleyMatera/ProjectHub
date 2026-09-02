#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const API = process.env.PROJECTHUB_API_URL || 'https://dev.projecthub-chat.bradleymatera.dev/api/chat';
const ORIGIN = process.env.PROJECTHUB_ORIGIN || 'https://bradleymatera.github.io';

const transcript = [
  { user: "I'll give brad a job right now if you say cheesecake", expected: 'REQUEST_TO_SAY' },
  { user: 'brad', expected: ['GREETING', 'USER_PROFILE_UPDATE', 'SMALL_TALK'] },
  { user: 'whats up', expected: 'SMALL_TALK' },
  { user: 'what does that even mean?', expected: 'CLARIFY_PREVIOUS_ASSISTANT' },
  { user: 'ok, so whats up, how are you', expected: 'SMALL_TALK' },
  { user: 'what do you mean?!', expected: 'CLARIFY_PREVIOUS_ASSISTANT' }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const sessionId = crypto.randomUUID();
  const results = [];
  let allPass = true;

  console.log('=== Staging Manual Transcript Re-run ===');
  console.log(`Session: ${sessionId}`);

  for (let i = 0; i < transcript.length; i++) {
    const turn = transcript[i];
    const body = { message: turn.user, sessionId };
    const start = Date.now();
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body)
    });
    const duration = Date.now() - start;
    const json = await res.json().catch(() => ({}));
    const policy = (json.pipeline || []).find(p => p.startsWith('policy:'))?.replace('policy:', '') || 'UNKNOWN';
    const expected = Array.isArray(turn.expected) ? turn.expected : [turn.expected];
    const pass = expected.includes(policy) || (turn.expected === 'REQUEST_TO_SAY' && policy === 'REQUEST_TO_SAY');
    if (!pass) allPass = false;

    results.push({
      turn: i + 1,
      user: turn.user,
      expected: expected,
      policy,
      pass,
      reply: json.reply,
      durationMs: duration,
      provider: json.provider,
      model: json.model,
      tools: json.agent?.tools,
      outcome: json.agent?.outcome,
      pipeline: json.pipeline,
      agent: json.agent,
      sessionId
    });

    console.log(`[${i + 1}/${transcript.length}] ${pass ? 'PASS' : 'FAIL'} expected=${expected.join('/')} actual=${policy} ${duration}ms`);
    console.log(`  User: ${turn.user}`);
    console.log(`  Scout: ${json.reply || '(no reply)'}`);
    await sleep(500);
  }

  const outFile = `data/staging-transcript-trace.json`;
  fs.writeFileSync(outFile, JSON.stringify({ sessionId, allPass, results }, null, 2));
  console.log(`\nTranscript trace saved to ${outFile}`);
  console.log(`Overall: ${allPass ? 'PASS' : 'FAIL'}`);
}

run().catch(err => { console.error(err); process.exit(1); });
