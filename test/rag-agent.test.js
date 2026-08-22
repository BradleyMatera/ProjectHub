const { parseGeneratedAnswer, evidenceToIdentifiers } = require('../lib/rag-agent');
const assert = require('node:assert');
const { test } = require('node:test');

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
