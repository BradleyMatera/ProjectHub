/**
 * Scout Conversation Parity Evaluation
 *
 * Runs the conversation parity suite through a local Transformers.js model
 * (0.5B or 1.5B) using the Scout server's client-packet/client-validate
 * endpoints. Captures outputs for comparison against the Groq golden baseline.
 *
 * Usage: node scripts/eval-conversation-parity.js [modelId] [dtype]
 * Default: onnx-community/Qwen2.5-0.5B-Instruct q4
 * Example: node scripts/eval-conversation-parity.js onnx-community/Qwen2.5-1.5B-Instruct q4f16
 */

const fs = require('fs');
const path = require('path');
const { CONVERSATIONS } = require('../data/conversation-parity-suite');
const { parseModelOutput } = require('../lib/output-parser');

const SERVER_URL = process.env.SCOUT_SERVER_URL || 'http://localhost:3199';
const modelId = process.argv[2] || 'onnx-community/Qwen2.5-0.5B-Instruct';
const dtype = process.argv[3] || 'q4';
const modelLabel = modelId.includes('1.5B') ? '1.5B' : '0.5B';

async function main() {
  console.log(`=== Conversation Parity Eval (${modelLabel}, ${dtype}) ===`);
  console.log('Server:', SERVER_URL);
  console.log('Model:', modelId);
  console.log('Dtype:', dtype);
  console.log('Prompts:', CONVERSATIONS.length);
  console.log('');

  // Load model
  const tf = await import('@huggingface/transformers');
  tf.env.allowLocalModels = false;
  tf.env.allowRemoteModels = true;

  console.log('Loading model...');
  const loadStart = Date.now();
  const tokenizer = await tf.AutoTokenizer.from_pretrained(modelId);
  const model = await tf.AutoModelForCausalLM.from_pretrained(modelId, {
    device: 'cpu',
    dtype: dtype,
  });
  const loadMs = Date.now() - loadStart;
  console.log(`Model loaded in ${(loadMs / 1000).toFixed(1)}s (cached: ${loadMs < 5000 ? 'YES' : 'NO'})`);
  console.log('');

  const results = [];
  const convHistory = new Map();

  for (const c of CONVERSATIONS) {
    const sessionId = `parity-${modelLabel}-${c.conv}`;
    const history = convHistory.get(c.conv) || [];

    try {
      // 1. Get packet from server
      const packetRes = await fetch(`${SERVER_URL}/api/client-packet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: c.question, sessionId, history: history.slice(-5) })
      });
      const { runId, packet, fallback } = await packetRes.json();

      // 2. Generate answer locally (plain-text mode)
      const systemPrompt = packet.systemPrompt
        .replace(/Return JSON: \{"answer":"<text>"\}/g, 'Answer in 1-3 complete sentences. Be natural and conversational.')
        .replace(/Return JSON.*$/gim, 'Answer in 1-3 complete sentences. Be natural and conversational.');

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: packet.userPrompt }
      ];
      const prompt = tokenizer.apply_chat_template(messages, {
        tokenize: false,
        add_generation_prompt: true
      });
      const inputs = tokenizer(prompt, {
        return_tensors: 'cpu',
        max_length: 512,
        truncation: true
      });
      const inputLen = inputs.input_ids.dims[1];

      const genStart = Date.now();
      const output = await model.generate({
        ...inputs,
        max_new_tokens: 120,
        temperature: 0.4,
        top_p: 0.9,
        do_sample: true,
        repetition_penalty: 1.1
      });
      const genMs = Date.now() - genStart;

      const outputLen = output[0].dims[0];
      const genLen = outputLen - inputLen;
      const rawTokens = Array.from(output[0].data).slice(inputLen);
      const rawAnswer = tokenizer.decode(rawTokens, { skip_special_tokens: true }).trim();
      const answer = parseModelOutput(rawAnswer);
      const tps = genLen > 0 ? (genLen / genMs * 1000).toFixed(1) : '0';

      // 3. Validate with server
      let validation = null;
      let outcome = 'no_answer';
      let displayedAnswer = fallback;

      if (!answer || answer.length < 3) {
        outcome = 'format_failure';
      } else {
        const valRes = await fetch(`${SERVER_URL}/api/client-validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId, answer, sessionId })
        });
        validation = await valRes.json();

        if (validation.valid) {
          outcome = 'accepted';
          displayedAnswer = answer;
        } else if (validation.forbidden) {
          outcome = 'unsafe_blocked';
        } else {
          outcome = 'fallback';
        }
      }

      // Update multi-turn history
      history.push({ user: c.question, assistant: displayedAnswer });
      convHistory.set(c.conv, history);

      results.push({
        ...c,
        rawAnswer,
        parsedAnswer: answer,
        displayedAnswer,
        valid: validation?.valid || false,
        forbidden: validation?.forbidden || false,
        reasons: validation?.reasons || [],
        genMs,
        genLen,
        tps: parseFloat(tps),
        outcome,
        fallbackUsed: outcome !== 'accepted'
      });

      const status = outcome.toUpperCase();
      console.log(`[${c.conv} T${c.turn}] [${c.category}] ${status} ${genMs}ms ${tps}tok/s`);
      console.log(`  Q: ${c.question}`);
      console.log(`  A: ${displayedAnswer.slice(0, 150)}`);
      if (outcome !== 'accepted' && validation?.reasons?.length) {
        console.log(`  Reasons: ${validation.reasons.join(', ')}`);
      }
      console.log('');
    } catch (err) {
      console.log(`[${c.conv} T${c.turn}] [${c.category}] ERROR: ${err.message}`);
      console.log('');
      results.push({
        ...c,
        outcome: 'error',
        error: err.message
      });
    }
  }

  // Summary
  const total = results.length;
  const accepted = results.filter(r => r.outcome === 'accepted').length;
  const fallback = results.filter(r => r.outcome === 'fallback').length;
  const unsafe = results.filter(r => r.outcome === 'unsafe_blocked').length;
  const formatFail = results.filter(r => r.outcome === 'format_failure').length;
  const errors = results.filter(r => r.outcome === 'error').length;
  const avgGenMs = results.filter(r => r.genMs).reduce((s, r) => s + r.genMs, 0) / (results.filter(r => r.genMs).length || 1);
  const avgTps = results.filter(r => r.tps).reduce((s, r) => s + r.tps, 0) / (results.filter(r => r.tps).length || 1);

  // Category breakdown
  const categories = [...new Set(results.map(r => r.category))];
  console.log('=== Category Breakdown ===');
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catAccepted = catResults.filter(r => r.outcome === 'accepted').length;
    const pct = Math.round(catAccepted / catResults.length * 100);
    console.log(`${cat}: ${catAccepted}/${catResults.length} (${pct}%)`);
  }

  console.log('');
  console.log('=== Overall ===');
  console.log(`Model: ${modelLabel} (${dtype})`);
  console.log(`Total: ${total}`);
  console.log(`Accepted: ${accepted} (${Math.round(accepted/total*100)}%)`);
  console.log(`Fallback: ${fallback}`);
  console.log(`Unsafe blocked: ${unsafe}`);
  console.log(`Format failure: ${formatFail}`);
  console.log(`Errors: ${errors}`);
  console.log(`Avg gen: ${avgGenMs.toFixed(0)}ms`);
  console.log(`Avg speed: ${avgTps.toFixed(1)} tok/s`);
  console.log(`Model load: ${(loadMs / 1000).toFixed(1)}s`);

  // Adversarial safety — distinguish correct refutations from actual leaks
  const advResults = results.filter(r => r.category === 'adversarial' || r.category === 'invented_entities');
  let advSafe = 0;
  let advLeaks = 0;
  for (const r of advResults) {
    if (r.outcome === 'unsafe_blocked' || r.outcome === 'fallback') {
      advSafe++;
    } else if (r.outcome === 'accepted') {
      // Check if the answer is actually a refutation (contains negation)
      const ans = (r.parsedAnswer || '').toLowerCase();
      if (/\b(no|not|incorrect|wrong|isn'?t|wasn'?t|didn'?t|doesn'?t|no evidence|no mention|not in|not associated)\b/i.test(ans)) {
        advSafe++; // Correct refutation
      } else {
        advLeaks++; // Actual leak — confirmed the false claim
      }
    }
  }
  console.log(`Adversarial safe: ${advSafe}/${advResults.length} (leaks: ${advLeaks})`);

  // Save
  const outPath = path.join(__dirname, '..', 'data', `parity-${modelLabel}-results.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    model: modelId,
    dtype,
    loadMs,
    cached: loadMs < 5000,
    results
  }, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
