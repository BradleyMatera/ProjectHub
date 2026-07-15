'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeQuery,
  correctTypos,
  buildVocabulary,
  classifyIntent,
  rewriteQuery,
  understandQuery,
  damerauLevenshtein,
} = require('../lib/query-understanding');

test('normalizeQuery lowercases and strips punctuation', () => {
  assert.equal(normalizeQuery("What's his tech stack?"), "what s his tech stack?");
});

test('normalizeQuery applies typo map', () => {
  assert.equal(normalizeQuery("recruter contact"), "recruiter contact");
  assert.equal(normalizeQuery("certifcation details"), "certification details");
});

test('damerauLevenshtein computes edit distance', () => {
  assert.equal(damerauLevenshtein('cat', 'cat'), 0);
  assert.equal(damerauLevenshtein('cat', 'bat'), 1);
  assert.equal(damerauLevenshtein('cat', 'cats'), 1);
  assert.equal(damerauLevenshtein('abc', 'acb'), 1); // transposition
});

test('correctTypos fixes misspelled words against vocabulary', () => {
  const vocab = new Set(['javascript', 'react', 'typescript', 'experience', 'bradley']);
  assert.equal(correctTypos('javscript', vocab), 'javascript');
  assert.equal(correctTypos('experiance', vocab), 'experience');
  // Words already in vocab are unchanged
  assert.equal(correctTypos('react', vocab), 'react');
  // Short words are unchanged
  assert.equal(correctTypos('aws', vocab), 'aws');
});

test('buildVocabulary extracts words > 3 chars from chunks', () => {
  const chunks = [
    { text: 'Bradley uses JavaScript and React' },
    { text: 'AWS Lambda and DynamoDB experience' },
  ];
  const vocab = buildVocabulary(chunks);
  assert.ok(vocab.has('javascript'));
  assert.ok(vocab.has('react'));
  assert.ok(vocab.has('lambda'));
  assert.ok(vocab.has('dynamodb'));
  assert.ok(vocab.has('experience'));
  assert.ok(!vocab.has('aws')); // 3 chars, filtered
});

test('classifyIntent identifies contact queries', () => {
  assert.equal(classifyIntent('what is his email'), 'contact');
  assert.equal(classifyIntent('how do I reach him'), 'contact');
  assert.equal(classifyIntent('linkedin profile'), 'contact');
});

test('classifyIntent identifies role-fit queries', () => {
  assert.equal(classifyIntent('is he a fit for a junior role'), 'role-fit');
  assert.equal(classifyIntent('would you hire him'), 'role-fit');
});

test('classifyIntent identifies experience queries', () => {
  assert.equal(classifyIntent('tell me about his AWS experience'), 'experience-detail');
});

test('classifyIntent identifies smalltalk', () => {
  assert.equal(classifyIntent('hi there'), 'smalltalk');
  assert.equal(classifyIntent('hey'), 'smalltalk');
});

test('classifyIntent defaults to factual-lookup', () => {
  assert.equal(classifyIntent('what is his tech stack'), 'factual-lookup');
});

test('rewriteQuery resolves bare follow-up with context', () => {
  const history = [
    { user: 'Tell me about his AWS experience', assistant: 'He did an AWS internship at CIRIS with Lambda and DynamoDB.' },
  ];
  const rewritten = rewriteQuery('what about his time as a medic', history);
  // Should include words from both the query and the previous context
  assert.ok(rewritten.includes('medic'));
  assert.ok(rewritten.length > 'what about his time as a medic'.length);
});

test('rewriteQuery does not modify long standalone queries', () => {
  const history = [
    { user: 'What projects has he built?', assistant: 'He built ProjectHub and a Pokedex app.' },
  ];
  const longQuery = 'What is his experience with React and TypeScript for frontend development?';
  const rewritten = rewriteQuery(longQuery, history);
  assert.equal(rewritten, longQuery);
});

test('rewriteQuery returns original when no history', () => {
  assert.equal(rewriteQuery('what about his skills', []), 'what about his skills');
  assert.equal(rewriteQuery('what about his skills', null), 'what about his skills');
});

test('understandQuery runs full pipeline', () => {
  const chunks = [
    { text: 'Bradley Matera is a junior software engineer with JavaScript and React skills.' },
    { text: 'AWS Cloud Intern at CIRIS: Lambda, DynamoDB, S3 experience.' },
  ];
  const result = understandQuery('javscript skils?', [], chunks);
  assert.equal(result.intent, 'factual-lookup');
  assert.ok(result.normalized.includes('javascript'));
  assert.ok(result.normalized.includes('skills'));
  assert.ok(result.rewritten.length > 0);
});

test('understandQuery with history rewrites bare follow-up', () => {
  const chunks = [
    { text: 'Bradley has AWS experience from CIRIS internship with Lambda and DynamoDB.' },
  ];
  const history = [
    { user: 'Tell me about his AWS work', assistant: 'He did structured labs with Lambda and DynamoDB at CIRIS.' },
  ];
  const result = understandQuery('what about that', history, chunks);
  assert.ok(result.rewritten !== result.normalized || result.rewritten.length > result.normalized.length);
});
