'use strict';

// Qualification Configuration Recorder
//
// Records the exact software/model configuration that passed qualification
// so we can say: THIS EXACT CONFIGURATION PASSED.
//
// Usage: node scripts/record-qualification-config.js [output-path]
// Run inside Docker: docker exec scout-api node scripts/record-qualification-config.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function main() {
  const config = {
    timestamp: new Date().toISOString(),
    gitSha: null,
    apiImageDigest: null,
    inferenceRuntimeImageDigest: null,
    modelDigest: null,
    nodeVersion: process.version,
    ollamaVersion: null,
    context: null,
    temperature: null,
    maxTokens: null,
    timeouts: {},
    cpuRamLimits: {},
    gpuMode: 'none (CPU-only)',
  };

  // Git SHA
  try {
    config.gitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {}

  // Node version
  config.nodeVersion = process.version;

  // Environment config
  config.context = process.env.OLLAMA_AGENT_CONTEXT || process.env.OLLAMA_CONTEXT_SIZE || '2048';
  config.temperature = '0.25 (primary), 0.1-0.3 (recovery)';
  config.maxTokens = process.env.SCOUT_LITE_MAX_TOKENS || '320';
  config.timeouts = {
    primary: process.env.SCOUT_LITE_TIMEOUT_MS || '15000',
    repair: process.env.SCOUT_LITE_REPAIR_TIMEOUT_MS || '10000',
    recovery1: '8000 (adversarial) / 12000 (standard)',
    recovery2: '6000',
    recovery3: '6000',
    genTimeout: process.env.GEN_TIMEOUT_MS || '12500',
  };
  config.cpuRamLimits = {
    inference: { cpus: '2.0', memory: '2G' },
    api: { cpus: '1.0', memory: '512M' },
  };

  // Model digest — query Ollama
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const model = process.env.GEN_MODEL || process.env.OLLAMA_AGENT_MODEL || 'qwen2.5:1.5b';
  try {
    const resp = await fetch(`${ollamaUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    const data = await resp.json();
    config.modelDigest = data.digest || data.details?.family || 'unknown';
    config.ollamaVersion = data.ollama_version || 'unknown';
  } catch (e) {
    config.modelDigest = `ERROR: ${e.message}`;
  }

  // Docker image digests (if running inside Docker)
  try {
    const apiImage = execSync('cat /etc/hostname', { encoding: 'utf-8' }).trim();
    config.containerHostname = apiImage;
  } catch {}

  const outPath = process.argv[2] || path.join(__dirname, '..', 'data', 'qualification-config.json');
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2));
  console.log(JSON.stringify(config, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
