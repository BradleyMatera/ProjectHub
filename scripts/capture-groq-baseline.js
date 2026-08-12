/**
 * Capture Groq Golden Baseline
 *
 * Sends the conversation parity suite to the CURRENT production Scout
 * (which uses Groq) and saves the outputs as a golden baseline.
 *
 * This does NOT add Groq as a dependency. It only captures reference outputs
 * from the existing production server before the hosted model is retired.
 *
 * Usage: node scripts/capture-groq-baseline.js
 */

const fs = require('fs');
const path = require('path');
const { CONVERSATIONS } = require('../data/conversation-parity-suite');

const PRODUCTION_URL = 'https://projecthub-chat.bradleymatera.dev';

async function main() {
  console.log('=== Groq Golden Baseline Capture ===');
  console.log('Production URL:', PRODUCTION_URL);
  console.log('Total prompts:', CONVERSATIONS.length);
  console.log('');

  // Group by conversation
  const convMap = new Map();
  for (const c of CONVERSATIONS) {
    if (!convMap.has(c.conv)) convMap.set(c.conv, []);
    convMap.get(c.conv).push(c);
  }

  console.log('Conversations:', convMap.size);
  console.log('');

  const results = [];
  const convHistory = new Map(); // conv -> history array

  for (const c of CONVERSATIONS) {
    const sessionId = `groq-baseline-${c.conv}`;
    const history = convHistory.get(c.conv) || [];

    try {
      const t0 = Date.now();
      const res = await fetch(`${PRODUCTION_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: c.question,
          sessionId,
          history: history.slice(-5)
        })
      });
      const latencyMs = Date.now() - t0;
      const data = await res.json();

      if (!res.ok || !data.reply) {
        console.log(`[${c.conv} T${c.turn}] [${c.category}] ERROR: ${data.error || res.status}`);
        results.push({
          ...c,
          answer: null,
          error: data.error || `HTTP ${res.status}`,
          latencyMs,
          provider: data.provider || 'unknown'
        });
      } else {
        console.log(`[${c.conv} T${c.turn}] [${c.category}] OK ${latencyMs}ms (${data.provider || 'unknown'})`);
        console.log(`  Q: ${c.question}`);
        console.log(`  A: ${data.reply.slice(0, 150)}...`);
        console.log('');
        results.push({
          ...c,
          answer: data.reply,
          latencyMs,
          provider: data.provider || 'unknown',
          pipeline: data.pipeline || [],
          agent: data.agent || null
        });

        // Update history for multi-turn
        history.push({ user: c.question, assistant: data.reply });
        convHistory.set(c.conv, history);
      }
    } catch (err) {
      console.log(`[${c.conv} T${c.turn}] [${c.category}] FETCH ERROR: ${err.message}`);
      results.push({
        ...c,
        answer: null,
        error: err.message,
        latencyMs: 0,
        provider: 'error'
      });
    }

    // Small delay to be respectful to the production server
    await new Promise(r => setTimeout(r, 500));
  }

  // Summary
  const ok = results.filter(r => r.answer).length;
  const errors = results.filter(r => r.error).length;
  const avgLatency = results.filter(r => r.latencyMs > 0).reduce((s, r) => s + r.latencyMs, 0) / (results.filter(r => r.latencyMs > 0).length || 1);

  console.log('=== Summary ===');
  console.log(`OK: ${ok}/${results.length}`);
  console.log(`Errors: ${errors}`);
  console.log(`Avg latency: ${avgLatency.toFixed(0)}ms`);

  // Save
  const outPath = path.join(__dirname, '..', 'data', 'groq-golden-baseline.json');
  fs.writeFileSync(outPath, JSON.stringify({
    capturedAt: new Date().toISOString(),
    source: PRODUCTION_URL,
    provider: 'groq',
    totalPrompts: results.length,
    ok,
    errors,
    avgLatencyMs: Math.round(avgLatency),
    results
  }, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main().catch(err => {
  console.error('Capture failed:', err);
  process.exit(1);
});
