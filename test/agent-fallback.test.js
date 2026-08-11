'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDeterministicAgentResult, parseLocalStyleResponse, projectNamesFromQuestion } = require('../lib/agent-fallback');

const knowledge = {
  summary: { honestGaps: ['No production DSA mentorship.'] },
  skills: { web: ['JavaScript', 'Node.js'], cloud: ['AWS Lambda', 'Amazon S3'] },
  projects: [
    { name: 'ProjectHub (Scout)', description: 'Grounded recruiter assistant.', category: 'AI assistant', tech: ['JavaScript', 'Node.js'], url: 'https://example.com' },
    { name: 'AWS Serverless Metadata Extraction Workflow', description: 'Serverless metadata pipeline.', category: 'Cloud project', tech: ['AWS Lambda', 'Amazon S3'], url: null }
  ],
  experience: [
    { role: 'Cloud Support Engineer Intern', company: 'AWS', summary: 'Structured training.', skills: ['AWS Lambda', 'Amazon S3'] }
  ]
};

test('projectNamesFromQuestion identifies known projects without model inference', () => {
  const names = projectNamesFromQuestion('Compare ProjectHub and the Metadata Extraction Workflow', knowledge);
  assert.deepEqual(names, ['ProjectHub (Scout)', 'AWS Serverless Metadata Extraction Workflow']);
});

test('deterministic agent compares projects without Groq', () => {
  const result = buildDeterministicAgentResult('Compare ProjectHub and the Metadata Extraction Workflow', knowledge);
  assert.match(result.reply, /ProjectHub.*while AWS Serverless Metadata/i);
  assert.deepEqual(result.steps.map(step => step.tool), ['search_portfolio', 'compare_projects']);
});

test('deterministic agent matches role evidence without a hiring claim', () => {
  const result = buildDeterministicAgentResult('Is he fit for a role requiring JavaScript and AWS Lambda?', knowledge);
  assert.match(result.reply, /JavaScript.*AWS Lambda/);
  assert.match(result.reply, /evidence matching rather than a hiring recommendation/i);
});

test('deterministic agent produces grounded interview prompts', () => {
  const result = buildDeterministicAgentResult('Give me interview questions about his AWS work', knowledge);
  assert.match(result.reply, /structured training from production experience/i);
});

test('local style response accepts only a constrained presentation hint', () => {
  assert.equal(parseLocalStyleResponse('{"style":"brief"}', 'Give me a brief comparison'), 'brief');
  assert.equal(parseLocalStyleResponse('{"style":"brief"}', 'Compare these projects'), 'standard');
  assert.equal(parseLocalStyleResponse('{"style":"standard"}', 'Compare these projects'), 'standard');
  assert.equal(parseLocalStyleResponse('{"style":"rewrite","reply":"invented"}', 'Compare these projects'), null);
  assert.equal(parseLocalStyleResponse('ProjectSage is better', 'Compare these projects'), null);
});
