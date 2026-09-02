#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const API = process.env.PROJECTHUB_API_URL || 'https://dev.projecthub-chat.bradleymatera.dev/api/chat';
const ORIGIN = process.env.PROJECTHUB_ORIGIN || 'https://bradleymatera.github.io';

const transcript = [
  'timtom',
  'ok, well that was kinda sudden dont you think ;)',
  'id like to talk about brad if thats ok with you',
  'well first off, can he vibe code or code code?',
  'really? prove it!',
  'that didnt prove shit son, im a non tech person, i dont know DICK',
  'why should i hire brad!',
  'ok, well is brad the right person?',
  'you dont know his qualifcations?',
  'hrrrmmm your kinda wrong, https://bradleymatera.dev/recruiter/ or maybe even https://bradleymatera.dev/work/ would be a good place for you to learn more about him',
  'can you go there and read them and commit this to your database or memory? or at least let brad know your broken giving me wrong ansers, i mean his creds are there in the open, even his resumes are there'
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const crypto = require('node:crypto');
  const sessionId = crypto.randomUUID();
  const results = [];
  console.log(`=== Real Human Transcript (8B) === session: ${sessionId}`);
  for (let i = 0; i < transcript.length; i++) {
    const q = transcript[i];
    const start = Date.now();
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ message: q, sessionId })
    });
    const duration = Date.now() - start;
    const json = await res.json().catch(() => ({}));
    const policy = (json.pipeline || []).find(p => p.startsWith('policy:'))?.replace('policy:', '') || 'UNKNOWN';
    results.push({ turn: i + 1, user: q, policy, reply: json.reply, durationMs: duration, provider: json.provider, model: json.model, pipeline: json.pipeline, agent: json.agent });
    console.log(`\n[${i + 1}] ${policy} | ${json.provider}/${json.model} | ${duration}ms`);
    console.log(`User: ${q}`);
    console.log(`Scout: ${(json.reply || '(none)').slice(0, 400)}...`);
    await sleep(3000);
  }
  fs.writeFileSync('data/real-human-transcript-8b.json', JSON.stringify({ sessionId, results }, null, 2));
  console.log('\nSaved to data/real-human-transcript-8b.json');
})();
