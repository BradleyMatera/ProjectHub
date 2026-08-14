'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// Qualification configuration test — ensures context alignment between
// SCOUT_LITE_NUM_CTX and OLLAMA_AGENT_CONTEXT to prevent model reloads.
// A mismatch causes Ollama to reload the model (~4s on 4-vCPU) when
// recovery/repair paths fall back to OLLAMA_AGENT_CONTEXT instead of
// using the explicit numCtx from SCOUT_LITE_NUM_CTX.

test('SCOUT_LITE_NUM_CTX equals OLLAMA_AGENT_CONTEXT when both set', () => {
  const liteCtx = parseInt(process.env.SCOUT_LITE_NUM_CTX || '1536', 10);
  const agentCtx = parseInt(process.env.OLLAMA_AGENT_CONTEXT || '1536', 10);
  assert.equal(liteCtx, agentCtx,
    `Context mismatch: SCOUT_LITE_NUM_CTX=${liteCtx} but OLLAMA_AGENT_CONTEXT=${agentCtx}. ` +
    'Recovery/repair paths that do not pass numCtx explicitly fall back to OLLAMA_AGENT_CONTEXT, ' +
    'triggering a model reload when these differ.');
});

test('SCOUT_LITE_NUM_CTX is within valid range for qwen2.5:1.5b', () => {
  const liteCtx = parseInt(process.env.SCOUT_LITE_NUM_CTX || '1536', 10);
  assert.ok(liteCtx >= 512 && liteCtx <= 4096,
    `SCOUT_LITE_NUM_CTX=${liteCtx} is outside valid range [512, 4096] for qwen2.5:1.5b`);
});

test('OLLAMA_AGENT_CONTEXT is within valid range for qwen2.5:1.5b', () => {
  const agentCtx = parseInt(process.env.OLLAMA_AGENT_CONTEXT || '1536', 10);
  assert.ok(agentCtx >= 512 && agentCtx <= 4096,
    `OLLAMA_AGENT_CONTEXT=${agentCtx} is outside valid range [512, 4096] for qwen2.5:1.5b`);
});

test('REQUEST_DEADLINE_MS is exactly 15000', () => {
  const deadline = parseInt(process.env.REQUEST_DEADLINE_MS || '15000', 10);
  assert.equal(deadline, 15000,
    `REQUEST_DEADLINE_MS=${deadline} must be 15000. The 15-second deadline is a hard product requirement.`);
});
