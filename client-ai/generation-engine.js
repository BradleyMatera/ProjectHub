/**
 * Scout Client-Local Generation Engine
 *
 * Runs Qwen2.5-0.5B-Instruct directly in the browser using Transformers.js v4
 * with WebGPU acceleration. Falls back to WASM if WebGPU is unavailable.
 *
 * Architecture:
 *   1. Server prepares compact evidence packet (/api/client-packet)
 *   2. Browser generates answer locally using this engine
 *   3. Server validates answer against same evidence (/api/client-validate)
 *   4. Browser displays only validated answers
 *
 * Trust boundary:
 *   - Server is authoritative for evidence, tools, knowledge, session state
 *   - Browser only GENERATES over a server-prepared packet
 *   - Browser-generated answers are NEVER displayed without server validation
 *   - Browser cannot invoke tools or modify server state
 */

// --- Output Parser (inlined for browser use) ---
// Robust extraction of answer text from small-model output.
function parseModelOutput(raw) {
  if (!raw) return '';
  let text = String(raw).trim();
  if (!text) return '';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Try JSON {"answer":"..."}
  const match = text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    return cleanAnswerText(match[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim());
  }
  // Try JSON repair
  if (text.startsWith('{') || text.includes('"answer"')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (parsed && parsed.answer) return cleanAnswerText(parsed.answer);
      } catch {
        try {
          const repaired = JSON.parse(text.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
          if (repaired && repaired.answer) return cleanAnswerText(repaired.answer);
        } catch {}
      }
    }
  }
  // Plain text — strip common preambles
  return cleanAnswerText(text
    .replace(/^(?:here(?:'s| is) the answer\s*[::]?\s*)/i, '')
    .replace(/^(?:based on the (?:facts|evidence|information)\s*(?:provided|given)?\s*[::]?\s*)/i, '')
    .replace(/^(?:answer\s*[::]\s*)/i, '')
    .trim());
}

function cleanAnswerText(text) {
  if (!text) return '';
  let cleaned = String(text).trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) cleaned += '.';
  return cleaned;
}

class ScoutGenerationEngine {
  constructor() {
    this.model = null;
    this.tokenizer = null;
    this.initialized = false;
    this.initPromise = null;
    this.device = null;
    this.modelId = 'onnx-community/Qwen2.5-0.5B-Instruct';
    this.initProgress = 0;
    this.initStatus = 'idle';
    this.error = null;
    this.metrics = {
      downloadMs: 0,
      initMs: 0,
      generateMs: 0,
      tokensPerSec: 0,
      cacheHit: false
    };
  }

  /**
   * Check if WebGPU is available in this browser.
   */
  static async checkWebGPU() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    } catch {
      return false;
    }
  }

  /**
   * Check if this engine can run in the current browser.
   */
  static async checkCapability() {
    const webgpu = await ScoutGenerationEngine.checkWebGPU();
    const wasm = typeof WebAssembly !== 'undefined';
    return {
      webgpu,
      wasm,
      supported: webgpu || wasm,
      device: webgpu ? 'webgpu' : (wasm ? 'wasm' : 'none')
    };
  }

  /**
   * Initialize the model. Downloads model files on first use,
   * loads from browser cache on subsequent uses.
   *
   * @param {function} onProgress - callback for progress updates
   * @returns {Promise<void>}
   */
  async initialize(onProgress) {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInitialize(onProgress);
    return this.initPromise;
  }

  async _doInitialize(onProgress) {
    const startInit = performance.now();
    try {
      this.initStatus = 'checking';
      const cap = await ScoutGenerationEngine.checkCapability();
      if (!cap.supported) {
        throw new Error('No supported inference backend (WebGPU or WASM required)');
      }

      this.device = cap.device;
      this.initStatus = 'loading-runtime';
      if (onProgress) onProgress({ status: 'loading-runtime', progress: 0.05 });

      // Dynamically import Transformers.js v4
      const transformers = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0');

      // Configure for browser use
      transformers.env.allowLocalModels = false;
      transformers.env.allowRemoteModels = true;

      this.initStatus = 'loading-model';
      if (onProgress) onProgress({ status: 'loading-model', progress: 0.1 });

      const downloadStart = performance.now();

      // Load tokenizer
      this.tokenizer = await transformers.AutoTokenizer.from_pretrained(this.modelId);

      // Load model with appropriate device and quantization
      const modelConfig = {
        device: this.device,
        dtype: this.device === 'webgpu' ? 'q4f16' : 'q4',
      };

      this.model = await transformers.AutoModelForCausalLM.from_pretrained(
        this.modelId,
        modelConfig
      );

      this.metrics.downloadMs = performance.now() - downloadStart;
      this.metrics.cacheHit = this.metrics.downloadMs < 2000; // likely cached if fast

      this.initStatus = 'ready';
      this.metrics.initMs = performance.now() - startInit;
      this.initialized = true;
      if (onProgress) onProgress({ status: 'ready', progress: 1.0 });

    } catch (err) {
      this.initStatus = 'error';
      this.error = err.message;
      console.error('ScoutGenerationEngine init failed:', err);
      throw err;
    }
  }

  /**
   * Generate an answer from a server-prepared packet.
   * Uses the output parser to handle JSON, malformed JSON, and plain text.
   *
   * @param {object} packet - Server-prepared evidence packet
   * @param {object} options - Generation options (outputMode: 'json'|'text')
   * @returns {Promise<string>} - Generated answer text (parsed)
   */
  async generate(packet, options = {}) {
    if (!this.initialized) {
      throw new Error('Engine not initialized. Call initialize() first.');
    }

    const genStart = performance.now();
    const maxNewTokens = options.maxNewTokens || 80;
    const temperature = options.temperature ?? 0.25;
    const outputMode = options.outputMode || 'text'; // 'text' is default (better for small models)

    try {
      // Build chat messages from the packet
      // If outputMode is 'text', strip JSON instructions from the system prompt
      let systemPrompt = packet.systemPrompt;
      if (outputMode === 'text') {
        systemPrompt = systemPrompt
          .replace(/Return JSON: \{"answer":"<text>"\}/gi, 'Answer in 1-2 sentences.')
          .replace(/Return JSON.*$/gim, 'Answer in 1-2 sentences.');
      }
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: packet.userPrompt }
      ];

      // Apply chat template
      const prompt = this.tokenizer.apply_chat_template(messages, {
        tokenize: false,
        add_generation_prompt: true
      });

      // Tokenize input
      const inputs = this.tokenizer(prompt, {
        return_tensors: this.device === 'webgpu' ? 'webgpu' : 'cpu',
        max_length: 512,
        truncation: true
      });

      // Generate
      const output = await this.model.generate({
        ...inputs,
        max_new_tokens: maxNewTokens,
        temperature: temperature,
        top_p: 0.85,
        do_sample: temperature > 0,
        repetition_penalty: 1.1
      });

      // Decode output (skip input tokens)
      const inputLen = inputs.input_ids.dims()[1];
      const generatedTokens = output[0].slice(null, [inputLen, null]);
      const rawAnswer = this.tokenizer.decode(generatedTokens, { skip_special_tokens: true }).trim();

      // Parse the model output using the robust output parser
      // This handles JSON, malformed JSON, plain text, and preamble stripping
      const answer = parseModelOutput(rawAnswer);

      this.metrics.generateMs = performance.now() - genStart;
      const tokenCount = output[0].dims()[1] - inputLen;
      if (tokenCount > 0 && this.metrics.generateMs > 0) {
        this.metrics.tokensPerSec = (tokenCount / this.metrics.generateMs) * 1000;
      }

      return answer;
    } catch (err) {
      console.error('ScoutGenerationEngine generate failed:', err);
      throw err;
    }
  }

  /**
   * Full client-local flow: get packet from server, generate, validate.
   *
   * @param {string} message - User question
   * @param {string} sessionId - Session ID
   * @param {string} serverUrl - Server base URL
   * @param {object} history - Conversation history
   * @returns {Promise<object>} - Result with answer, validated, fallback
   */
  async ask(message, sessionId, serverUrl, history = []) {
    // 1. Get evidence packet from server
    const packetRes = await fetch(`${serverUrl}/api/client-packet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId, history })
    });
    if (!packetRes.ok) throw new Error(`Packet request failed: ${packetRes.status}`);
    const { runId, packet, fallback } = await packetRes.json();

    // 2. Generate answer locally (use plain-text mode for better small-model output)
    let generatedAnswer = null;
    let generateError = null;
    try {
      generatedAnswer = await this.generate(packet, { outputMode: 'text' });
    } catch (err) {
      generateError = err.message;
    }

    // If generation failed, return fallback
    if (!generatedAnswer || generatedAnswer.length < 3) {
      return {
        answer: fallback,
        source: 'deterministic_fallback',
        validated: true,
        runId,
        error: generateError || 'Generation too short'
      };
    }

    // 3. Validate answer on server
    const validateRes = await fetch(`${serverUrl}/api/client-validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, answer: generatedAnswer, sessionId })
    });
    if (!validateRes.ok) throw new Error(`Validation request failed: ${validateRes.status}`);
    const validation = await validateRes.json();

    // 4. Return validated or fallback answer
    if (validation.valid) {
      return {
        answer: generatedAnswer,
        source: 'client_local',
        validated: true,
        runId,
        validation
      };
    } else {
      return {
        answer: fallback,
        source: 'deterministic_fallback',
        validated: true,
        runId,
        validation,
        generatedAnswer // for debugging
      };
    }
  }

  /**
   * Get current metrics.
   */
  getMetrics() {
    return { ...this.metrics, initialized: this.initialized, device: this.device };
  }

  /**
   * Check if engine is ready.
   */
  isReady() {
    return this.initialized;
  }

  /**
   * Get initialization status.
   */
  getStatus() {
    return this.initStatus;
  }
}

// Export for use in browser
if (typeof window !== 'undefined') {
  window.ScoutGenerationEngine = ScoutGenerationEngine;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScoutGenerationEngine;
}
