#!/usr/bin/env node
'use strict';

// Target-machine eval runner. Keeps the model warm with periodic pings
// and runs the Scout eval with a long probe timeout.

const { spawn } = require('child_process');
const http = require('http');

const MODEL = process.argv[2] || 'qwen2.5:0.5b';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const NUM_CTX = process.env.OLLAMA_AGENT_CONTEXT || '1536';

function ping() {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      keep_alive: -1,
      options: { num_predict: 1, num_ctx: parseInt(NUM_CTX, 10) }
    });
    const url = new URL(OLLAMA_URL + '/api/chat');
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ ok: res.statusCode === 200 }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log(`=== Target Eval Runner ===`);
  console.log(`Model: ${MODEL}`);
  console.log(`Ollama: ${OLLAMA_URL}`);
  console.log(`num_ctx: ${NUM_CTX}`);

  // Pre-warm
  console.log('\n--- Pre-warming model ---');
  const t0 = Date.now();
  const warm = await ping();
  console.log(`Warm: ok=${warm.ok} ms=${Date.now() - t0}`);

  // Start keep-alive pinger in background
  const pinger = setInterval(async () => {
    await ping();
  }, 5000);

  // Run eval
  console.log('\n--- Running eval ---');
  const env = {
    ...process.env,
    OLLAMA_URL,
    OLLAMA_AGENT_CONTEXT: NUM_CTX,
    OLLAMA_PROBE_TIMEOUT_MS: '30000',
    OLLAMA_TIMEOUT_MS: '30000'
  };
  const child = spawn('node', ['scripts/eval-scout.js', '--model', MODEL], {
    cwd: __dirname + '/..',
    env,
    stdio: 'inherit'
  });
  child.on('exit', (code) => {
    clearInterval(pinger);
    console.log(`\nEval exited with code ${code}`);
    process.exit(code);
  });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
