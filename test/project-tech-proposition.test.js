'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProjectTechnologyRelationships, validateClaims } = require('../lib/claim-validator');
const { evidenceSupportsTechnologyRelation, splitEvidenceBlocks } = require('../lib/evidence-relations');
const { buildRagEvidence } = require('../lib/rag-agent');

function knowledge(project = {}, extra = {}) {
  return {
    identity: { name: 'Alex Doe', preferredName: 'Alex' },
    skills: { core: ['AWS', 'AWS Lambda', 'DynamoDB', 'JavaScript', 'React', 'Vue', 'Node.js', 'PostgreSQL', 'Go'] },
    projects: [{ name: 'Atlas', tech: [], ...project }],
    experience: [],
    ...extra
  };
}

function invalidTech(answer, k, evidence = '') {
  return validateProjectTechnologyRelationships(answer, null, k, evidence);
}

function rejectsTechnology(answer, k, tech, evidence = '') {
  const issues = invalidTech(answer, k, evidence);
  assert.ok(issues.some(issue => issue.type === 'PROJECT_RELATIONSHIP_CLAIM' && issue.detail.toLowerCase().endsWith(tech.toLowerCase())), JSON.stringify(issues));
}

test('project title and comparison description do not support AWS use', () => {
  const k = knowledge({ name: 'AWS Pricing Comparison', tech: ['JavaScript'], description: 'Compares AWS and Azure pricing.' });
  rejectsTechnology('AWS Pricing Comparison uses AWS.', k, 'AWS');
  assert.deepEqual(invalidTech('AWS Pricing Comparison uses JavaScript.', k), []);
});

test('a comparison of React and Vue supports neither actual-use claim', () => {
  const k = knowledge({ description: 'Compares React and Vue.', tech: ['JavaScript'] });
  rejectsTechnology('Atlas uses React.', k, 'React');
  rejectsTechnology('Atlas uses Vue.', k, 'Vue');
});

test('affirmative project description supports technologies omitted from tech array', () => {
  const k = knowledge({ description: 'Built with AWS Lambda and DynamoDB.' });
  assert.deepEqual(invalidTech('Atlas uses AWS Lambda and DynamoDB.', k), []);
});

test('explicit tech supports actual use with normalized aliases', () => {
  const k = knowledge({ aliases: ['Atlas Dashboard'], tech: ['React.js', 'NodeJS', 'Postgres', 'Golang'] });
  assert.deepEqual(invalidTech('Atlas Dashboard uses React, Node.js, PostgreSQL and Go.', k), []);
});

for (const kind of ['project', 'direct-answer', 'faq', 'source']) {
  test(`${kind} source authority never replaces a relation cue`, () => {
    const evidence = [{ kind, name: 'Atlas', description: 'Atlas compares React and Vue.' }];
    assert.equal(evidenceSupportsTechnologyRelation(['Atlas'], 'React', evidence), false);
    assert.equal(evidenceSupportsTechnologyRelation(['Atlas'], 'Vue', evidence), false);
    rejectsTechnology('Atlas uses React.', knowledge(), 'React', evidence);
  });
}

for (const description of [
  'Atlas does not use React.',
  'Atlas never used React.',
  'Atlas was not built with React.',
  'Atlas plans to use React.',
  'Atlas will be built with React.',
  'Atlas could use React.',
  'Atlas compares React and Vue.',
  'Atlas uses JavaScript to compare React and Vue.',
  'Atlas uses JavaScript, not React.',
  'Atlas uses JavaScript rather than React.',
  'Atlas uses JavaScript; Orion uses React.',
  'Atlas uses JavaScript and Orion uses React.',
  'Atlas uses JavaScript, while Orion uses React.',
  'Atlas compares Orion, which uses React.',
  'Orion uses React to compare Atlas.',
  'Atlas: Orion is built with React.'
]) {
  test(`non-supporting proposition: ${description}`, () => {
    const evidence = [{ kind: 'project', name: 'Atlas', description }];
    assert.equal(evidenceSupportsTechnologyRelation(['Atlas'], 'React', evidence), false);
    rejectsTechnology('Atlas uses React.', knowledge(), 'React', evidence);
    rejectsTechnology('Atlas uses React.', knowledge({ description }), 'React');
  });
}

test('negation in one clause does not suppress a later unsupported claim', () => {
  rejectsTechnology('Atlas does not use Vue; Atlas uses React.', knowledge(), 'React');
});

test('different named projects in one answer retain their own technology scopes', () => {
  const k = knowledge({ tech: ['JavaScript'] });
  k.projects.push({ name: 'Orion', tech: ['React'] });
  assert.deepEqual(invalidTech('Atlas uses JavaScript and Orion uses React.', k), []);
  rejectsTechnology('Atlas uses JavaScript and Orion uses Vue.', k, 'Vue');
});

for (const metadata of [{ name: 'Atlas' }, { sourceEntity: 'Atlas' }]) {
  test(`structured ${Object.keys(metadata)[0]} retains subject provenance without changing prose`, () => {
    const evidence = [{ kind: 'project', ...metadata, description: 'Built with AWS Lambda and DynamoDB.' }];
    const blocks = splitEvidenceBlocks(evidence);
    assert.equal(blocks[0][Object.keys(metadata)[0]], 'Atlas');
    assert.equal(blocks[0].text, evidence[0].description);
    assert.equal(blocks[0].raw, evidence[0].description);
    const packet = buildRagEvidence(evidence, 2000, 8, 'SKILL');
    assert.ok(!packet.text.includes('[project'));
    assert.ok(!packet.text.includes('sourceEntity'));
    assert.equal(evidenceSupportsTechnologyRelation(['Atlas'], 'AWS Lambda', packet.selected), true);
    assert.deepEqual(invalidTech('Atlas uses AWS Lambda and DynamoDB.', knowledge(), packet.selected), []);
    assert.deepEqual(validateClaims('Atlas uses AWS Lambda and DynamoDB.', 'What does Atlas use?', null, packet.text, knowledge(), packet.selected), []);
    assert.equal(evidenceSupportsTechnologyRelation(['Orion'], 'AWS Lambda', packet.selected), false);
  });
}

test('structured scope cannot borrow another evidence block or override an explicit other subject', () => {
  const evidence = [
    { kind: 'project', name: 'Atlas', description: 'A JavaScript application.' },
    { kind: 'project', name: 'Orion', description: 'Built with React.' }
  ];
  rejectsTechnology('Atlas uses React.', knowledge(), 'React', evidence);
  rejectsTechnology('Atlas uses React.', knowledge(), 'React', [{ kind: 'project', name: 'Atlas', description: 'Orion is built with React.' }]);
});

test('same-block explicit relation and legacy fact format still support use', () => {
  const evidence = 'FACT 1 [project:Atlas]\nAtlas is built with React and Node.js.';
  assert.equal(evidenceSupportsTechnologyRelation(['Atlas'], 'React', evidence), true);
  assert.deepEqual(invalidTech('Atlas uses React and NodeJS.', knowledge(), evidence), []);
});

for (const relation of ['uses_tech', 'uses_platform']) {
  test(`explicit graph ${relation} supports the scoped project and normalized technology alias`, () => {
    const k = knowledge({ aliases: ['Atlas Dashboard'] }, {
      relationships: [{ subject: 'Atlas', relation, object: 'React.js' }]
    });
    assert.deepEqual(invalidTech('Atlas Dashboard uses React.', k), []);
    rejectsTechnology('Atlas uses Vue.', k, 'Vue');
    const unrelated = knowledge({}, { relationships: [{ subject: 'Orion', relation, object: 'React' }] });
    rejectsTechnology('Atlas uses React.', unrelated, 'React');
  });
}
