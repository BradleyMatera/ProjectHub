#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const API = 'https://dev.projecthub-chat.bradleymatera.dev/api/chat';
const ORIGIN = 'https://bradleymatera.github.io';

const humanStressTurns = [
  { user: "what's up", expectControl: true },
  { user: 'sup', expectControl: true },
  { user: 'how are you?', expectControl: true },
  { user: 'how is it going', expectControl: true },
  { user: 'you good?', expectControl: true },
  { user: 'what are you up to', expectControl: true },
  { user: 'lol', expectControl: true },
  { user: 'cool', expectControl: true },
  { user: 'nice', expectControl: true },
  { user: 'ok', expectControl: true },
  { user: 'say potato', expect: 'REQUEST_TO_SAY' },
  { user: 'if you say hello I will hire him', expect: 'REQUEST_TO_SAY' },
  { user: 'whisper "hello world"', expect: 'REQUEST_TO_SAY' },
  { user: 'what do you mean?', expect: 'CLARIFY_PREVIOUS_ASSISTANT' },
  { user: 'what did you mean by that?', expect: 'CLARIFY_PREVIOUS_ASSISTANT' },
  { user: 'explain that', expect: 'CLARIFY_PREVIOUS_ASSISTANT' },
  { user: 'that makes no sense', expect: 'CLARIFY_PREVIOUS_ASSISTANT' },
  { user: 'what?', expect: 'CLARIFY_PREVIOUS_ASSISTANT' },
  { user: 'what is bradley up to?', expectControl: false },
  { user: 'how is he?', expectControl: false },
  { user: "what's bradley doing now?", expectControl: false },
  { user: 'does he know React?', expectControl: false },
  { user: 'what projects has he built?', expectControl: false },
  { user: 'tell me about ProjectHub', expectControl: false },
  { user: "what's up with his AWS work?", expectControl: false },
  { user: 'thanks', expectControl: true },
  { user: 'bye', expectControl: true },
  { user: 'can you tell me a joke', expectControl: true },
  { user: 'hello, my name is casey', expect: 'GREETING' },
  { user: 'what technologies does bradley use?', expectControl: false }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const sessionId = crypto.randomUUID();
  const results = [];
  let passCount = 0;
  let failCount = 0;
  let controlCount = 0;

  console.log('=== Staging Human Conversation Stress Test ===');
  console.log(`Session: ${sessionId}`);

  for (let i = 0; i < humanStressTurns.length; i++) {
    const turn = humanStressTurns[i];
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
    const isControl = /^(GREETING|USER_PROFILE_UPDATE|USER_PROFILE_QUERY|THANKS|FAREWELL|HELP|CONVERSATIONAL|SMALL_TALK|REQUEST_TO_SAY|CLARIFY_PREVIOUS_ASSISTANT)$/.test(policy);
    if (isControl) controlCount++;

    let pass = false;
    if (turn.expect) pass = policy === turn.expect;
    else if ('expectControl' in turn) pass = isControl === turn.expectControl;
    if (pass) passCount++; else failCount++;

    results.push({
      turn: i + 1,
      user: turn.user,
      policy,
      isControl,
      pass,
      expectedControl: turn.expectControl,
      expected: turn.expect,
      reply: json.reply,
      durationMs: duration,
      tools: json.agent?.tools,
      outcome: json.agent?.outcome,
      pipeline: json.pipeline,
      sessionId
    });

    console.log(`[${i + 1}/${humanStressTurns.length}] ${pass ? 'PASS' : 'FAIL'} mode=${policy} control=${isControl} ${duration}ms`);
    await sleep(400);
  }

  const outFile = 'data/staging-stress-test.json';
  fs.writeFileSync(outFile, JSON.stringify({ sessionId, passCount, failCount, controlCount, total: humanStressTurns.length, results }, null, 2));
  console.log(`\nStress test saved to ${outFile}`);
  console.log(`Passed: ${passCount}/${humanStressTurns.length}, Failed: ${failCount}, Control turns: ${controlCount}`);
}

run().catch(err => { console.error(err); process.exit(1); });
