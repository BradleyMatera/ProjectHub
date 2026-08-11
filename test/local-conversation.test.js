'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildLocalConversationMemory, validateLocalConversationReply } = require('../lib/local-conversation');

test('local conversation memory keeps the five newest sanitized turns and stance', () => {
  const history = Array.from({ length: 7 }, (_, index) => ({
    user: `<b>question ${index}</b>`,
    assistant: `answer ${index}`
  }));
  const memory = buildLocalConversationMemory(history, 'projects: ProjectHub is grounded.');
  assert.equal(memory.turns.length, 5);
  assert.equal(memory.turns[0].user, 'question 2');
  assert.equal(memory.turns[4].assistant, 'answer 6');
  assert.equal(memory.stance, 'projects: ProjectHub is grounded.');
});

test('local reply validator accepts grounded phrasing and rejects new entities and hype', () => {
  const source = 'Bradley built ProjectHub with JavaScript, Node.js, BM25 retrieval, session memory, and local Ollama.';
  assert.equal(validateLocalConversationReply(
    'ProjectHub combines BM25 retrieval with session memory, so Bradley can keep answers grounded across follow-up questions.',
    source,
    'How does ProjectHub keep follow-up answers grounded?'
  ), true);
  assert.equal(validateLocalConversationReply('ProjectSage is a clear winner with strong AI capabilities.', source), false);
  assert.equal(validateLocalConversationReply('ProjectHub has 50 production users.', source), false);
  assert.equal(validateLocalConversationReply('Bradley built ProjectHub. It uses BM25 retrieval. It also uses local Ollama.', source), false);
  assert.equal(validateLocalConversationReply('ProjectHub uses BM25 retrieval', source, 'How does ProjectHub retrieve facts?'), false);
  assert.equal(validateLocalConversationReply('Bradley studies data structures and algorithms.', `${source} Bradley studies data structures and algorithms.`, 'How does he approach an unfamiliar codebase?'), false);
});
