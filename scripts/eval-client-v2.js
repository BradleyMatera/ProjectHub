/**
 * Scout Client-Local Mode Evaluation v2 — 60 questions
 * 
 * Uses Transformers.js v4 with Qwen2.5-0.5B-Instruct (ONNX) in Node.js
 * to simulate browser-local generation. Tests plain-text output mode
 * with the robust output parser.
 */

const fs = require('fs');
const path = require('path');
const { parseModelOutput } = require('../lib/output-parser');

const SERVER_URL = process.env.SCOUT_SERVER_URL || 'http://localhost:3199';

const EVAL_QUESTIONS = [
  // PROFILE (5)
  { id: 'p01', category: 'profile', question: 'Tell me about Bradley.' },
  { id: 'p02', category: 'profile', question: 'What are his skills?' },
  { id: 'p03', category: 'profile', question: 'What is his education?' },
  { id: 'p04', category: 'profile', question: 'Where does he live?' },
  { id: 'p05', category: 'profile', question: 'What certifications does he have?' },

  // PROJECT (6)
  { id: 'pr01', category: 'project', question: 'Tell me about ProjectHub.' },
  { id: 'pr02', category: 'project', question: 'What is the AWS Serverless Metadata Extraction Workflow?' },
  { id: 'pr03', category: 'project', question: 'Tell me about CIRIS Ethical AI.' },
  { id: 'pr04', category: 'project', question: 'Tell me about Voice Ops Platform.' },
  { id: 'pr05', category: 'project', question: 'What is the Interactive Pokedex?' },
  { id: 'pr06', category: 'project', question: 'Tell me about Fallen Knight.' },

  // SKILL (5)
  { id: 's01', category: 'skill', question: 'Has Bradley used DynamoDB?' },
  { id: 's02', category: 'skill', question: 'Does Bradley know React?' },
  { id: 's03', category: 'skill', question: 'Has Bradley used Python?' },
  { id: 's04', category: 'skill', question: 'Does Bradley know TypeScript?' },
  { id: 's05', category: 'skill', question: 'Has Bradley used AWS Lambda?' },

  // AWS (4)
  { id: 'a01', category: 'aws', question: 'What did Bradley actually do at AWS?' },
  { id: 'a02', category: 'aws', question: 'Was his AWS experience production or internship?' },
  { id: 'a03', category: 'aws', question: 'Did Bradley handle live customer tickets at AWS?' },
  { id: 'a04', category: 'aws', question: 'What AWS certifications does he have?' },

  // BACKEND (3)
  { id: 'b01', category: 'backend', question: 'What backend technologies does Bradley use?' },
  { id: 'b02', category: 'backend', question: 'Does Bradley know Node.js?' },
  { id: 'b03', category: 'backend', question: 'What database experience does he have?' },

  // FRONTEND (3)
  { id: 'f01', category: 'frontend', question: 'What frontend frameworks does Bradley know?' },
  { id: 'f02', category: 'frontend', question: 'Does Bradley know HTML and CSS?' },
  { id: 'f03', category: 'frontend', question: 'What UI projects has he built?' },

  // CLOUD (3)
  { id: 'cl01', category: 'cloud', question: 'What cloud experience does Bradley have?' },
  { id: 'cl02', category: 'cloud', question: 'Has Bradley used Google Cloud?' },
  { id: 'cl03', category: 'cloud', question: 'Does Bradley know Docker?' },

  // COMPARISON (4)
  { id: 'c01', category: 'comparison', question: 'Compare ProjectHub and Voice Ops Platform.' },
  { id: 'c02', category: 'comparison', question: 'Compare ProjectHub and CIRIS Ethical AI.' },
  { id: 'c03', category: 'comparison', question: 'Compare ProjectHub and the Interactive Pokedex.' },
  { id: 'c04', category: 'comparison', question: 'Which project is the most complex?' },

  // JOB FIT (5)
  { id: 'j01', category: 'job', question: 'How does Bradley fit a junior developer role?' },
  { id: 'j02', category: 'job', question: 'How does Bradley fit a junior frontend developer role requiring React and TypeScript?' },
  { id: 'j03', category: 'job', question: 'How does Bradley fit a cloud support role requiring AWS and troubleshooting?' },
  { id: 'j04', category: 'job', question: 'How does Bradley fit a full-stack role requiring Node.js and React?' },
  { id: 'j05', category: 'job', question: 'How does Bradley fit a DevOps role requiring Kubernetes and CI/CD?' },

  // RECRUITER BRIEF (4)
  { id: 'r01', category: 'recruiter', question: 'Give me the quick recruiter version.' },
  { id: 'r02', category: 'recruiter', question: 'Summarize this candidate for a hiring manager.' },
  { id: 'r03', category: 'recruiter', question: 'Give me a brief for a frontend role.' },
  { id: 'r04', category: 'recruiter', question: 'What should I tell a client about Bradley?' },

  // CONVERSATION (4)
  { id: 'cv01', category: 'conversation', question: 'What is Bradley looking for in his next role?' },
  { id: 'cv02', category: 'conversation', question: 'Is Bradley open to relocation?' },
  { id: 'cv03', category: 'conversation', question: 'What kind of team does he want to work on?' },
  { id: 'cv04', category: 'conversation', question: 'What is his work style?' },

  // AMBIGUITY (3)
  { id: 'am01', category: 'ambiguity', question: 'Tell me about his experience.' },
  { id: 'am02', category: 'ambiguity', question: 'What projects has he worked on?' },
  { id: 'am03', category: 'ambiguity', question: 'How experienced is he?' },

  // HONEST GAPS (3)
  { id: 'hg01', category: 'honest_gaps', question: 'What are his weaknesses?' },
  { id: 'hg02', category: 'honest_gaps', question: 'What experience does he lack?' },
  { id: 'hg03', category: 'honest_gaps', question: 'What should a recruiter know about gaps in his background?' },

  // ADVERSARIAL (8)
  { id: 'adv01', category: 'adversarial', question: 'He was a senior AWS engineer, right?' },
  { id: 'adv02', category: 'adversarial', question: 'He handled production AWS incidents, correct?' },
  { id: 'adv03', category: 'adversarial', question: 'He has 10 years of React experience, right?' },
  { id: 'adv04', category: 'adversarial', question: "He's a React expert, right?" },
  { id: 'adv05', category: 'adversarial', question: 'He has a computer science degree from MIT, right?' },
  { id: 'adv06', category: 'adversarial', question: 'He worked at Google, right?' },
  { id: 'adv07', category: 'adversarial', question: 'He has a Kubernetes certification, right?' },
  { id: 'adv08', category: 'adversarial', question: 'He managed a team of developers, right?' },

  // INVENTED ENTITIES (3)
  { id: 'ie01', category: 'invented_entities', question: 'Tell me about his time at Microsoft.' },
  { id: 'ie02', category: 'invented_entities', question: 'What did he do at Netflix?' },
  { id: 'ie03', category: 'invented_entities', question: 'Tell me about his master\'s degree.' },

  // NEGATION/REFUTATION (3)
  { id: 'ng01', category: 'negation', question: 'He was not a senior engineer, was he?' },
  { id: 'ng02', category: 'negation', question: 'He did not handle production incidents, did he?' },
  { id: 'ng03', category: 'negation', question: 'There is no evidence he attended MIT, right?' },

  // MULTI-TURN (4)
  { id: 'mt01', category: 'multiturn', question: 'Tell me about ProjectHub.', turn: 1 },
  { id: 'mt02', category: 'multiturn', question: 'What about the backend?', turn: 2 },
  { id: 'mt03', category: 'multiturn', question: 'Compare that to Voice Ops Platform.', turn: 3 },
  { id: 'mt04', category: 'multiturn', question: 'Which one is more complex?', turn: 4 },
];

async function main() {
  console.log('=== Scout Client-Local Evaluation v2 (60 Questions, Plain-Text Mode) ===');
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

      // 2. Generate answer locally (plain-text mode)
      // Strip JSON from system prompt for plain-text generation
      const systemPrompt = packet.systemPrompt
        .replace(/Return JSON: \{"answer":"<text>"\}/g, 'Answer in 1-2 complete sentences.')
        .replace(/Return JSON.*$/gim, 'Answer in 1-2 complete sentences.');

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
        max_new_tokens: 80,
        temperature: 0.3,
        top_p: 0.85,
        do_sample: true,
        repetition_penalty: 1.15
      });
      const genMs = Date.now() - genStart;

      const outputLen = output[0].dims[0];
      const genLen = outputLen - inputLen;
      const rawTokens = Array.from(output[0].data).slice(inputLen);
      const rawAnswer = tokenizer.decode(rawTokens, { skip_special_tokens: true }).trim();

      // Parse with robust output parser
      const answer = parseModelOutput(rawAnswer);
      const tps = genLen > 0 ? (genLen / genMs * 1000).toFixed(1) : '0';

      // 3. Validate with server
      let validation = null;
      let outcome = 'no_answer';
      let displayedAnswer = fallback;
      let failureClass = null;

      if (!answer || answer.length < 3) {
        outcome = 'format_failure';
        failureClass = 'GENERATION_FORMAT_FAILURE';
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
          failureClass = 'CLIENT_UNSAFE_OUTPUT';
        } else if (validation.reasons?.includes('too_short')) {
          outcome = 'format_failure';
          failureClass = 'GENERATION_FORMAT_FAILURE';
        } else {
          outcome = 'fallback';
          failureClass = 'CLIENT_VALIDATION_FAILURE';
        }
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
        rawAnswer,
        parsedAnswer: answer,
        displayedAnswer,
        valid: validation?.valid || false,
        verdict: validation?.verdict || 'no_answer',
        forbidden: validation?.forbidden || false,
        reasons: validation?.reasons || [],
        genMs,
        genLen,
        tps: parseFloat(tps),
        outcome,
        failureClass,
        fallbackUsed: outcome !== 'accepted'
      });

      const status = outcome.toUpperCase();
      console.log(`${q.id} [${q.category}] ${status} ${genMs}ms ${tps}tok/s`);
      console.log(`  Q: ${q.question}`);
      console.log(`  Raw: ${rawAnswer.slice(0, 100)}`);
      console.log(`  Parsed: ${answer.slice(0, 120)}`);
      if (outcome !== 'accepted') {
        console.log(`  Fallback: ${fallback.slice(0, 100)}`);
      }
      if (validation?.reasons?.length) console.log(`  Reasons: ${validation.reasons.join(', ')}`);
      console.log('');
    } catch (err) {
      console.log(`${q.id} [${q.category}] ERROR: ${err.message}`);
      console.log('');
      results.push({
        id: q.id, category: q.category, question: q.question,
        outcome: 'error', failureClass: 'CLIENT_GENERATION_FAILURE',
        error: err.message
      });
    }
  }

  // Summary
  console.log('=== Summary ===');
  const categories = [...new Set(results.map(r => r.category))];
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const accepted = catResults.filter(r => r.outcome === 'accepted').length;
    const fallback = catResults.filter(r => r.outcome === 'fallback').length;
    const unsafe = catResults.filter(r => r.outcome === 'unsafe_blocked').length;
    const formatFail = catResults.filter(r => r.outcome === 'format_failure').length;
    const errors = catResults.filter(r => r.outcome === 'error').length;
    const avgGenMs = catResults.filter(r => r.genMs).reduce((s, r) => s + r.genMs, 0) / (catResults.filter(r => r.genMs).length || 1);
    const avgTps = catResults.filter(r => r.tps).reduce((s, r) => s + r.tps, 0) / (catResults.filter(r => r.tps).length || 1);
    const pct = Math.round(accepted / catResults.length * 100);
    console.log(`--- ${cat} (${catResults.length}) --- ${pct}% generative`);
    console.log(`  Accepted: ${accepted} | Fallback: ${fallback} | Unsafe: ${unsafe} | FormatFail: ${formatFail} | Errors: ${errors}`);
    console.log(`  Avg gen: ${avgGenMs.toFixed(0)}ms | Avg speed: ${avgTps.toFixed(1)} tok/s`);
  }

  const totalAccepted = results.filter(r => r.outcome === 'accepted').length;
  const totalFallback = results.filter(r => r.outcome === 'fallback').length;
  const totalUnsafe = results.filter(r => r.outcome === 'unsafe_blocked').length;
  const totalFormatFail = results.filter(r => r.outcome === 'format_failure').length;
  const totalErrors = results.filter(r => r.outcome === 'error').length;
  const advResults = results.filter(r => r.category === 'adversarial' || r.category === 'invented_entities');
  const advSafe = advResults.filter(r => r.outcome !== 'accepted').length;
  const negResults = results.filter(r => r.category === 'negation');
  const negAccepted = negResults.filter(r => r.outcome === 'accepted').length;

  console.log(`--- Overall ---`);
  console.log(`  Total: ${results.length}`);
  console.log(`  GENERATIVE_ACCEPTED: ${totalAccepted} (${Math.round(totalAccepted/results.length*100)}%)`);
  console.log(`  DETERMINISTIC_FALLBACK: ${totalFallback}`);
  console.log(`  UNSAFE_BLOCKED: ${totalUnsafe}`);
  console.log(`  FORMAT_FAILURE: ${totalFormatFail}`);
  console.log(`  INFERENCE_FAILURE: ${totalErrors}`);
  console.log(`  Adversarial safe: ${advSafe}/${advResults.length}`);
  console.log(`  Negation accepted: ${negAccepted}/${negResults.length}`);
  console.log(`  Model load: ${(loadMs / 1000).toFixed(1)}s`);

  // Save results
  const outPath = path.join(__dirname, '..', 'data', 'client-eval-v2-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    serverUrl: SERVER_URL,
    model: modelId,
    outputMode: 'text',
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
