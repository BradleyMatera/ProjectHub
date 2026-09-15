'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { extractClaims, configureEntityNames } = require('../lib/claim-extractor');
const { validateRelationships } = require('../lib/relationship-validator');
const { buildResponseContract } = require('../lib/response-contract');

const expert = {
  identity: {
    name: 'Morgan Vale',
    preferredName: 'Morgan',
    title: 'Senior Database Architect',
    has_expertise: ['PostgreSQL'],
    specializes_in: ['distributed database architecture'],
    has_extensive_experience: ['database migrations']
  },
  skills: ['PostgreSQL']
};
const expertAnswer = 'Morgan has expertise in PostgreSQL. Morgan specializes in distributed database architecture.';

function validate(answer, knowledge, contract = null, question = 'What is Morgan experienced in?') {
  configureEntityNames({ subjectNames: [knowledge.identity?.name, knowledge.identity?.preferredName].filter(Boolean) });
  return validateRelationships(answer, buildRelationshipGraph(knowledge), question, [], '', null, { contract });
}

test('extract expertise as factual relations rather than automatic overclaims', () => {
  const claims = extractClaims(expertAnswer, buildRelationshipGraph(expert));
  for (const relation of ['has_expertise', 'specializes_in']) {
    const claim = claims.find(c => c.relation === relation);
    assert.ok(claim, relation);
    assert.equal(claim.type, 'FACT');
    assert.equal(claim.overclaim, false);
  }
  assert.equal(claims.find(c => c.relation === 'specializes_in').object, 'distributed database architecture');
});

test('explicit expert relations are indexed with source provenance and accepted', () => {
  const graph = buildRelationshipGraph(expert);
  assert.ok(graph.triples.some(t => t.relation === 'has_expertise' && t.source === 'identity.has_expertise[0]'));
  const result = validate(expertAnswer, expert);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(validate('Morgan has extensive experience in database migrations.', expert).valid, true);
});

test('same expert title without relation evidence rejects expertise and specialization', () => {
  const result = validate(expertAnswer, { identity: { name: 'Morgan Vale', preferredName: 'Morgan', title: 'Senior Database Architect' } });
  assert.equal(result.valid, false);
  assert.ok(result.overclaimClaims.length >= 2);
});

test('skill-only evidence cannot upgrade to expertise and empty knowledge fails closed', () => {
  assert.equal(validate('Morgan has expertise in PostgreSQL.', { identity: { name: 'Morgan' }, skills: ['PostgreSQL'] }).valid, false);
  assert.equal(validate('Morgan has expertise in PostgreSQL.', {}).valid, false);
  assert.equal(validate('Bradley is an AWS expert.', require('../data/recruiter-knowledge.json'), null, 'Is Bradley an AWS expert?').valid, false);
});

test('documented expertise does not override a weaker contract ceiling', () => {
  const result = validate(expertAnswer, expert, { claimCeiling: 'has project experience with', evidenceStrength: 'PROJECT' });
  assert.equal(result.valid, false);
  assert.ok(result.overclaimClaims.length >= 2);
});

test('expert profile contract permits only explicitly documented expertise relations', () => {
  const evidence = 'Morgan Vale is a Senior Database Architect. Morgan has expertise in PostgreSQL. Morgan specializes in distributed database architecture.';
  const contract = buildResponseContract('Who is Morgan?', evidence, expert);
  assert.ok(contract.allowedExpertiseRelations?.some(c => c.relation === 'has_expertise' && c.object === 'PostgreSQL'));
  assert.equal(validate(expertAnswer, expert, contract, 'Who is Morgan?').valid, true);
  assert.equal(validate('Morgan has expertise in Redis.', expert, contract).valid, false);
});

test('unknown mastery instructions do not invent junior status or Bradley for another tenant', () => {
  const knowledge = { identity: { name: 'Morgan Vale', preferredName: 'Morgan', title: 'Senior Database Architect' }, projects: [{ name: 'Ledger', tech: ['PostgreSQL'] }] };
  const contract = buildResponseContract('Does Morgan know PostgreSQL well?', 'Morgan built Ledger using PostgreSQL.', knowledge);
  assert.doesNotMatch(contract.naturalInstructions, /Bradley|"junior"|still learning|not advanced/);
});

const applications = {
  identity: { name: 'Morgan Vale' },
  projects: [
    { name: 'Atlas', aliases: ['Atlas App'], category: 'application', tech: ['PostgreSQL'] },
    { name: 'Orion', category: 'application', tech: ['Redis'] }
  ]
};

test('This application resolves to the single known question entity', () => {
  const graph = buildRelationshipGraph(applications);
  const claims = extractClaims('This application uses PostgreSQL.', graph, 'Tell me about Atlas.');
  assert.ok(claims.some(c => c.subject === 'Atlas' && c.relation === 'uses_tech' && c.object === 'PostgreSQL'));
  assert.equal(validateRelationships('This application uses PostgreSQL.', graph, 'Tell me about Atlas.').valid, true);
  assert.equal(validateRelationships('This application uses Redis.', graph, 'Tell me about Atlas.').valid, false);
});

test('ambiguous multi-entity question cannot choose first entity or stale history', () => {
  const graph = buildRelationshipGraph(applications);
  for (const history of [[], [{ role: 'user', text: 'Tell me about Atlas.' }]]) {
    const claims = extractClaims('This application uses PostgreSQL.', graph, 'Compare Atlas and Orion.', history);
    assert.ok(!claims.some(c => c.subject === 'Atlas' || c.subject === 'Orion'), JSON.stringify(claims));
    assert.equal(validateRelationships('This application uses PostgreSQL.', graph, 'Compare Atlas and Orion.', history).valid, false);
  }
});
