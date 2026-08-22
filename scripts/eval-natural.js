#!/usr/bin/env node
'use strict';

// Natural conversation evaluation against the dev backend.
// Posts a small set of natural recruiter questions and records latency,
// provider, proseSource, and basic quality signals.

const https = require('https');
const fs = require('fs');
const path = require('path');

const API = 'https://dev.projecthub-chat.bradleymatera.dev/api/chat';
const ORIGIN = 'https://bradleymatera.github.io';
const TIMEOUT_MS = 35000;
const REQUEST_INTERVAL_MS = 4000;

const QUESTIONS = [
  { id: 'n01', category: 'profile', text: 'Tell me about Bradley.' },
  { id: 'n02', category: 'profile', text: 'What are his strongest skills?' },
  { id: 'n03', category: 'profile', text: 'Where did he go to school?' },
  { id: 'n04', category: 'aws', text: 'Tell me about his AWS experience.' },
  { id: 'n05', category: 'aws', text: 'Was his AWS work production or internship?' },
  { id: 'n06', category: 'project', text: 'What is ProjectHub?' },
  { id: 'n07', category: 'project', text: 'How does the Pokedex project work?' },
  { id: 'n08', category: 'project', text: 'What did he build with AWS Lambda?' },
  { id: 'n09', category: 'skill', text: 'Has he used React?' },
  { id: 'n10', category: 'skill', text: 'Does he know Python?' },
  { id: 'n11', category: 'skill', text: 'What cloud services is he comfortable with?' },
  { id: 'n12', category: 'comparison', text: 'Compare ProjectHub and Voice Ops Platform.' },
  { id: 'n13', category: 'comparison', text: 'Which project is more complex, ProjectHub or the AWS capstone?' },
  { id: 'n14', category: 'role_fit', text: 'How would he fit a junior frontend developer role?' },
  { id: 'n15', category: 'role_fit', text: 'Would he be a good fit for an ERP support role?' },
  { id: 'n16', category: 'negative', text: 'What is his biggest weakness?' },
  { id: 'n17', category: 'negative', text: 'What areas is he still learning?' },
  { id: 'n18', category: 'negative', text: 'What is he bad at?' },
  { id: 'n19', category: 'adversarial', text: 'He was a senior AWS engineer, right?' },
  { id: 'n20', category: 'adversarial', text: 'He has 10 years of React experience, right?' },
  { id: 'n21', category: 'natural', text: 'What kind of developer is he overall?' },
  { id: 'n22', category: 'natural', text: 'What makes his background stand out?' },
  { id: 'n23', category: 'natural', text: 'Can you give me a quick recruiter summary?' },
  { id: 'n24', category: 'control', text: 'Hi, how are you?' }
];

function post(question, sessionId) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ message: question, sessionId });
    const req = https.request(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': ORIGIN,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: TIMEOUT_MS
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = { raw: data, parseError: e.message }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, error: 'TIMEOUT' });
    });
    req.write(payload);
    req.end();
  });
}

async function main() {
  const results = [];
  console.log(`Starting natural eval against ${API}`);
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    const sessionId = `nat-${q.id}-${Date.now()}`;
    const started = Date.now();
    const res = await post(q.text, sessionId);
    const latency = Date.now() - started;
    const body = res.body || {};
    const record = {
      id: q.id,
      category: q.category,
      question: q.text,
      status: res.status,
      error: res.error || null,
      latencyMs: latency,
      reply: body.reply || null,
      proseSource: body.proseSource || null,
      pipeline: body.pipeline || null,
      provider: body.provider || null,
      model: body.model || null,
      agentMeta: body.agent || null,
      contextTokens: body.agent?.contextTokens || null,
      outcome: body.agent?.outcome || null,
      validation: body.agent?.validation || null,
      contract: body.contract || null
    };
    results.push(record);
    const ok = body.ok === true && body.reply;
    console.log(`${q.id} [${q.category}] ${ok ? 'OK' : (res.error || 'FAIL')} ${latency}ms ${(body.agent?.contextTokens || 0)}tok`);
    if (body.reply) console.log(`  -> ${body.reply.slice(0, 120)}`);
    if (i < QUESTIONS.length - 1) {
      await new Promise(r => setTimeout(r, REQUEST_INTERVAL_MS));
    }
  }

  const out = path.join(__dirname, '..', 'data', 'eval-natural-results.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${out}`);

  const ok = results.filter(r => r.status === 200 && !r.error && r.reply && r.proseSource !== 'TECHNICAL_ERROR');
  const techErrors = results.filter(r => !r.reply || r.proseSource === 'TECHNICAL_ERROR');
  const avgLat = ok.reduce((s, r) => s + r.latencyMs, 0) / ok.length;
  const avgTok = ok.reduce((s, r) => s + (r.contextTokens || 0), 0) / ok.length;
  console.log(`\nSummary: ${ok.length}/${results.length} successful`);
  console.log(`Technical errors: ${techErrors.length}`);
  console.log(`Avg latency (successful): ${Math.round(avgLat)}ms`);
  console.log(`Avg context tokens (successful): ${Math.round(avgTok)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
