'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildLocalConversationMemory, extractFirstCompleteSentence, extractCompleteSentences, validateLocalConversationReply } = require('../lib/local-conversation');

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

test('local conversation streaming stops at the first complete sentence', () => {
  assert.equal(extractFirstCompleteSentence('ProjectHub uses Node.js locally. It also has a fallback.'), 'ProjectHub uses Node.js locally.');
  assert.equal(extractFirstCompleteSentence('ProjectHub uses local retrieval'), '');
});

test('local conversation can retain two complete natural sentences', () => {
  assert.equal(
    extractCompleteSentences('He reads existing code carefully. Then he makes a small reviewable change. A third sentence is ignored.'),
    'He reads existing code carefully. Then he makes a small reviewable change.'
  );
});

test('temporal grounding validator rejects unsupported current/past mismatches', () => {
  // Reply claims current without source support.
  assert.equal(validateLocalConversationReply(
    'Bradley is currently working at AWS.',
    'Bradley worked at AWS in 2020.',
    'What is Bradley doing now?'
  ), false);

  // Reply uses past tense for a current-state question.
  assert.equal(validateLocalConversationReply(
    'Bradley worked at AWS in 2020.',
    'Bradley is open to new opportunities at AWS.',
    'Where is Bradley working now?'
  ), false);

  // Reply uses current tense for a past-state question.
  assert.equal(validateLocalConversationReply(
    'Bradley is currently an intern at AWS.',
    'Bradley was an intern at AWS in 2020.',
    'Was Bradley an intern at AWS in the past?'
  ), false);

  // Consistent past answer to past question is accepted.
  assert.equal(validateLocalConversationReply(
    'Bradley was an intern at AWS in 2020.',
    'Bradley was an intern at AWS in 2020.',
    'Did Bradley intern at AWS in 2020?'
  ), true);

  // Current answer with explicit current marker in the source is accepted.
  assert.equal(validateLocalConversationReply(
    'Bradley is currently open to new roles.',
    'Bradley is currently open to new opportunities (2024).',
    'What is Bradley doing now?'
  ), true);
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
  assert.equal(validateLocalConversationReply('Bradley built ProjectHub with JavaScript. It uses BM25 retrieval and session memory.', source, 'How did Bradley build ProjectHub?'), true);
  assert.equal(validateLocalConversationReply('Bradley built ProjectHub. It uses BM25 retrieval. It also uses local Ollama.', source), false);
  assert.equal(validateLocalConversationReply('ProjectHub uses BM25 retrieval', source, 'How does ProjectHub retrieve facts?'), false);
  assert.equal(validateLocalConversationReply('Bradley studies data structures and algorithms.', `${source} Bradley studies data structures and algorithms.`, 'How does he approach an unfamiliar codebase?'), false);
});
