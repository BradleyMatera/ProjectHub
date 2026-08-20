'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('SCOUT_AGENT_MODE LITE vs FULL validation', () => {
  const serverPath = path.join(__dirname, '..', 'server-gemini.js');
  const serverSrc = fs.readFileSync(serverPath, 'utf8');
  const configPath = path.join(__dirname, '..', 'config', 'scout-release-candidate.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  it('AM1: release candidate declares lite-agent as the production mode', () => {
    assert.equal(config.agentMode, 'lite-agent', 'Release candidate must target the lite agent');
  });

  it('AM2: server default SCOUT_AGENT_MODE is lite when engine is enabled', () => {
    // The default line should prefer 'lite' when SCOUT_AGENT_ENGINE_ENABLED is true.
    assert.ok(
      /SCOUT_AGENT_MODE\s*=\s*process\.env\.SCOUT_AGENT_MODE\s*\|\|\s*\(SCOUT_AGENT_ENGINE_ENABLED\s*\?\s*['"]lite['"]/.test(serverSrc),
      'server-gemini.js must default to LITE when the agent engine is enabled'
    );
  });

  it('AM3: server routes to runLiteAgent when SCOUT_AGENT_MODE is lite', () => {
    assert.ok(serverSrc.includes('SCOUT_AGENT_MODE === \'lite\''), 'Server must select runLiteAgent for lite mode');
    assert.ok(serverSrc.includes('runLiteAgent'), 'Server must call runLiteAgent');
  });

  it('AM4: server does not force FULL mode anywhere in the mode selection', () => {
    // The default line should not hardcode 'full' as the default when engine is enabled.
    assert.ok(!/SCOUT_AGENT_ENGINE_ENABLED\s*\?\s*['"]full['"]/.test(serverSrc),
      'Server must not default to FULL mode when engine is enabled');
  });

  it('AM5: FULL agent engine module exists for development use', () => {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'lib', 'agent-engine.js')), 'lib/agent-engine.js (FULL path) must exist');
    assert.ok(serverSrc.includes('scout-agent-${SCOUT_AGENT_MODE}'), 'Server telemetry must interpolate mode so FULL can be selected');
  });
});
