#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const API = 'https://dev.projecthub-chat.bradleymatera.dev/api/chat';
const ORIGIN = 'https://bradleymatera.github.io';
const TIMEOUT_MS = 35000;
const REQUEST_INTERVAL_MS = 4000;

const QUESTIONS = [
  { id: 'q01', text: 'Tell me about Bradley\'s AWS experience.' },
  { id: 'q02', text: 'What did he actually do during his AWS internship?' },
  { id: 'q03', text: 'What has he built with React?' },
  { id: 'q04', text: 'What did he use TypeScript for?' },
  { id: 'q05', text: 'How does ProjectHub work?' },
  { id: 'q06', text: 'Compare ProjectHub with the AWS capstone.' },
  { id: 'q07', text: 'What experience does he have that could transfer to ERP support?' },
  { id: 'q08', text: 'What are his strongest technical areas?' },
  { id: 'q09', text: 'What are some things he still needs to learn?' },
  { id: 'q10', text: 'Does he know Rust?' },
  { id: 'q11', text: 'He worked at Google, right?' },
  { id: 'q12', text: 'Based on his actual experience and projects, what kind of role fits him?' }
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
  console.log(`Starting natural quality eval against ${API}`);
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    const sessionId = `natq-${q.id}-${Date.now()}`;
    const started = Date.now();
    const res = await post(q.text, sessionId);
    const latency = Date.now() - started;
    const body = res.body || {};
    const meta = body.agent || body.agentMeta || {};
    const calls = meta.generationCalls || [];
    const primaryCall = calls.find(c => c.attemptType === 'PRIMARY') || null;
    const repairCall = calls.find(c => c.attemptType === 'FACTUAL_REPAIR') || null;

    const record = {
      id: q.id,
      question: q.text,
      status: res.status,
      error: res.error || body.error || null,
      latencyMs: latency,
      proseSource: body.proseSource || null,
      provider: body.provider || null,
      model: body.model || null,
      reply: body.reply || null,
      rewrittenQuery: meta.rewrittenQuery || null,
      promptTokens: meta.contextTokens || null,
      retrievalCandidates: (meta.retrievalCandidates || []).slice(0, 10),
      selectedEvidence: meta.selectedEvidence || null,
      toolEnrichment: meta.toolEnrichment || null,
      rawGeneratedAnswer: meta.rawPrimary || null,
      rawRepairAnswer: meta.rawRepair || null,
      primaryValidation: primaryCall ? { valid: primaryCall.accepted, reasons: primaryCall.validationReasons || [] } : null,
      repairAttempted: !!repairCall,
      repairValidation: repairCall ? { valid: repairCall.accepted, reasons: repairCall.validationReasons || [] } : null,
      providerCalls: meta.actualProviderCalls ?? null,
      generationCalls: calls,
      manualReview: {
        retrieval: null,
        grounding: null,
        usefulness: null,
        naturalness: null
      }
    };
    results.push(record);

    const ok = body.ok === true && body.reply && body.proseSource !== 'TECHNICAL_ERROR';
    console.log(`${q.id} ${ok ? 'OK' : (res.error || 'FAIL')} ${latency}ms calls=${meta.actualProviderCalls || '?'} tokens=${meta.contextTokens || '?'}`);
    console.log(`  -> ${(body.reply || '[no reply]').slice(0, 120)}`);

    if (i < QUESTIONS.length - 1) {
      await new Promise(r => setTimeout(r, REQUEST_INTERVAL_MS));
    }
  }

  const out = path.join(__dirname, '..', 'data', 'eval-natural-quality.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nRaw results written to ${out}`);

  const ok = results.filter(r => r.status === 200 && !r.error && r.reply && r.proseSource !== 'TECHNICAL_ERROR');
  const techErrors = results.filter(r => !r.reply || r.proseSource === 'TECHNICAL_ERROR');
  const avgLat = ok.reduce((s, r) => s + r.latencyMs, 0) / (ok.length || 1);
  const avgTok = ok.reduce((s, r) => s + (r.promptTokens || 0), 0) / (ok.length || 1);
  const avgCalls = ok.reduce((s, r) => s + (r.providerCalls || 0), 0) / (ok.length || 1);
  console.log(`\nSummary: ${ok.length}/${results.length} successful`);
  console.log(`Technical errors: ${techErrors.length}`);
  console.log(`Avg latency: ${Math.round(avgLat)}ms`);
  console.log(`Avg prompt tokens: ${Math.round(avgTok)}`);
  console.log(`Avg provider calls: ${avgCalls.toFixed(2)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
