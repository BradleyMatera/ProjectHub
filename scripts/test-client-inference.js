/**
 * Node.js test for Transformers.js v4 with Qwen2.5-0.5B-Instruct
 * Tests model loading, generation speed, and Scout packet flow.
 * 
 * This simulates what the browser would do, but in Node.js
 * where we can measure timing precisely.
 */

const path = require('path');

async function main() {
  console.log('=== Transformers.js v4 Node.js Test ===');
  console.log('Model: Qwen2.5-0.5B-Instruct (ONNX)');
  console.log('');

  // Dynamically import transformers.js
  const tf = await import('@huggingface/transformers');
  console.log('Transformers.js version:', tf.env.version || '4.2.0');

  tf.env.allowLocalModels = false;
  tf.env.allowRemoteModels = true;

  const modelId = 'onnx-community/Qwen2.5-0.5B-Instruct';
  
  // Try WebGPU first (Node.js can use it on some platforms)
  let device = 'cpu';
  let dtype = 'q4';
  
  // Check if we can use WebGPU in Node
  try {
    const { default: ort } = await import('onnxruntime-node');
    // Just use CPU/WASM for now
    device = 'cpu';
    dtype = 'q4';
  } catch {}

  console.log(`Device: ${device}`);
  console.log(`Dtype: ${dtype}`);
  console.log('');

  // Load tokenizer
  console.log('Loading tokenizer...');
  const t0 = Date.now();
  const tokenizer = await tf.AutoTokenizer.from_pretrained(modelId);
  console.log(`Tokenizer loaded in ${Date.now() - t0}ms`);

  // Load model
  console.log('Loading model (may download on first use)...');
  const t1 = Date.now();
  const model = await tf.AutoModelForCausalLM.from_pretrained(modelId, {
    device: device,
    dtype: dtype,
  });
  const loadMs = Date.now() - t1;
  console.log(`Model loaded in ${(loadMs / 1000).toFixed(1)}s`);
  console.log('');

  // Test generation with a Scout-like prompt
  console.log('=== Test Generation ===');
  const messages = [
    { role: 'system', content: 'You are Scout for Bradley Matera. Answer from FACTS only. 1-2 sentences. Return JSON: {"answer":"<text>"}' },
    { role: 'user', content: 'Q: Has Bradley used DynamoDB?\n\nFACTS: Bradley DynamoDB evidence: direct. Used in AWS internship capstone with Lambda, DynamoDB, S3.' }
  ];

  const prompt = tokenizer.apply_chat_template(messages, {
    tokenize: false,
    add_generation_prompt: true
  });
  console.log(`Prompt length: ${prompt.length} chars`);

  const inputs = tokenizer(prompt, {
    return_tensors: 'cpu',
    max_length: 512,
    truncation: true
  });

  console.log('Generating...');
  const t2 = Date.now();
  const output = await model.generate({
    ...inputs,
    max_new_tokens: 60,
    temperature: 0.25,
    top_p: 0.85,
    do_sample: true,
    repetition_penalty: 1.1
  });
  const genMs = Date.now() - t2;

  const inputLen = inputs.input_ids.dims()[1];
  const generatedTokens = output[0].slice(null, [inputLen, null]);
  const answer = tokenizer.decode(generatedTokens, { skip_special_tokens: true }).trim();

  const tokenCount = output[0].dims()[1] - inputLen;
  const tps = (tokenCount / genMs) * 1000;

  console.log(`Generation: ${(genMs / 1000).toFixed(1)}s for ${tokenCount} tokens (${tps.toFixed(1)} tok/s)`);
  console.log(`Answer: ${answer}`);
  console.log('');

  // Test with Scout server packet
  console.log('=== Scout Server Packet Test ===');
  const SERVER_URL = 'http://localhost:3199';
  
  const packetRes = await fetch(`${SERVER_URL}/api/client-packet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Has Bradley used DynamoDB?', sessionId: 'node-test' })
  });
  const { runId, packet, fallback } = await packetRes.json();
  console.log(`Packet: tokens=${packet.contextTokens} operation=${packet.operation}`);

  const scoutMessages = [
    { role: 'system', content: packet.systemPrompt },
    { role: 'user', content: packet.userPrompt }
  ];
  const scoutPrompt = tokenizer.apply_chat_template(scoutMessages, {
    tokenize: false,
    add_generation_prompt: true
  });
  const scoutInputs = tokenizer(scoutPrompt, {
    return_tensors: 'cpu',
    max_length: 512,
    truncation: true
  });

  const t3 = Date.now();
  const scoutOutput = await model.generate({
    ...scoutInputs,
    max_new_tokens: 80,
    temperature: 0.25,
    top_p: 0.85,
    do_sample: true,
    repetition_penalty: 1.1
  });
  const scoutGenMs = Date.now() - t3;

  const scoutInputLen = scoutInputs.input_ids.dims()[1];
  const scoutGenTokens = scoutOutput[0].slice(null, [scoutInputLen, null]);
  const scoutAnswer = tokenizer.decode(scoutGenTokens, { skip_special_tokens: true }).trim();
  const scoutTokenCount = scoutOutput[0].dims()[1] - scoutInputLen;
  const scoutTps = (scoutTokenCount / scoutGenMs) * 1000;

  console.log(`Scout generation: ${(scoutGenMs / 1000).toFixed(1)}s for ${scoutTokenCount} tokens (${scoutTps.toFixed(1)} tok/s)`);
  console.log(`Scout answer: ${scoutAnswer}`);

  // Validate with server
  const valRes = await fetch(`${SERVER_URL}/api/client-validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, answer: scoutAnswer, sessionId: 'node-test' })
  });
  const validation = await valRes.json();
  console.log(`Validation: valid=${validation.valid} verdict=${validation.verdict}`);
  if (validation.reasons?.length) console.log(`Reasons: ${validation.reasons.join(', ')}`);
  console.log('');

  // Summary
  console.log('=== Summary ===');
  console.log(`Model load: ${(loadMs / 1000).toFixed(1)}s`);
  console.log(`First generation: ${(genMs / 1000).toFixed(1)}s (${tps.toFixed(1)} tok/s)`);
  console.log(`Scout generation: ${(scoutGenMs / 1000).toFixed(1)}s (${scoutTps.toFixed(1)} tok/s)`);
  console.log(`Validation: ${validation.valid ? 'PASSED' : 'FAILED'}`);
  console.log(`Device: ${device} / Dtype: ${dtype}`);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
