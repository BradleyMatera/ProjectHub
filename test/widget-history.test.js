'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildServerHistory } = require('../logic');

test('widget forwards assistant turns to local conversation memory', () => {
  const history = buildServerHistory([
    { role: 'user', content: 'What is his strongest project?' },
    { role: 'assistant', content: 'ProjectHub is the strongest systems example.' },
    { role: 'user', content: 'Why?' },
    { role: 'bot', content: 'It combines retrieval, memory, and validation.' }
  ]);
  assert.deepEqual(history, [
    { user: 'What is his strongest project?', assistant: 'ProjectHub is the strongest systems example.' },
    { user: 'Why?', assistant: 'It combines retrieval, memory, and validation.' }
  ]);
});

test('widget memory keeps only the five newest turns', () => {
  const context = [];
  for (let index = 0; index < 7; index++) {
    context.push({ role: 'user', content: `q${index}` }, { role: 'assistant', content: `a${index}` });
  }
  const history = buildServerHistory(context);
  assert.equal(history.length, 5);
  assert.equal(history[0].user, 'q2');
  assert.equal(history[4].assistant, 'a6');
});
