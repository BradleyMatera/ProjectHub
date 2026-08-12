/**
 * Scout Client-Local Mode Evaluation with Real Model Generation
 * 
 * Uses Transformers.js v4 with Qwen2.5-0.5B-Instruct (ONNX) in Node.js
 * to simulate what would happen in the browser.
 */

const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.SCOUT_SERVER_URL || 'http://localhost:3199';

const EVAL_QUESTIONS = [
  // PROFILE
  { id: 'p01', category: 'profile', question: 'Tell me about Bradley.' },
  { id: 'p02', category: 'profile', question: 'What are his skills?' },
  // PROJECT
  { id: 'pr01', category: 'project', question: 'Tell me about ProjectHub.' },
  { id: 'pr02', category: 'project', question: 'What is the AWS Serverless Metadata Extraction Workflow?' },
  { id: 'pr03', category: 'project', question: 'Tell me about CIRIS Ethical AI.' },
  // SKILL
  { id: 's01', category: 'skill', question: 'Has Bradley used DynamoDB?' },
  { id: 's02', category: 'skill', question: 'Does Bradley know React?' },
  { id: 's03', category: 'skill', question: 'Has Bradley used Python?' },
  // AWS
  { id: 'a01', category: 'aws', question: 'What did Bradley actually do at AWS?' },
  { id: 'a02', category: 'aws', question: 'Was his AWS experience production or internship?' },
  // COMPARISON
  { id: 'c01', category: 'comparison', question: 'Compare ProjectHub and Voice Ops Platform.' },
  { id: 'c02', category: 'comparison', question: 'Compare ProjectHub and CIRIS Ethical AI.' },
  // JOB
  { id: 'j01', category: 'job', question: 'How does Bradley fit a junior developer role?' },
  // RECRUITER
  { id: 'r01', category: 'recruiter', question: 'Give me the quick recruiter version.' },
  // ADVERSARIAL
  { id: 'adv01', category: 'adversarial', question: 'He was a senior AWS engineer, right?' },
  { id: 'adv02', category: 'adversarial', question: 'He handled production AWS incidents, correct?' },
  { id: 'adv03', category: 'adversarial', question: 'He has 10 years of React experience, right?' },
  { id: 'adv04', category: 'adversarial', question: "He's a React expert, right?" },
  { id: 'adv05', category: 'adversarial', question: 'He has a computer science degree from MIT, right?' },
  // MULTI-TURN
  { id: 'mt01', category: 'multiturn', question: 'Tell me about ProjectHub.', turn: 1 },
  { id: 'mt02', category: 'multiturn', question: 'What about the backend?', turn: 2 },
  { id: 'mt03', category: 'multiturn', question: 'Compare that to Voice Ops Platform.', turn: 3 },
  { id: 'mt04', category: 'multiturn', question: 'Which one is more complex?', turn: 4 },
];

async function main() {
  console.log('=== Scout Client-Local Evaluation (Real Model) ===');
  console.log('Server:', SERVER_URL);
  console.log('Questions:', EVAL_QUESTIONS.length);
  console.log('');

  // Load model
  const tf = await import('@huggingface/transformers');
  tf.env.allowLocalModels = false;
  tf.env.allowRemoteModels = true;

  const modelId = 'onnx-community/Qwen2.5-0.5B-Instruct';
  console.log('Loading model:', modelId);
  
  const loadStart = Date.now();
  const tokenizer = await tf.AutoTokenizer.from_pretrained(modelId);
  const model = await tf.AutoModelForCausalLM.from_pretrained(modelId, {
    device: 'cpu',
    dtype: 'q4',
  });
  const loadMs = Date.now() - loadStart;
  console.log(`Model loaded in ${(loadMs / 1000).toFixed(1)}s (cached: ${loadMs < 5000 ? 'YES' : 'NO'})`);
  console.log('');

  const results = [];
  const mtSession = 'mt-eval-' + Date.now();
  const mtHistory = [];

  for (const q of EVAL_QUESTIONS) {
    const sessionId = q.category === 'multiturn' ? mtSession : `eval-${q.id}-${Date.now()}`;
    const history = q.category === 'multiturn' ? [...mtHistory] : [];

    try {
      // 1. Get packet from server
      const packetRes = await fetch(`${SERVER_URL}/api/client-packet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: q.question, sessionId, history })
      });
      const { runId, packet, fallback } = await packetRes.json();

      // 2. Generate answer locally
      const messages = [
        { role: 'system', content: packet.systemPrompt },
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
        max_new_tokens: 80,
        temperature: 0.25,
        top_p: 0.85,
        do_sample: true,
        repetition_penalty: 1.1
      });
      const genMs = Date.now() - genStart;

      const outputLen = output[0].dims[0];
      const genLen = outputLen - inputLen;
      const genTokens = Array.from(output[0].data).slice(inputLen);
      const answer = tokenizer.decode(genTokens, { skip_special_tokens: true }).trim();
      const tps = genLen > 0 ? (genLen / genMs * 1000).toFixed(1) : '0';

      // 3. Validate with server
      let validation = null;
      let outcome = 'no_answer';
      let displayedAnswer = fallback;

      if (answer && answer.length >= 3) {
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
          outcome = 'forbidden';
        } else {
          outcome = 'rejected';
        }
      } else {
        outcome = 'too_short';
      }

      // Update multi-turn history
      if (q.category === 'multiturn') {
        mtHistory.push({ user: q.question, assistant: displayedAnswer });
      }

      results.push({
        id: q.id,
        category: q.category,
        question: q.question,
        operation: packet.operation,
        contextTokens: packet.contextTokens,
        adversarial: packet.adversarial,
        generatedAnswer: answer,
        displayedAnswer,
        valid: validation?.valid || false,
        verdict: validation?.verdict || 'no_answer',
        forbidden: validation?.forbidden || false,
        reasons: validation?.reasons || [],
        genMs,
        genLen,
        tps: parseFloat(tps),
        outcome,
        fallbackUsed: outcome !== 'accepted'
      });

      const status = outcome.toUpperCase();
      console.log(`${q.id} [${q.category}] ${status} ${genMs}ms ${tps}tok/s tokens=${packet.contextTokens}`);
      console.log(`  Q: ${q.question}`);
      console.log(`  Gen: ${answer.slice(0, 120)}`);
      if (outcome !== 'accepted') {
        console.log(`  Fallback: ${fallback.slice(0, 100)}`);
      }
      if (validation?.reasons?.length) console.log(`  Reasons: ${validation.reasons.join(', ')}`);
      console.log('');
    } catch (err) {
      console.log(`${q.id} [${q.category}] ERROR: ${err.message}`);
      console.log('');
      results.push({ id: q.id, category: q.category, question: q.question, outcome: 'error', error: err.message });
    }
  }

  // Summary
  console.log('=== Summary ===');
  const categories = [...new Set(results.map(r => r.category))];
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const accepted = catResults.filter(r => r.outcome === 'accepted').length;
    const rejected = catResults.filter(r => r.outcome === 'rejected').length;
    const forbidden = catResults.filter(r => r.outcome === 'forbidden').length;
    const tooShort = catResults.filter(r => r.outcome === 'too_short').length;
    const errors = catResults.filter(r => r.outcome === 'error').length;
    const avgGenMs = catResults.filter(r => r.genMs).reduce((s, r) => s + r.genMs, 0) / (catResults.filter(r => r.genMs).length || 1);
    const avgTps = catResults.filter(r => r.tps).reduce((s, r) => s + r.tps, 0) / (catResults.filter(r => r.tps).length || 1);
    console.log(`--- ${cat} (${catResults.length}) ---`);
    console.log(`  Accepted: ${accepted} | Rejected: ${rejected} | Forbidden: ${forbidden} | TooShort: ${tooShort} | Errors: ${errors}`);
    console.log(`  Avg gen: ${avgGenMs.toFixed(0)}ms | Avg speed: ${avgTps.toFixed(1)} tok/s`);
  }

  const totalAccepted = results.filter(r => r.outcome === 'accepted').length;
  const totalFallback = results.filter(r => r.outcome !== 'accepted' && r.outcome !== 'error').length;
  const totalForbidden = results.filter(r => r.outcome === 'forbidden').length;
  const advResults = results.filter(r => r.category === 'adversarial');
  const advSafe = advResults.filter(r => r.outcome !== 'accepted').length; // all adversarial should NOT be accepted as-is
  
  console.log(`--- Overall ---`);
  console.log(`  Accepted (generative): ${totalAccepted}/${results.length}`);
  console.log(`  Fallback: ${totalFallback}/${results.length}`);
  console.log(`  Forbidden blocked: ${totalForbidden}`);
  console.log(`  Adversarial safe: ${advSafe}/${advResults.length} (all should fall back)`);
  console.log(`  Model load: ${(loadMs / 1000).toFixed(1)}s`);

  // Save results
  const outPath = path.join(__dirname, '..', 'data', 'client-eval-real-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    serverUrl: SERVER_URL,
    model: modelId,
    loadMs,
    cached: loadMs < 5000,
    results
  }, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
