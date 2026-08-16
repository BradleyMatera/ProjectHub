'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Release Config Validation', () => {
  const configPath = path.join(__dirname, '..', 'config', 'scout-release-candidate.json');
  let config;

  it('RC1: config file exists', () => {
    assert.ok(fs.existsSync(configPath), 'config/scout-release-candidate.json must exist');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  });

  it('RC2: releaseDate is 2026-08-16', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.releaseDate, '2026-08-16');
  });

  it('RC3: maximumDeadlineMs is 15000', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.maximumDeadlineMs, 15000);
  });

  it('RC4: provider is cloudflare', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.provider, 'cloudflare');
  });

  it('RC5: model is @cf/meta/llama-3.2-3b-instruct', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.model, '@cf/meta/llama-3.2-3b-instruct');
  });

  it('RC6: spendingPolicy is FREE_ONLY', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.spendingPolicy, 'FREE_ONLY');
  });

  it('RC7: deterministicProse is false', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.recoveryStrategy.deterministicProse, false);
  });

  it('RC8: fallbackBehavior is TECHNICAL_FAILURE', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.recoveryStrategy.fallbackBehavior, 'TECHNICAL_FAILURE');
  });

  it('RC9: entitySemanticsVersion is 4-way-v1', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.entitySemanticsVersion, '4-way-v1');
  });

  it('RC10: policyModes includes NORMAL, REFUSAL, OUT_OF_SCOPE', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(config.policyModes.includes('NORMAL'));
    assert.ok(config.policyModes.includes('REFUSAL'));
    assert.ok(config.policyModes.includes('OUT_OF_SCOPE'));
  });

  it('RC11: deprecatedModels includes qwen2.5:0.5b', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(config.deprecatedModels.includes('qwen2.5:0.5b'));
  });

  it('RC12: productionEligibleModels only contains cloudflare 3b', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.productionEligibleModels, ['@cf/meta/llama-3.2-3b-instruct']);
  });

  it('RC13: no secrets in config', () => {
    config = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const str = JSON.stringify(config);
    assert.ok(!str.includes('API_TOKEN'), 'Config must not contain API tokens');
    assert.ok(!str.includes('API_KEY'), 'Config must not contain API keys');
    assert.ok(!str.includes('SECRET'), 'Config must not contain secrets');
    assert.ok(!str.includes('PASSWORD'), 'Config must not contain passwords');
  });

  it('RC14: deadline cap enforced in server-gemini.js', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server-gemini.js'), 'utf8');
    assert.ok(server.includes('Math.min(parseInt(process.env.REQUEST_DEADLINE_MS'),
      'server-gemini.js must cap REQUEST_DEADLINE_MS at 15000');
  });

  it('RC15: deadline cap enforced in eval script', () => {
    const evalScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'eval-cloudflare-qualification.js'), 'utf8');
    assert.ok(evalScript.includes('15000'),
      'eval script must cap deadline at 15000');
  });
});
