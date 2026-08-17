'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const agentFallback = require('../lib/agent-fallback');

test('agent-fallback no longer exports deterministic prose authors', () => {
  assert.equal(typeof agentFallback.buildDeterministicAgentResult, 'undefined',
    'buildDeterministicAgentResult must be removed');
  assert.equal(typeof agentFallback.parseLocalStyleResponse, 'undefined',
    'parseLocalStyleResponse must be removed');
  assert.equal(typeof agentFallback.shouldUseDeterministicAgent, 'undefined',
    'shouldUseDeterministicAgent must be removed');
  assert.equal(typeof agentFallback.joinNatural, 'undefined',
    'joinNatural must be removed');
  assert.equal(typeof agentFallback.projectNamesFromQuestion, 'undefined',
    'projectNamesFromQuestion must be removed');
  assert.deepEqual(Object.keys(agentFallback), [],
    'agent-fallback should export nothing');
});
