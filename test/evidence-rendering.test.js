'use strict';

/**
 * Regression tests for clean model-visible evidence and structured provenance.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRagEvidence, buildRagEvidenceText } = require('../lib/rag-agent');
const { splitEvidenceBlocks, evidenceSupportsTechnologyRelation } = require('../lib/evidence-relations');
const { buildRagChunks } = require('../lib/rag-chunks');

const MIXED_EVIDENCE = [
  { kind: 'project', name: 'ProjectHub', description: 'Project ProjectHub is a portfolio widget.', evidenceScore: 1.0 },
  { kind: 'source', name: 'Why Verification Matters', description: 'Why Verification Matters: a post about validation.', evidenceScore: 0.9 },
  { kind: 'direct-answer', name: 'contact-direct', description: 'Public contact methods: email, phone.', evidenceScore: 0.8 },
  { kind: 'scout-runtime', name: 'provider', description: 'Scout uses Cloudflare Workers AI.', evidenceScore: 0.7 }
];

test('buildRagEvidence returns clean model-visible text without bracketed source labels', () => {
  const { text, selected } = buildRagEvidence(MIXED_EVIDENCE, 2000, 8, 'SKILL');
  assert.ok(text, 'should return text');
  assert.ok(!/\[[^\]]+\]/.test(text), 'visible text must not contain bracketed source labels');
  assert.ok(text.includes('Project ProjectHub is a portfolio widget.'), 'project fact should appear');
  assert.ok(text.includes('Why Verification Matters: a post about validation.'), 'source title should appear');
  assert.ok(text.includes('Public contact methods: email, phone.'), 'direct answer should appear');
  assert.ok(text.includes('Scout uses Cloudflare Workers AI.'), 'runtime fact should appear');
  assert.equal(selected.length, 4, 'all items selected');
  for (const item of selected) {
    assert.ok(item.kind, 'selected item should carry kind provenance');
    assert.ok(!/\[[^\]]+\]/.test(item.renderedText), 'rendered text should be clean');
  }
});

test('buildRagEvidenceText delegates to buildRagEvidence and returns only text', () => {
  const text = buildRagEvidenceText(MIXED_EVIDENCE, 2000, 8, 'SKILL');
  assert.equal(typeof text, 'string');
  assert.ok(!/\[[^\]]+\]/.test(text));
});

test('splitEvidenceBlocks handles structured evidence objects', () => {
  const blocks = splitEvidenceBlocks(MIXED_EVIDENCE);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].source, 'project');
  assert.equal(blocks[0].text, 'Project ProjectHub is a portfolio widget.');
  assert.equal(blocks[1].source, 'source');
  assert.equal(blocks[1].text, 'Why Verification Matters: a post about validation.');
});

test('same-FACT validation uses structured evidence blocks', () => {
  const evidence = [
    { kind: 'project', description: 'Atlas uses React.', evidenceScore: 1.0 },
    { kind: 'project', description: 'Orion uses Vue.', evidenceScore: 1.0 }
  ];
  assert.ok(evidenceSupportsTechnologyRelation(['Atlas'], 'React', evidence), 'Atlas and React in same block');
  assert.ok(!evidenceSupportsTechnologyRelation(['Atlas'], 'Vue', evidence), 'Vue is in a different block');
});

test('buildRagChunks does not emit internal bracketed IDs in chunk text', () => {
  const knowledge = {
    identity: { name: 'Ada Test', title: 'Tester', location: 'Testville' },
    summary: { whoIAm: 'Ada is a tester.' },
    sourceMaterial: [
      { title: 'Test Source', content: 'Some content from a source.' }
    ],
    blogCatalog: { records: [{ title: 'Test Post', brief: 'A brief post.' }] },
    directAnswers: [{ id: 'da-1', answer: 'Yes, directly.' }],
    scoutRuntimeKnowledge: { facts: [{ id: 'runtime-1', text: 'Scout is an AI assistant.' }] },
    projects: [],
    experience: [],
    skills: {}
  };
  const chunks = buildRagChunks(knowledge);
  const allText = chunks.map(c => c.text).join('\n');
  assert.ok(!/\[(?:source|blog|direct|runtime|scout-runtime)-?\d*\]/.test(allText), 'chunk text must not contain bracketed internal IDs');
  assert.ok(allText.includes('Test Source: Some content from a source.'), 'source title should be inline');
  assert.ok(allText.includes('Test Post: A brief post.'), 'blog title should be inline');
  assert.ok(allText.includes('Yes, directly.'), 'direct answer should be inline');
  assert.ok(!allText.includes('[runtime]'), 'runtime chunk should not have bracketed id');
});
