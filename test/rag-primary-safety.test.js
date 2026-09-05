const test = require('node:test');
const assert = require('node:assert');

function freshAgent(validateStub) {
  delete require.cache[require.resolve('../lib/grounding-validator')];
  delete require.cache[require.resolve('../lib/rag-agent')];
  if (validateStub) {
    require('../lib/grounding-validator').validateAnswer = validateStub;
  }
  return require('../lib/rag-agent');
}

function makeRouter() {
  const router = require('../lib/local-model-router');
  let calls = 0;
  const answers = arguments[0];
  router.generate = async () => {
    calls++;
    const text = answers[calls - 1] || '';
    return {
      ok: true,
      text: JSON.stringify({ answer: text }),
      usage: { provider: 'test', promptEvalCount: 100 + calls * 10, evalCount: 20, actualNeurons: null, estimatedNeurons: calls * 100 },
      model: 'test-model',
      latencyMs: 10
    };
  };
  return { get calls() { return calls; } };
}

const baseKnowledge = {
  identity: { name: 'Bradley Matera', title: 'Early-career Software Engineer' },
  summary: { whoIAm: 'Early-career software engineer focused on JavaScript and React.' },
  projects: [{ name: 'ProjectHub', description: 'AI recruiter chat widget', tech: ['React', 'TypeScript'] }],
  skills: { technical: ['React', 'TypeScript'] },
  experience: [{ role: 'AWS Cloud Support Engineer Intern', company: 'AWS', dates: 'May 2025 - August 2025', summary: 'Guided training environment.' }],
  education: { degree: 'B.S. Web Development', school: 'Full Sail University' },
  directAnswers: [],
  rules: { doNot: ['Do not claim seniority'] }
};

const baseEvidence = [
  { kind: 'identity', description: 'Bradley Matera is an early-career software engineer.', evidenceScore: 1.0 }
];

function makeValid() {
  return { valid: true, verdict: 'supported', reasons: [], cleaned: '' };
}

function makeInvalid(reasons) {
  return { valid: false, verdict: 'unsupported', reasons, cleaned: '' };
}

test('A. invalid primary + valid repair returns repaired answer', async () => {
  const { runRagPrimaryAgent } = freshAgent((answer) => {
    if (answer.includes('repaired')) return makeValid();
    return makeInvalid(['overclaim_language']);
  });
  const tracker = makeRouter(['Bradley worked at Google.', 'repaired: public evidence does not mention Google.']);

  const result = await runRagPrimaryAgent({
    question: 'He worked at Google, right?',
    conversationState: { recentTurns: [] },
    evidence: baseEvidence,
    knowledge: baseKnowledge,
    sessionId: 'test-a',
    policyContract: { mode: null }
  });

  assert.strictEqual(result.reply, 'repaired: public evidence does not mention Google.');
  assert.strictEqual(result.proseSource, 'MODEL_GENERATION');
  assert.strictEqual(result.fallback, false);
  assert.strictEqual(result.actualProviderCalls, 2);
  assert.strictEqual(result.generationCalls.length, 2);
  assert.strictEqual(result.generationCalls[0].accepted, false);
  assert.strictEqual(result.generationCalls[1].accepted, true);
  assert.strictEqual(result.generationCalls[1].attemptType, 'FACTUAL_REPAIR');
  assert.strictEqual(result.validation.valid, true);
});

test('B. invalid primary + invalid repair returns no answer', async () => {
  const { runRagPrimaryAgent } = freshAgent(() => makeInvalid(['entity_not_grounded']));
  const tracker = makeRouter(['Bradley worked at Google.', 'Still invalid.']);

  const result = await runRagPrimaryAgent({
    question: 'He worked at Google, right?',
    conversationState: { recentTurns: [] },
    evidence: baseEvidence,
    knowledge: baseKnowledge,
    sessionId: 'test-b',
    policyContract: { mode: null }
  });

  assert.strictEqual(result.reply, null);
  assert.strictEqual(result.proseSource, 'TECHNICAL_ERROR');
  assert.strictEqual(result.fallback, true);
  assert.strictEqual(result.inferenceUnavailable, true);
  assert.strictEqual(result.actualProviderCalls, 2);
  assert.strictEqual(result.generationCalls.length, 2);
  assert.strictEqual(result.generationCalls[0].accepted, false);
  assert.strictEqual(result.generationCalls[1].accepted, false);
  assert.ok(!result.generationCalls[1].accepted);
});

test('C. invalid primary + fewer-reason repair still rejects', async () => {
  let call = 0;
  const { runRagPrimaryAgent } = freshAgent(() => {
    call++;
    return call === 1 ? makeInvalid(['entity_not_grounded:a', 'entity_not_grounded:b', 'number_not_grounded:5']) : makeInvalid(['entity_not_grounded:a', 'number_not_grounded:5']);
  });
  const tracker = makeRouter(['Bradley has 10 years of React.', 'He has some React experience.']);

  const result = await runRagPrimaryAgent({
    question: 'He has 10 years of React, right?',
    conversationState: { recentTurns: [] },
    evidence: baseEvidence,
    knowledge: baseKnowledge,
    sessionId: 'test-c',
    policyContract: { mode: null }
  });

  assert.strictEqual(result.reply, null);
  assert.strictEqual(result.proseSource, 'TECHNICAL_ERROR');
  assert.strictEqual(result.fallback, true);
  assert.strictEqual(result.actualProviderCalls, 2);
  assert.strictEqual(result.generationCalls.length, 2);
  assert.strictEqual(result.generationCalls[0].accepted, false);
  assert.strictEqual(result.generationCalls[1].accepted, false);
});

test('primary prose reaches validation and the user unchanged, including dotted technology names', async () => {
  const answer = 'Ada used Node.js for a small service. She also used SQL for reports. Her work was supervised training, not production ownership.';
  const { runRagPrimaryAgent } = freshAgent((candidate) => {
    assert.strictEqual(candidate, answer);
    return makeValid();
  });
  makeRouter([answer]);
  const result = await runRagPrimaryAgent({
    question: 'What skills does Ada use?',
    conversationState: { recentTurns: [] },
    evidence: [{ kind: 'skills', description: answer, evidenceScore: 1 }],
    knowledge: { identity: { name: 'Ada' }, skills: { technical: ['Node.js', 'SQL'] }, projects: [], experience: [] },
    sessionId: 'unchanged-primary',
    policyContract: { mode: null }
  });
  assert.strictEqual(result.reply, answer);
  assert.strictEqual(result.rawPrimary, answer);
});

test('repair cannot bypass a validator rejection of leaked internal language', async () => {
  const { runRagPrimaryAgent } = freshAgent(() => makeInvalid(['leaked_internal_language']));
  const tracker = makeRouter(['An unsupported relationship was detected.', 'The entity is not grounded in the supplied facts.']);
  const result = await runRagPrimaryAgent({
    question: 'What skills does Ada use?',
    conversationState: { recentTurns: [] },
    evidence: baseEvidence,
    knowledge: baseKnowledge,
    sessionId: 'repair-scaffolding',
    policyContract: { mode: null }
  });
  assert.strictEqual(result.reply, null);
  assert.strictEqual(result.proseSource, 'TECHNICAL_ERROR');
  assert.strictEqual(tracker.calls, 2);
  assert.ok(result.generationCalls.every(call => !call.accepted));
});

test('D. valid primary uses exactly one provider call', async () => {
  const { runRagPrimaryAgent } = freshAgent(() => makeValid());
  const tracker = makeRouter(['Bradley did not work at Google.']);

  const result = await runRagPrimaryAgent({
    question: 'He worked at Google, right?',
    conversationState: { recentTurns: [] },
    evidence: baseEvidence,
    knowledge: baseKnowledge,
    sessionId: 'test-d',
    policyContract: { mode: null }
  });

  assert.strictEqual(result.reply, 'Bradley did not work at Google.');
  assert.strictEqual(result.proseSource, 'MODEL_GENERATION');
  assert.strictEqual(result.fallback, false);
  assert.strictEqual(result.actualProviderCalls, 1);
  assert.strictEqual(result.generationCalls.length, 1);
  assert.strictEqual(result.generationCalls[0].attemptType, 'PRIMARY');
  assert.strictEqual(result.generationCalls[0].accepted, true);
  assert.strictEqual(result.validation.valid, true);
});

test('E. visitor name colliding with a subject alias stays a control turn', async () => {
  const { runRagPrimaryAgent } = freshAgent(() => makeValid());
  const tracker = makeRouter(["Nice to meet you, Brad. I am Scout, Bradley's recruiter assistant."]);
  const knowledge = {
    ...baseKnowledge,
    identity: { ...baseKnowledge.identity, preferredName: 'Brad' },
    subjectAliases: ['Bradley', 'Brad', 'Matera']
  };

  const result = await runRagPrimaryAgent({
    question: 'my names brad',
    conversationState: { recentTurns: [] },
    evidence: baseEvidence,
    knowledge,
    sessionId: 'test-e',
    policyContract: { mode: 'USER_PROFILE_UPDATE', visitorName: 'Brad' }
  });

  assert.strictEqual(result.operation, 'control');
  assert.strictEqual(result.reply, "Nice to meet you, Brad. I am Scout, Bradley's recruiter assistant.");
  assert.strictEqual(tracker.calls, 1);
});

test('F. a distinct subject mention still forces the substantive path', async () => {
  const { runRagPrimaryAgent } = freshAgent(() => makeValid());
  const tracker = makeRouter(['Bradley uses React in ProjectHub.']);
  const knowledge = {
    ...baseKnowledge,
    identity: { ...baseKnowledge.identity, preferredName: 'Brad' },
    subjectAliases: ['Bradley', 'Brad', 'Matera']
  };

  const result = await runRagPrimaryAgent({
    question: 'my name is alex, what does bradley know?',
    conversationState: { recentTurns: [] },
    evidence: baseEvidence,
    knowledge,
    sessionId: 'test-f',
    policyContract: { mode: 'USER_PROFILE_UPDATE', visitorName: 'Alex' }
  });

  assert.notStrictEqual(result.operation, 'control');
  assert.strictEqual(result.reply, 'Bradley uses React in ProjectHub.');
  assert.ok(tracker.calls >= 1);
});
