const { parseGeneratedAnswer, evidenceToIdentifiers, buildRagPrimaryPacket, buildRagEvidence } = require('../lib/rag-agent');
const assert = require('node:assert');
const { test } = require('node:test');

test('RAG packet preserves selected facts when guardrails exceed the nominal text budget', () => {
  const ragEvidence = 'FACT 1 [experience:Northstar]\nAda was a Customer Support Specialist at Northstar.\n\nFACT 2 [gaps]\nAdvanced statistics is a documented learning area.';
  for (const intent of ['EXPERIENCE', 'META']) {
    const packet = buildRagPrimaryPacket({
      question: 'What experience does Ada have outside software?',
      ragEvidence,
      guardrails: 'Do not invent current employment or personal weaknesses. '.repeat(30),
      maxTokens: 400,
      conversationState: { recentTurns: [{ user: 'Tell me about Ada.', assistant: 'Ada has a support background.' }] },
      responseContract: { intent, subIntent: intent }
    });
    assert.ok(packet.systemPrompt.includes(ragEvidence), 'bounded selected evidence must survive packet construction');
  }
});

test('RAG packet retains the complete current question rather than truncating its target', () => {
  const question = 'Given the work history and projects we have discussed, can you assess the documented preparation for a customer support role rather than the software role?';
  const packet = buildRagPrimaryPacket({ question, ragEvidence: '', maxTokens: 400 });
  assert.ok(packet.userPrompt.includes(question));
});

test('validator rejects diagnostic classifications echoed as skills', () => {
  const { validateAnswer } = require('../lib/grounding-validator');
  const answer = 'The skills that match include unknown technology payroll treated as documented skill.';
  const result = validateAnswer(answer, 'Ada processes support tickets.', 'What are her skills?');
  assert.ok(result.reasons.includes('leaked_internal_language'));
});

test('structured source provenance stays outside model-visible evidence', () => {
  const provenance = { sourcePath: 'projects[0].description' };
  const item = { kind: 'project', name: 'Atlas', sourceEntity: 'Atlas', provenance, description: 'Atlas is built with React.', evidenceScore: 1 };
  const packet = buildRagEvidence([item]);
  assert.strictEqual(packet.text, '- Atlas is built with React.');
  assert.strictEqual(packet.selected[0].provenance, provenance);
  assert.strictEqual(packet.selected[0].sourceEntity, 'Atlas');
  assert.ok(!/FACT\s+\d|\[project:|\[source:|projects\[0\]/.test(packet.text));
});

test('publication backfill keeps internal platform IDs out of model evidence', () => {
  const knowledge = { blogCatalog: { records: [{ title: 'Database Notes', brief: 'A guide to query planning.', platform: 'internal-catalog' }] } };
  const packet = buildRagEvidence([], 1100, 8, 'GENERAL', knowledge, 'What has she published?');
  assert.ok(packet.text.includes('Database Notes: A guide to query planning.'));
  assert.ok(!packet.text.includes('[internal-catalog-0]'));
  assert.strictEqual(packet.selected[0].name, 'Database Notes');
});

test('parseGeneratedAnswer strips leading Q: / A: scaffolding', () => {
  const raw = 'Q: What is Scout?\nA: Scout is the AI recruiter assistant built into ProjectHub.';
  const answer = parseGeneratedAnswer(raw);
  assert.strictEqual(answer, 'Scout is the AI recruiter assistant built into ProjectHub.');
});

test('parseGeneratedAnswer strips leading A: marker', () => {
  const raw = 'A: Scout is a RAG-first recruiter assistant.';
  const answer = parseGeneratedAnswer(raw);
  assert.strictEqual(answer, 'Scout is a RAG-first recruiter assistant.');
});

test('parseGeneratedAnswer prefers JSON answer envelope', () => {
  const raw = '{"answer": "Scout is a recruiter assistant."}';
  const answer = parseGeneratedAnswer(raw);
  assert.strictEqual(answer, 'Scout is a recruiter assistant.');
});

test('parseGeneratedAnswer keeps normal prose unchanged', () => {
  const raw = 'Scout is a RAG-first recruiter assistant.';
  const answer = parseGeneratedAnswer(raw);
  assert.strictEqual(answer, 'Scout is a RAG-first recruiter assistant.');
});

test('evidenceToIdentifiers exposes only safe telemetry fields', () => {
  const evidence = [
    { kind: 'scout-runtime', name: 'runtime', description: 'Secret runtime fact.', evidenceScore: 1.5 },
    { kind: 'project', name: 'ProjectHub', description: 'Private project description.', evidenceScore: 1.2 }
  ];
  const ids = evidenceToIdentifiers(evidence, 10);
  assert.strictEqual(ids.length, 2);
  assert.deepStrictEqual(ids[0], { kind: 'scout-runtime', tag: 'scout-runtime', name: 'runtime', id: 'scout-runtime-1', score: 1.5 });
  assert.strictEqual(ids[0].description, undefined);
  assert.strictEqual(ids[1].description, undefined);
});
