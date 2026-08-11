'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  executeAgentTool,
  getAgentToolDefinitions,
  selectAgentToolNames
} = require('../lib/agent-tools');

const knowledge = {
  summary: {
    whoIAm: 'Junior software engineer.',
    honestGaps: ['No production mentorship in data structures and algorithms.']
  },
  skills: {
    languagesAndFrameworks: ['JavaScript', 'React', 'Node.js'],
    cloudAndInfrastructure: ['AWS Lambda', 'Amazon S3']
  },
  experience: [
    {
      role: 'Cloud Support Engineer Intern',
      company: 'AWS',
      dates: '2025',
      summary: 'Completed structured cloud troubleshooting labs.',
      responsibilities: ['Built a serverless metadata workflow.'],
      skills: ['AWS Lambda', 'Amazon S3']
    }
  ],
  projects: [
    {
      name: 'ProjectHub (Scout)',
      description: 'Grounded recruiter assistant with provider failover.',
      category: 'AI recruiter assistant',
      tech: ['JavaScript', 'Node.js'],
      url: 'https://example.com/projecthub'
    },
    {
      name: 'AWS Serverless Metadata Extraction Workflow',
      description: 'Metadata extraction with a serverless pipeline.',
      category: 'Cloud project',
      tech: ['AWS Lambda', 'Amazon S3'],
      url: null
    }
  ],
  certifications: [{ name: 'AWS Certified Cloud Practitioner' }],
  identity: { name: 'Bradley Matera', phone: 'private-for-agent-tools' }
};

test('search_portfolio ranks verified project and experience evidence', () => {
  const result = executeAgentTool('search_portfolio', { query: 'AWS Lambda serverless', limit: 3 }, knowledge);
  assert.ok(result.results.length >= 2);
  assert.equal(result.results[0].kind, 'project');
  assert.match(JSON.stringify(result.results), /Metadata Extraction|Cloud Support/);
});

test('get_project supports an unambiguous partial project name', () => {
  const result = executeAgentTool('get_project', { name: 'ProjectHub' }, knowledge);
  assert.equal(result.found, true);
  assert.equal(result.project.name, 'ProjectHub (Scout)');
});

test('compare_projects returns only requested verified projects', () => {
  const result = executeAgentTool('compare_projects', { names: ['ProjectHub', 'Metadata Extraction'] }, knowledge);
  assert.equal(result.projects.length, 2);
  assert.deepEqual(result.projects.map(project => project.name), [
    'ProjectHub (Scout)',
    'AWS Serverless Metadata Extraction Workflow'
  ]);
});

test('match_role returns evidence and honest gaps without a hiring decision', () => {
  const result = executeAgentTool('match_role', {
    role: 'Junior cloud developer',
    jobDescription: 'Looking for JavaScript, AWS Lambda, and Amazon S3 experience.'
  }, knowledge);
  assert.deepEqual(result.matchedSkills, ['JavaScript', 'AWS Lambda', 'Amazon S3']);
  assert.equal(result.projectEvidence.length, 2);
  assert.match(result.assessmentRule, /not a hiring recommendation/i);
});

test('candidate profile exposes only allowlisted sections', () => {
  const allowed = executeAgentTool('get_candidate_profile', { section: 'summary' }, knowledge);
  const denied = executeAgentTool('get_candidate_profile', { section: 'identity' }, knowledge);
  assert.equal(allowed.section, 'summary');
  assert.equal(denied.error, 'Unsupported profile section.');
  assert.doesNotMatch(JSON.stringify(allowed), /private-for-agent-tools/);
});

test('tool selection keeps a small task-relevant tool set', () => {
  const names = selectAgentToolNames('Compare his projects for this JavaScript role');
  assert.deepEqual(names, ['search_portfolio', 'get_project', 'compare_projects', 'match_role']);
  const definitions = getAgentToolDefinitions(names);
  assert.deepEqual(definitions.map(tool => tool.function.name), names);
});

test('unknown tools fail closed', () => {
  assert.deepEqual(executeAgentTool('send_email', {}, knowledge), { error: 'Tool is not allowed.' });
});
