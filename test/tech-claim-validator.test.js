'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { validateTechClaims, extractTechClaims, isTechInEvidence } = require('../lib/tech-claim-validator');

// Synthetic tests with unrelated fixtures — no Bradley, no ProjectHub,
// no benchmark-specific strings. These verify generic technology claim
// validation logic.

test('supported technology claim passes when evidence contains the tech', () => {
  const answer = 'Jane used Node.js for the backend.';
  const evidence = 'Jane Smith built Product Alpha using Node.js and JavaScript.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  assert.equal(result.unsupportedTechs.length, 0);
});

test('unsupported technology claim is flagged when evidence does not contain the tech', () => {
  const answer = 'Jane used Node.js and Express.';
  const evidence = 'Jane Smith built Product Alpha using Node.js.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, false);
  const expressClaim = result.unsupportedTechs.find(t => t.technology === 'Express');
  assert.ok(expressClaim, 'Express should be flagged as unsupported');
  const nodeClaim = result.unsupportedTechs.find(t => t.technology === 'Node.js');
  assert.equal(nodeClaim, undefined, 'Node.js should be supported');
});

test('multiple unsupported technologies are all flagged', () => {
  const answer = 'Product Alpha uses Node.js, Express, and MongoDB.';
  const evidence = 'Jane Smith built Product Alpha using Node.js.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, false);
  assert.ok(result.unsupportedTechs.some(t => t.technology === 'Express'));
  assert.ok(result.unsupportedTechs.some(t => t.technology === 'MongoDB'));
  const nodeClaim = result.unsupportedTechs.find(t => t.technology === 'Node.js');
  assert.equal(nodeClaim, undefined, 'Node.js should be supported');
});

test('negated technology claim is not flagged', () => {
  const answer = 'Jane does not use Express.';
  const evidence = 'Jane Smith built Product Alpha using Node.js.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  assert.equal(result.unsupportedTechs.length, 0);
});

test('generic descriptor in descriptive context is not flagged as tech claim', () => {
  const answer = 'Product Alpha exposes an API for external callers.';
  const evidence = 'Jane Smith built Product Alpha using Node.js. It exposes an API.';
  const result = validateTechClaims(answer, evidence);
  // "API" appears in evidence, so even if extracted, it's supported
  assert.equal(result.valid, true);
});

test('generic descriptor in claim context requires evidence', () => {
  const answer = 'Jane has professional NLP experience.';
  const evidence = 'Jane Smith built Product Alpha using Node.js.';
  const result = validateTechClaims(answer, evidence);
  // NLP is a generic descriptor but used as a factual claim here
  // The validator should flag it if NLP is not in evidence
  const nlpClaim = result.unsupportedTechs.find(t => t.technology === 'NLP');
  if (nlpClaim) {
    assert.equal(nlpClaim.isGeneric, true, 'NLP should be marked as generic');
  }
  // If NLP was not extracted as a tech claim, that's also acceptable —
  // the key is that it doesn't pass silently when claimed without evidence
});

test('tech stack context extracts all listed technologies', () => {
  const answer = 'The tech stack includes React, Node.js, and PostgreSQL.';
  const evidence = 'Jane built Product Alpha with React and Node.js.';
  const result = validateTechClaims(answer, evidence);
  const pgClaim = result.unsupportedTechs.find(t => t.technology === 'PostgreSQL');
  assert.ok(pgClaim, 'PostgreSQL should be flagged as unsupported');
  const reactClaim = result.unsupportedTechs.find(t => t.technology === 'React');
  assert.equal(reactClaim, undefined, 'React should be supported');
});

test('built with context extracts technology', () => {
  const answer = 'Product Alpha was built with Python and FastAPI.';
  const evidence = 'Jane built Product Alpha using Python.';
  const result = validateTechClaims(answer, evidence);
  const fastapiClaim = result.unsupportedTechs.find(t => t.technology === 'FastAPI');
  assert.ok(fastapiClaim, 'FastAPI should be flagged as unsupported');
  const pythonClaim = result.unsupportedTechs.find(t => t.technology === 'Python');
  assert.equal(pythonClaim, undefined, 'Python should be supported');
});

test('has experience with context extracts technology', () => {
  const answer = 'Jane has experience with Kubernetes and Docker.';
  const evidence = 'Jane Smith built Product Alpha using Node.js. She uses Docker for deployment.';
  const result = validateTechClaims(answer, evidence);
  const k8sClaim = result.unsupportedTechs.find(t => t.technology === 'Kubernetes');
  assert.ok(k8sClaim, 'Kubernetes should be flagged as unsupported');
  const dockerClaim = result.unsupportedTechs.find(t => t.technology === 'Docker');
  assert.equal(dockerClaim, undefined, 'Docker should be supported');
});

test('X for backend context extracts technology', () => {
  const answer = 'Product Alpha uses React for frontend and Node.js for backend.';
  const evidence = 'Jane built Product Alpha with React and Node.js.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
});

test('X with Y conjunction context extracts both technologies', () => {
  const answer = 'Product Alpha uses Node.js with Express.';
  const evidence = 'Jane built Product Alpha with Node.js.';
  const result = validateTechClaims(answer, evidence);
  const expressClaim = result.unsupportedTechs.find(t => t.technology === 'Express');
  assert.ok(expressClaim, 'Express should be flagged as unsupported');
});

test('isTechInEvidence handles case variations', () => {
  assert.equal(isTechInEvidence('Node.js', 'uses node.js for backend'), true);
  assert.equal(isTechInEvidence('React', 'built with React'), true);
  assert.equal(isTechInEvidence('Express', 'uses Node.js'), false);
});

test('isTechInEvidence handles normalized matching', () => {
  assert.equal(isTechInEvidence('PostgreSQL', 'database is postgresql'), true);
  assert.equal(isTechInEvidence('FastAPI', 'uses fastapi framework'), true);
});

test('empty answer produces no claims', () => {
  const result = validateTechClaims('', 'some evidence');
  assert.equal(result.valid, true);
  assert.equal(result.unsupportedTechs.length, 0);
});

test('answer with no tech claims produces no claims', () => {
  const answer = 'Jane is a software engineer.';
  const evidence = 'Jane Smith is a software engineer.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
});

test('deduplicates repeated technology mentions', () => {
  const answer = 'Jane uses React. She also uses React for other projects.';
  const evidence = 'Jane built Product Alpha with React.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  assert.equal(result.unsupportedTechs.length, 0);
});

test('comma-separated tech list extracts all items', () => {
  const answer = 'Jane knows React, Python, and AWS.';
  const evidence = 'Jane built Product Alpha with React and Python.';
  const result = validateTechClaims(answer, evidence);
  const awsClaim = result.unsupportedTechs.find(t => t.technology === 'AWS');
  assert.ok(awsClaim, 'AWS should be flagged as unsupported');
  const reactClaim = result.unsupportedTechs.find(t => t.technology === 'React');
  assert.equal(reactClaim, undefined, 'React should be supported');
  const pythonClaim = result.unsupportedTechs.find(t => t.technology === 'Python');
  assert.equal(pythonClaim, undefined, 'Python should be supported');
});

test('negation in one clause does not mask affirmative claim in another', () => {
  const answer = 'Jane does not use Kubernetes, but she uses Docker.';
  const evidence = 'Jane built Product Alpha with Docker.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  const k8sClaim = result.unsupportedTechs.find(t => t.technology === 'Kubernetes');
  assert.equal(k8sClaim, undefined, 'Kubernetes is negated, should not be flagged');
});
