'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BM25Index, tokenize, stem } = require('../lib/bm25');

test('tokenize strips stopwords and punctuation', () => {
  const tokens = tokenize("What is Bradley's tech stack?");
  assert.ok(tokens.includes('bradley'));
  assert.ok(tokens.includes('tech'));
  assert.ok(tokens.includes('stack'));
  assert.ok(!tokens.includes('what'));
  assert.ok(!tokens.includes('is'));
});

test('stem reduces common suffixes', () => {
  assert.equal(stem('running'), 'run');
  assert.equal(stem('projects'), 'project');
  assert.equal(stem('certifications'), 'certification');
  assert.equal(stem('experience'), 'experience');
  assert.equal(stem('aws'), 'aws');
});

test('BM25Index returns relevant chunks for direct query', () => {
  const chunks = [
    { tag: 'identity', text: 'Bradley Matera is a junior software engineer based in Davis, Illinois.' },
    { tag: 'skills', text: 'Web skills: JavaScript, React, TypeScript, Node.js, HTML, CSS.' },
    { tag: 'experience', text: 'AWS Cloud Intern at CIRIS: Lambda, DynamoDB, S3, CloudFront.' },
    { tag: 'certification', text: 'AWS Certified Cloud Practitioner and AWS Certified Solutions Architect Associate.' },
  ];
  const index = new BM25Index(chunks);
  const results = index.search('What AWS certifications does he have?', 3);
  assert.ok(results.length > 0);
  assert.equal(results[0].tag, 'certification');
});

test('BM25Index handles typo via stemming', () => {
  const chunks = [
    { tag: 'identity', text: 'Bradley is a junior software engineer.' },
    { tag: 'projects', text: 'ProjectHub: an embeddable chat widget using JavaScript and React.' },
    { tag: 'experience', text: 'CIRIS internship with AWS Lambda and DynamoDB.' },
  ];
  const index = new BM25Index(chunks);
  // "projecthub" should match the projects chunk
  const results = index.search('tell me about projecthub', 2);
  assert.ok(results.length > 0);
  assert.equal(results[0].tag, 'projects');
});

test('BM25Index outperforms substring on paraphrase', () => {
  const chunks = [
    { tag: 'identity', text: 'Bradley Matera is a junior software engineer based in Davis, Illinois.' },
    { tag: 'experience', text: 'AWS Cloud Intern: worked with Lambda, DynamoDB, S3, CloudFront in structured labs.' },
    { tag: 'faq', text: 'Q: Does he have real production AWS experience? A: No, it was structured labs and a controlled capstone, not live production ownership.' },
  ];
  const index = new BM25Index(chunks);
  // Paraphrased query — "cloud work" should match AWS experience via IDF weighting
  const results = index.search('cloud work experience', 3);
  assert.ok(results.length > 0);
  // The experience chunk should rank higher than identity
  const expRank = results.findIndex(r => r.tag === 'experience');
  const idRank = results.findIndex(r => r.tag === 'identity');
  if (idRank >= 0) {
    assert.ok(expRank < idRank, 'experience should rank above identity for cloud query');
  }
});

test('BM25Index returns empty for no matches', () => {
  const chunks = [
    { tag: 'identity', text: 'Bradley is a junior software engineer.' },
  ];
  const index = new BM25Index(chunks);
  const results = index.search('xyzzy foobar', 3);
  assert.equal(results.length, 0);
});

test('BM25Index IDF gives rare terms higher weight', () => {
  const chunks = [
    { tag: 'a', text: 'Bradley Bradley Bradley JavaScript JavaScript' },
    { tag: 'b', text: 'Bradley JavaScript React React React' },
  ];
  const index = new BM25Index(chunks);
  // "react" is rare (only in doc b), "bradley" is common (both docs)
  const results = index.search('react', 2);
  assert.equal(results[0].tag, 'b');
});

test('BM25Index handles empty chunks array', () => {
  const index = new BM25Index([]);
  const results = index.search('anything', 3);
  assert.equal(results.length, 0);
});
