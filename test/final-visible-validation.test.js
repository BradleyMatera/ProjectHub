const { describe, it } = require('node:test');
const assert = require('node:assert');
const { validateLocalConversationReply } = require('../lib/local-conversation');

describe('final-visible validation', () => {
  it('accepts a grounded, complete reply that addresses the question', () => {
    const source = 'Bradley Matera is a junior software developer. He used React, JavaScript, and Node.js in ProjectHub. He attended Full Sail University and has a 3.64 GPA. He can be reached at bradmatera@gmail.com.';
    const reply = 'Bradley used React and JavaScript in ProjectHub.';
    const question = 'What tech did Bradley use in ProjectHub?';
    assert.strictEqual(validateLocalConversationReply(reply, source, question), true, 'valid grounded reply should be accepted');
  });

  it('rejects an overclaim reply', () => {
    const source = 'Bradley Matera is a junior developer.';
    const reply = 'Bradley is a senior engineer at Google with 10 years of experience.';
    const question = 'Who is Bradley?';
    assert.strictEqual(validateLocalConversationReply(reply, source, question), false, 'overclaim reply should be rejected');
  });

  it('rejects a reply with ungrounded numbers', () => {
    const source = 'Bradley has a 3.64 GPA.';
    const reply = 'Bradley graduated in 2027 with a 4.0 GPA.';
    const question = 'What was his GPA?';
    assert.strictEqual(validateLocalConversationReply(reply, source, question), false, 'ungrounded numbers should be rejected');
  });

  it('rejects a reply that does not address the question', () => {
    const source = 'Bradley attended Full Sail University.';
    const reply = 'He lives in Davis, Illinois.';
    const question = 'What school did he attend?';
    assert.strictEqual(validateLocalConversationReply(reply, source, question), false, 'off-topic reply should be rejected');
  });

  it('rejects a reply that is too short to be useful', () => {
    const source = 'Bradley knows React.';
    const reply = 'Yes.';
    const question = 'Does he know React?';
    assert.strictEqual(validateLocalConversationReply(reply, source, question), false, 'too-short reply should be rejected');
  });
});
