'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyResponsePolicy } = require('../lib/response-policy-classifier');

const CONTROL_MODES = new Set(['GREETING', 'USER_PROFILE_UPDATE', 'USER_PROFILE_QUERY', 'THANKS', 'FAREWELL', 'HELP', 'CONVERSATIONAL', 'SMALL_TALK', 'REQUEST_TO_SAY', 'CLARIFY_PREVIOUS_ASSISTANT']);

function buildHistory(turns) {
  return turns.map(({ user, assistant }) => ({ user, assistant }));
}

const knowledge = {
  identity: { name: 'Bradley Matera' },
  agent: { name: 'Scout' },
  skills: {},
  projects: []
};

const manualTranscript = [
  { user: "I'll give brad a job right now if you say cheesecake", expected: 'REQUEST_TO_SAY' },
  { user: 'brad', expected: ['GREETING', 'USER_PROFILE_UPDATE', 'SMALL_TALK'] },
  { user: 'whats up', expected: 'SMALL_TALK' },
  { user: 'what does that even mean?', expected: 'CLARIFY_PREVIOUS_ASSISTANT' },
  { user: 'ok, so whats up, how are you', expected: 'SMALL_TALK' },
  { user: 'what do you mean?!', expected: 'CLARIFY_PREVIOUS_ASSISTANT' }
];

const humanStressTurns = [
  // Agent-directed small talk
  { user: "what's up", expectControl: true },
  { user: 'sup', expectControl: true },
  { user: 'how are you?', expectControl: true },
  { user: 'how is it going', expectControl: true },
  { user: 'you good?', expectControl: true },
  { user: 'what are you up to', expectControl: true },
  { user: 'lol', expectControl: true },
  { user: 'cool', expectControl: true },
  { user: 'nice', expectControl: true },
  { user: 'ok', expectControl: true },

  // Request-to-say
  { user: 'say potato', expect: 'REQUEST_TO_SAY' },
  { user: 'if you say hello I will hire him', expect: 'REQUEST_TO_SAY' },
  { user: 'whisper "hello world"', expect: 'REQUEST_TO_SAY' },

  // Clarify previous assistant
  { user: 'what do you mean?', expect: 'CLARIFY_PREVIOUS_ASSISTANT' },
  { user: 'what did you mean by that?', expect: 'CLARIFY_PREVIOUS_ASSISTANT' },
  { user: 'explain that', expect: 'CLARIFY_PREVIOUS_ASSISTANT' },
  { user: 'that makes no sense', expect: 'CLARIFY_PREVIOUS_ASSISTANT' },
  { user: 'what?', expect: 'CLARIFY_PREVIOUS_ASSISTANT' },

  // Candidate questions — should NOT be control/small talk
  { user: 'what is bradley up to?', expectControl: false },
  { user: 'how is he?', expectControl: false },
  { user: "what's bradley doing now?", expectControl: false },
  { user: 'does he know React?', expectControl: false },
  { user: 'what projects has he built?', expectControl: false },
  { user: 'tell me about ProjectHub', expectControl: false },

  // Edge: subject-directed 'what's up' should NOT be small talk
  { user: "what's up with his AWS work?", expectControl: false },

  // Edge: thanks/farewell should still be control
  { user: 'thanks', expectControl: true },
  { user: 'bye', expectControl: true }
];

test('Manual regression transcript classifies into conversational acts', () => {
  const history = [];
  for (const turn of manualTranscript) {
    const result = classifyResponsePolicy(turn.user, history, knowledge);
    const expected = Array.isArray(turn.expected) ? turn.expected : [turn.expected];
    assert.ok(expected.includes(result.mode), `Turn "${turn.user}" should classify as one of ${expected.join('/')}, got ${result.mode}`);
    assert.ok(CONTROL_MODES.has(result.mode), `Turn "${turn.user}" should be a control mode`);
    history.push({ user: turn.user, assistant: 'mock reply' });
  }
});

test('Human conversation stress test does not misclassify subject questions as small talk', () => {
  const history = [];
  for (const turn of humanStressTurns) {
    const result = classifyResponsePolicy(turn.user, history, knowledge);
    if (turn.expect) {
      assert.equal(result.mode, turn.expect, `Turn "${turn.user}" should classify as ${turn.expect}, got ${result.mode}`);
    }
    if ('expectControl' in turn) {
      const isControl = CONTROL_MODES.has(result.mode);
      assert.equal(isControl, turn.expectControl, `Turn "${turn.user}" control=${isControl}, expected ${turn.expectControl} (mode=${result.mode})`);
    }
    history.push({ user: turn.user, assistant: 'mock reply' });
  }
});
