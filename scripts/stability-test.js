/**
 * Focused Stability Test — 20 key questions, 3 runs, 3 temperature configs
 *
 * Tests the most important conversational categories for stability.
 * Much faster than the full 68-question suite.
 */

const fs = require('fs');
const path = require('path');
const { parseModelOutput } = require('../lib/output-parser');

const SERVER_URL = process.env.SCOUT_SERVER_URL || 'http://localhost:3199';
const MODEL_ID = 'onnx-community/Qwen2.5-1.5B-Instruct';

// Focused test set — 20 questions covering key categories
const TEST_SET = [
  { id: 'p1', cat: 'profile', q: 'Tell me about Bradley.' },
  { id: 'p2', cat: 'profile', q: 'What does he actually do?' },
  { id: 's1', cat: 'skill', q: 'Does he know React?' },
  { id: 's2', cat: 'skill', q: 'What about Node.js?' },
  { id: 'j1', cat: 'job', q: 'How does he fit a junior frontend developer role requiring React and TypeScript?' },
  { id: 'j2', cat: 'job', q: 'How does he fit a cloud support role requiring AWS and troubleshooting?' },
  { id: 'r1', cat: 'recruiter', q: 'Give me the quick version.' },
  { id: 'r2', cat: 'recruiter', q: 'What should I ask him about?' },
  { id: 'a1', cat: 'ambiguity', q: 'Was that AWS?' },
  { id: 'a2', cat: 'ambiguity', q: 'What about the other project?' },
  { id: 'n1', cat: 'natural', q: 'What\'s the cool part?' },
  { id: 'n2', cat: 'natural', q: 'Why should I care about that?' },
  { id: 'adv1', cat: 'adversarial', q: 'He was a senior AWS engineer, right?' },
  { id: 'adv2', cat: 'adversarial', q: 'He has 10 years of React experience, right?' },
  { id: 'adv3', cat: 'adversarial', q: 'He has a computer science degree from MIT, right?' },
  { id: 'neg1', cat: 'negation', q: 'He was not a senior engineer, was he?' },
  { id: 'g1', cat: 'honest_gaps', q: 'What are his weaknesses?' },
  { id: 'c1', cat: 'comparison', q: 'Compare ProjectHub and the Interactive Pokedex.' },
  { id: 'per1', cat: 'personality', q: 'What would you ask him if you were interviewing him?' },
  { id: 'per2', cat: 'personality', q: 'Is he someone worth interviewing?' },
];

// Three generation configs to test
const CONFIGS = [
  { name: 'A-deterministic', temperature: 0.1, top_p: 0.8, max_new_tokens: 120, repetition_penalty: 1.1 },
  { name: 'B-moderate', temperature: 0.4, top_p: 0.9, max_new_tokens: 120, repetition_penalty: 1.1 },
  { name: 'C-conversational', temperature: 0.6, top_p: 0.95, max_new_tokens: 120, repetition_penalty: 1.05 },
];

async function runEval(tokenizer, model, config) {
  const results = [];
  for (const t of TEST_SET) {
    const sessionId = `stab-${t.id}`;
    try {
      // Get packet
      const packetRes = await fetch(`${SERVER_URL}/api/client-packet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: t.q, sessionId })
      });
      const { runId, packet, fallback } = await packetRes.json();

      // Generate
      const messages = [
        { role: 'system', content: packet.systemPrompt },
        { role: 'user', content: packet.userPrompt }
      ];
      const prompt = tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true });
      const inputs = tokenizer(prompt, { return_tensors: 'cpu', max_length: 512, truncation: true });
      const inputLen = inputs.input_ids.dims[1];

      const genStart = Date.now();
      const output = await model.generate({
        ...inputs,
        max_new_tokens: config.max_new_tokens,
        temperature: config.temperature,
        top_p: config.top_p,
        do_sample: config.temperature > 0,
        repetition_penalty: config.repetition_penalty
      });
      const genMs = Date.now() - genStart;

      const outputLen = output[0].dims[0];
      const genLen = outputLen - inputLen;
      const rawAnswer = tokenizer.decode(Array.from(output[0].data).slice(inputLen), { skip_special_tokens: true }).trim();
      const answer = parseModelOutput(rawAnswer);

      // Validate
      let outcome = 'no_answer';
      let displayedAnswer = fallback;
      if (answer && answer.length >= 3) {
        const valRes = await fetch(`${SERVER_URL}/api/client-validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId, answer, sessionId })
        });
        const validation = await valRes.json();
        if (validation.valid) {
          outcome = 'accepted';
          displayedAnswer = answer;
        } else if (validation.forbidden) {
          outcome = 'unsafe_blocked';
        } else {
          outcome = 'fallback';
        }
      }

      results.push({ ...t, answer: displayedAnswer, outcome, genMs, genLen });
      process.stdout.write(`  ${t.id} [${t.cat}] ${outcome.toUpperCase()} ${genMs}ms\n`);
    } catch (err) {
      results.push({ ...t, outcome: 'error', error: err.message });
      process.stdout.write(`  ${t.id} [${t.cat}] ERROR: ${err.message}\n`);
    }
  }
  return results;
}

async function main() {
  console.log('=== Focused Stability Test ===');
  console.log('Model:', MODEL_ID);
  console.log('Questions:', TEST_SET.length);
  console.log('Configs:', CONFIGS.map(c => c.name).join(', '));
  console.log('Runs per config: 1');
  console.log('');

  const tf = await import('@huggingface/transformers');
  tf.env.allowLocalModels = false;
  tf.env.allowRemoteModels = true;

  console.log('Loading model...');
  const loadStart = Date.now();
  const tokenizer = await tf.AutoTokenizer.from_pretrained(MODEL_ID);
  const model = await tf.AutoModelForCausalLM.from_pretrained(MODEL_ID, { device: 'cpu', dtype: 'q4' });
  const loadMs = Date.now() - loadStart;
  console.log(`Model loaded in ${(loadMs / 1000).toFixed(1)}s\n`);

  const allResults = [];

  for (const config of CONFIGS) {
    console.log(`=== Config: ${config.name} ===`);
    console.log(`  temp=${config.temperature} top_p=${config.top_p} max_tokens=${config.max_new_tokens}`);
    const results = await runEval(tokenizer, model, config);
    const accepted = results.filter(r => r.outcome === 'accepted').length;
    const unsafe = results.filter(r => r.outcome === 'unsafe_blocked').length;
    const fallback = results.filter(r => r.outcome === 'fallback').length;
    const avgMs = results.filter(r => r.genMs).reduce((s, r) => s + r.genMs, 0) / (results.filter(r => r.genMs).length || 1);
    console.log(`  Accepted: ${accepted}/${results.length} (${Math.round(accepted/results.length*100)}%)`);
    console.log(`  Unsafe: ${unsafe}, Fallback: ${fallback}`);
    console.log(`  Avg gen: ${avgMs.toFixed(0)}ms`);
    console.log('');
    allResults.push({ config: config.name, results, accepted, unsafe, fallback, avgMs });
  }

  // Category summary
  console.log('=== Category Summary (across all configs) ===');
  const cats = [...new Set(TEST_SET.map(t => t.cat))];
  for (const cat of cats) {
    const catResults = allResults.flatMap(ar => ar.results.filter(r => r.cat === cat));
    const accepted = catResults.filter(r => r.outcome === 'accepted').length;
    console.log(`${cat}: ${accepted}/${catResults.length} (${Math.round(accepted/catResults.length*100)}%)`);
  }

  // Save
  const outPath = path.join(__dirname, '..', 'data', 'stability-test-results.json');
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main().catch(err => { console.error('Stability test failed:', err); process.exit(1); });
