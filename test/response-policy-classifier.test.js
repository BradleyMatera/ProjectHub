const { classifyResponsePolicy } = require('../lib/response-policy-classifier');
const assert = require('node:assert');
const { test } = require('node:test');

const knowledge = {
  identity: { name: 'Bradley Matera', title: 'Software Engineer', location: 'Davis, Illinois' },
  agent: { name: 'Scout' }
};

test('capability "What can you help with?" routes to META, not HELP', () => {
  const policy = classifyResponsePolicy('What can you help with?', [], knowledge);
  assert.strictEqual(policy.mode, 'META');
});

test('"What is Scout?" routes to META via agent name', () => {
  const policy = classifyResponsePolicy('What is Scout?', [], knowledge);
  assert.strictEqual(policy.mode, 'META');
});

test('"What model do you use?" routes to META', () => {
  const policy = classifyResponsePolicy('What model do you use?', [], knowledge);
  assert.strictEqual(policy.mode, 'META');
});

test('"How is this chat free?" routes to META', () => {
  const policy = classifyResponsePolicy('How is this chat free?', [], knowledge);
  assert.strictEqual(policy.mode, 'META');
});

test('subject-directed "what do you know about Bradley" does not route to META', () => {
  const policy = classifyResponsePolicy('What do you know about Bradley?', [], knowledge);
  assert.notStrictEqual(policy.mode, 'META');
});
