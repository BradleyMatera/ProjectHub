'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compactToolResult, parseToolArguments, runAgentLoop } = require('../lib/agent-runtime');

const tools = [{
  type: 'function',
  function: {
    name: 'search_portfolio',
    description: 'Search verified evidence.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  }
}];

test('parseToolArguments accepts objects and JSON but rejects malformed input', () => {
  assert.deepEqual(parseToolArguments({ query: 'AWS' }), { query: 'AWS' });
  assert.deepEqual(parseToolArguments('{"query":"AWS"}'), { query: 'AWS' });
  assert.equal(parseToolArguments('{bad json'), null);
});

test('compactToolResult bounds large tool responses', () => {
  const result = compactToolResult({ text: 'x'.repeat(2000) }, 500);
  assert.ok(result.length < 600);
  assert.match(result, /truncated/);
});

test('agent returns a direct response without executing tools', async () => {
  let executions = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'Who is Bradley?' }],
    tools,
    complete: async () => ({ message: { role: 'assistant', content: 'Bradley is a junior software engineer.' } }),
    execute: async () => { executions++; }
  });
  assert.equal(result.reply, 'Bradley is a junior software engineer.');
  assert.equal(executions, 0);
  assert.deepEqual(result.steps, []);
});

test('agent executes an allowlisted tool and synthesizes a final response', async () => {
  const requests = [];
  let call = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'Which project uses AWS?' }],
    tools,
    complete: async request => {
      requests.push(request);
      call++;
      if (call === 1) {
        return { message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_portfolio', arguments: '{"query":"AWS"}' } }]
        } };
      }
      return { message: { role: 'assistant', content: 'His serverless metadata project uses AWS Lambda and S3.' } };
    },
    execute: async (name, args) => ({ name, query: args.query, projects: ['serverless metadata'] })
  });
  assert.equal(result.reply, 'His serverless metadata project uses AWS Lambda and S3.');
  assert.deepEqual(result.steps, [{ round: 1, tool: 'search_portfolio', status: 'completed' }]);
  assert.equal(result.toolResults[0].result.query, 'AWS');
  assert.equal(requests[1].messages.at(-1).role, 'tool');
});

test('agent denies model-requested tools outside the supplied registry', async () => {
  let call = 0;
  let executed = false;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'Send an email.' }],
    tools,
    complete: async () => {
      call++;
      if (call === 1) {
        return { message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_bad', type: 'function', function: { name: 'send_email', arguments: '{}' } }]
        } };
      }
      return { message: { role: 'assistant', content: 'Scout cannot send emails.' } };
    },
    execute: async () => { executed = true; }
  });
  assert.equal(executed, false);
  assert.equal(result.steps[0].status, 'denied');
});

test('agent fails closed when the model never produces final text', async () => {
  await assert.rejects(() => runAgentLoop({
    messages: [],
    tools,
    maxRounds: 1,
    maxToolCalls: 1,
    complete: async () => ({ message: { role: 'assistant', content: '' } }),
    execute: async () => ({})
  }), /neither text nor tool calls/);
});
