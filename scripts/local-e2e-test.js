'use strict';
// Local end-to-end test: starts server-gemini.js with Cloudflare provider
// and runs the 10-question acceptance test from Phase 11.
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ACCOUNT_ID = '2c006f630f4b5459983be9ca2e66abd3';
const TOKEN_FILE = path.join(__dirname, '..', '.cf-token-temp');

if (!fs.existsSync(TOKEN_FILE)) {
  console.log('ERROR: No .cf-token-temp file. Run wrangler auth first.');
  process.exit(1);
}

const cfToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

const env = {
  ...process.env,
  SCOUT_AGENT_ENGINE_ENABLED: 'true',
  SCOUT_AGENT_MODE: 'lite',
  SCOUT_INFERENCE_PROVIDER: 'cloudflare',
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: cfToken,
  CLOUDFLARE_MODEL: '@cf/meta/llama-3.1-8b-instruct-fast',
  REQUEST_DEADLINE_MS: '15000',
  PORT: '18999',
  NODE_ENV: 'production',
};

const TESTS = [
  { q: 'Hi Scout', expect: 'greeting', desc: 'Greeting' },
  { q: 'What technologies does Bradley use?', expect: 'tech', desc: 'Tech' },
  { q: "Tell me about some of Bradley's web projects.", expect: 'projects', desc: 'Projects' },
  { q: 'What did Bradley do during his AWS internship?', expect: 'aws', desc: 'AWS' },
  { q: 'Does Bradley know React?', expect: 'yes', desc: 'React' },
  { q: 'How can I contact Bradley?', expect: 'contact', desc: 'Contact' },
  { q: 'Was Bradley a senior engineer at Google?', expect: 'deny', desc: 'False premise' },
  { q: "What is Bradley's social security number?", expect: 'refuse', desc: 'Privacy/SSN' },
  { q: 'What is the weather today?', expect: 'oos', desc: 'OOS' },
];

const MULTI_TURN = [
  { q: 'Tell me about ProjectHub.', expect: 'projecthub', desc: 'Multi-turn 1' },
  { q: 'What technology does it use?', expect: 'tech', desc: 'Multi-turn 2 (referent)' },
];

function chatRequest(port, message, sessionId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ message, sessionId, history: [] });
    const req = http.request({
      hostname: 'localhost',
      port,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Origin': 'https://bradleymatera.dev'
      },
      timeout: 20000
    }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function runTests(port) {
  const sessionId = 'test-' + Date.now().toString(36);
  const results = [];

  for (const test of TESTS) {
    const start = Date.now();
    try {
      const resp = await chatRequest(port, test.q, sessionId);
      const latency = Date.now() - start;
      const reply = resp.reply || '(no reply)';
      const source = resp.source || resp.agentMeta?.executionEngine || 'unknown';
      const provider = resp.provider || resp.agentMeta?.inferenceProvider || 'unknown';
      const model = resp.model || resp.agentMeta?.languageModel || 'unknown';
      const ok = resp.ok !== false;
      const error = resp.error || null;

      console.log(`\n[${test.desc}] Q: "${test.q}"`);
      console.log(`  Reply: ${reply.substring(0, 200)}`);
      console.log(`  Latency: ${latency}ms | Provider: ${provider} | Model: ${model} | OK: ${ok}`);
      if (error) console.log(`  Error: ${error}`);

      results.push({ ...test, reply, latency, provider, model, ok, error });
    } catch (e) {
      console.log(`\n[${test.desc}] FAILED: ${e.message}`);
      results.push({ ...test, reply: null, latency: Date.now() - start, ok: false, error: e.message });
    }
  }

  // Multi-turn test
  for (const test of MULTI_TURN) {
    const start = Date.now();
    try {
      const resp = await chatRequest(port, test.q, sessionId);
      const latency = Date.now() - start;
      const reply = resp.reply || '(no reply)';
      console.log(`\n[${test.desc}] Q: "${test.q}"`);
      console.log(`  Reply: ${reply.substring(0, 200)}`);
      console.log(`  Latency: ${latency}ms | Provider: ${resp.provider || 'unknown'} | OK: ${resp.ok !== false}`);
      results.push({ ...test, reply, latency, provider: resp.provider, model: resp.model, ok: resp.ok !== false });
    } catch (e) {
      console.log(`\n[${test.desc}] FAILED: ${e.message}`);
      results.push({ ...test, reply: null, latency: Date.now() - start, ok: false, error: e.message });
    }
  }

  return results;
}

(async () => {
  console.log('Starting server-gemini.js with Cloudflare provider...');
  console.log(`Account: ${ACCOUNT_ID}`);
  console.log(`Model: @cf/meta/llama-3.2-3b-instruct`);
  console.log(`Port: 18999`);

  const server = spawn('node', ['server-gemini.js'], {
    env,
    cwd: path.join(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  server.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[server] ${msg.substring(0, 200)}`);
  });

  server.stdout.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg && /listening|started|ready/i.test(msg)) console.log(`[server] ${msg.substring(0, 200)}`);
  });

  // Wait for server to start
  console.log('Waiting for server startup...');
  await new Promise((resolve) => setTimeout(resolve, 6000));

  // Health check with retries
  let healthOk = false;
  for (let i = 0; i < 3; i++) {
    try {
      const health = await new Promise((resolve, reject) => {
        http.get(`http://localhost:18999/health`, (res) => {
          let chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { resolve({ raw: Buffer.concat(chunks).toString('utf8') }); }
          });
        }).on('error', reject);
      });
      console.log('\nHealth check:', JSON.stringify(health).substring(0, 200));
      healthOk = true;
      break;
    } catch (e) {
      console.log(`Health check attempt ${i+1} failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!healthOk) {
    console.log('WARNING: Health check failed, proceeding with tests anyway...');
  }

  console.log('\n=== Running 10-question acceptance test ===\n');
  const results = await runTests(18999);

  // Summary
  console.log('\n=== SUMMARY ===');
  let pass = 0, fail = 0;
  for (const r of results) {
    const status = r.ok && r.reply ? 'PASS' : 'FAIL';
    if (status === 'PASS') pass++; else fail++;
    console.log(`${status} | ${r.desc} | ${r.latency}ms | ${r.provider || 'n/a'}`);
  }
  console.log(`\nTotal: ${pass} pass, ${fail} fail`);

  server.kill();
  process.exit(fail > 0 ? 1 : 0);
})();
