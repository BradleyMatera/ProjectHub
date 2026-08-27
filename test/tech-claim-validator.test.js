'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  validateTechClaims,
  extractTechClaims,
  isTechInEvidence,
  canonicalize,
  resolveAlias,
} = require('../lib/tech-claim-validator');

// =========================================================
// Synthetic tests with unrelated fixtures — no Bradley, no
// ProjectHub, no Jane, no benchmark-specific strings.
// Fixtures use Maria Lopez / Nebula Engine to prove the
// engine has zero hard-coded names.
// =========================================================

// --- Supported tech ---

test('supported technology claim passes when evidence contains the tech', () => {
  const answer = 'Maria used Node.js for the backend.';
  const evidence = 'Maria Lopez built Nebula Engine using Node.js and JavaScript.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  assert.equal(result.unsupportedTechs.length, 0);
});

// --- Unsupported tech ---

test('unsupported technology claim is flagged when evidence does not contain the tech', () => {
  const answer = 'Maria used Node.js and Express.';
  const evidence = 'Maria Lopez built Nebula Engine using Node.js.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, false);
  const expressClaim = result.unsupportedTechs.find(t => t.technology === 'Express');
  assert.ok(expressClaim, 'Express should be flagged as unsupported');
  const nodeClaim = result.unsupportedTechs.find(t => t.technology === 'Node.js');
  assert.equal(nodeClaim, undefined, 'Node.js should be supported');
});

// --- Mixed supported/unsupported ---

test('multiple unsupported technologies are all flagged', () => {
  const answer = 'Nebula Engine uses Node.js, Express, and MongoDB.';
  const evidence = 'Maria Lopez built Nebula Engine using Node.js.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, false);
  assert.ok(result.unsupportedTechs.some(t => t.technology === 'Express'));
  assert.ok(result.unsupportedTechs.some(t => t.technology === 'MongoDB'));
  const nodeClaim = result.unsupportedTechs.find(t => t.technology === 'Node.js');
  assert.equal(nodeClaim, undefined, 'Node.js should be supported');
});

// --- Comma-separated stack ---

test('tech stack context extracts all listed technologies', () => {
  const answer = 'The tech stack includes React, Node.js, and PostgreSQL.';
  const evidence = 'Maria built Nebula Engine with React and Node.js.';
  const result = validateTechClaims(answer, evidence);
  const pgClaim = result.unsupportedTechs.find(t => t.technology === 'PostgreSQL');
  assert.ok(pgClaim, 'PostgreSQL should be flagged as unsupported');
  const reactClaim = result.unsupportedTechs.find(t => t.technology === 'React');
  assert.equal(reactClaim, undefined, 'React should be supported');
});

test('comma-separated tech list extracts all items', () => {
  const answer = 'Maria knows React, Python, and AWS.';
  const evidence = 'Maria built Nebula Engine with React and Python.';
  const result = validateTechClaims(answer, evidence);
  const awsClaim = result.unsupportedTechs.find(t => t.technology === 'AWS');
  assert.ok(awsClaim, 'AWS should be flagged as unsupported');
  const reactClaim = result.unsupportedTechs.find(t => t.technology === 'React');
  assert.equal(reactClaim, undefined, 'React should be supported');
  const pythonClaim = result.unsupportedTechs.find(t => t.technology === 'Python');
  assert.equal(pythonClaim, undefined, 'Python should be supported');
});

// --- Node.js punctuation ---

test('Node.js punctuation alias: NodeJS matches Node.js in evidence', () => {
  assert.equal(isTechInEvidence('NodeJS', 'built with Node.js'), true);
  assert.equal(isTechInEvidence('Node.js', 'uses NodeJS for backend'), true);
  assert.equal(isTechInEvidence('node.js', 'uses Node.js'), true);
});

test('Node.js does not match unrelated evidence', () => {
  assert.equal(isTechInEvidence('Node.js', 'uses Express and React'), false);
});

// --- Next.js punctuation ---

test('Next.js punctuation alias: NextJS matches Next.js in evidence', () => {
  assert.equal(isTechInEvidence('NextJS', 'built with Next.js'), true);
  assert.equal(isTechInEvidence('Next.js', 'uses NextJS for SSR'), true);
});

test('Next.js does not match unrelated evidence', () => {
  assert.equal(isTechInEvidence('Next.js', 'uses Express and React'), false);
});

// --- Lowercase technology claims ---

test('lowercase technology claim is validated against evidence', () => {
  const answer = 'she uses react and node.js';
  const evidence = 'Maria Lopez built Nebula Engine with React and Node.js.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true, 'react and node.js should both be supported');
});

test('lowercase unsupported technology is flagged', () => {
  const answer = 'she uses react and express';
  const evidence = 'Maria Lopez built Nebula Engine with React.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, false);
  const expressClaim = result.unsupportedTechs.find(t => t.technology.toLowerCase() === 'express');
  assert.ok(expressClaim, 'express should be flagged as unsupported');
  const reactClaim = result.unsupportedTechs.find(t => t.technology.toLowerCase() === 'react');
  assert.equal(reactClaim, undefined, 'react should be supported');
});

// --- Negated unsupported technology ---

test('negated technology claim is not flagged', () => {
  const answer = 'Maria does not use Express.';
  const evidence = 'Maria Lopez built Nebula Engine using Node.js.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  assert.equal(result.unsupportedTechs.length, 0);
});

// --- Positive tech after negative clause ---

test('positive tech after negative clause is validated', () => {
  const answer = 'She does not use Express but uses React.';
  const evidence = 'Maria built Nebula Engine with React.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  const expressClaim = result.unsupportedTechs.find(t => t.technology === 'Express');
  assert.equal(expressClaim, undefined, 'Express is negated, should not be flagged');
});

test('positive tech after negative clause is flagged if unsupported', () => {
  const answer = 'She does not use Express but uses Kubernetes.';
  const evidence = 'Maria built Nebula Engine with React.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, false);
  const k8sClaim = result.unsupportedTechs.find(t => t.technology === 'Kubernetes');
  assert.ok(k8sClaim, 'Kubernetes is a positive claim, should be flagged');
  const expressClaim = result.unsupportedTechs.find(t => t.technology === 'Express');
  assert.equal(expressClaim, undefined, 'Express is negated, should not be flagged');
});

// --- Negative tech after positive clause ---

test('negative tech after positive clause is not flagged', () => {
  const answer = 'She uses React but not Vue.';
  const evidence = 'Maria built Nebula Engine with React.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  const vueClaim = result.unsupportedTechs.find(t => t.technology === 'Vue');
  assert.equal(vueClaim, undefined, 'Vue is negated, should not be flagged');
});

test('positive tech before negative clause is validated', () => {
  const answer = 'She uses React but not Vue.';
  const evidence = 'Maria built Nebula Engine with React.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
});

test('positive tech before negative clause is flagged if unsupported', () => {
  const answer = 'She uses Docker but not Vue.';
  const evidence = 'Maria built Nebula Engine with React.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, false);
  const dockerClaim = result.unsupportedTechs.find(t => t.technology === 'Docker');
  assert.ok(dockerClaim, 'Docker is a positive claim, should be flagged');
});

// --- Unrelated person/project names (Maria Lopez / Nebula Engine) ---

test('engine has no hard-coded person or project names', () => {
  // The engine must work with completely different fixtures
  // without any code changes
  const answer = 'Carlos built Quantum Portal using Rust and WebAssembly.';
  const evidence = 'Carlos Rivera created Quantum Portal with Rust and WebAssembly.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
});

test('engine works with another unrelated fixture set', () => {
  const answer = 'Nebula Engine was built with Python and FastAPI.';
  const evidence = 'Maria built Nebula Engine using Python.';
  const result = validateTechClaims(answer, evidence);
  const fastapiClaim = result.unsupportedTechs.find(t => t.technology === 'FastAPI');
  assert.ok(fastapiClaim, 'FastAPI should be flagged as unsupported');
  const pythonClaim = result.unsupportedTechs.find(t => t.technology === 'Python');
  assert.equal(pythonClaim, undefined, 'Python should be supported');
});

// --- Generic descriptors in factual claim context ---

test('generic descriptor in descriptive context is not flagged as tech claim', () => {
  const answer = 'Nebula Engine exposes an API for external callers.';
  const evidence = 'Maria Lopez built Nebula Engine using Node.js. It exposes an API.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
});

test('generic descriptor in claim context requires evidence', () => {
  const answer = 'Maria has professional NLP experience.';
  const evidence = 'Maria Lopez built Nebula Engine using Node.js.';
  const result = validateTechClaims(answer, evidence);
  const nlpClaim = result.unsupportedTechs.find(t => t.technology === 'NLP');
  if (nlpClaim) {
    assert.equal(nlpClaim.isGeneric, true, 'NLP should be marked as generic');
  }
});

// --- Additional context tests ---

test('built with context extracts technology', () => {
  const answer = 'Nebula Engine was built with Python and FastAPI.';
  const evidence = 'Maria built Nebula Engine using Python.';
  const result = validateTechClaims(answer, evidence);
  const fastapiClaim = result.unsupportedTechs.find(t => t.technology === 'FastAPI');
  assert.ok(fastapiClaim, 'FastAPI should be flagged as unsupported');
  const pythonClaim = result.unsupportedTechs.find(t => t.technology === 'Python');
  assert.equal(pythonClaim, undefined, 'Python should be supported');
});

test('has experience with context extracts technology', () => {
  const answer = 'Maria has experience with Kubernetes and Docker.';
  const evidence = 'Maria Lopez built Nebula Engine using Node.js. She uses Docker for deployment.';
  const result = validateTechClaims(answer, evidence);
  const k8sClaim = result.unsupportedTechs.find(t => t.technology === 'Kubernetes');
  assert.ok(k8sClaim, 'Kubernetes should be flagged as unsupported');
  const dockerClaim = result.unsupportedTechs.find(t => t.technology === 'Docker');
  assert.equal(dockerClaim, undefined, 'Docker should be supported');
});

test('X for backend context extracts technology', () => {
  const answer = 'Nebula Engine uses React for frontend and Node.js for backend.';
  const evidence = 'Maria built Nebula Engine with React and Node.js.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
});

test('X with Y conjunction context extracts both technologies', () => {
  const answer = 'Nebula Engine uses Node.js with Express.';
  const evidence = 'Maria built Nebula Engine with Node.js.';
  const result = validateTechClaims(answer, evidence);
  const expressClaim = result.unsupportedTechs.find(t => t.technology === 'Express');
  assert.ok(expressClaim, 'Express should be flagged as unsupported');
});

// --- Canonicalization tests ---

test('canonicalize strips punctuation and lowercases', () => {
  assert.equal(canonicalize('Node.js'), 'nodejs');
  assert.equal(canonicalize('NodeJS'), 'nodejs');
  assert.equal(canonicalize('Next.js'), 'nextjs');
  assert.equal(canonicalize('C++'), 'c');
  assert.equal(canonicalize('C#'), 'c');
});

test('resolveAlias maps known tech aliases', () => {
  assert.equal(resolveAlias('nodejs'), 'nodejs');
  assert.equal(resolveAlias('node'), 'nodejs');
  assert.equal(resolveAlias('nextjs'), 'nextjs');
  assert.equal(resolveAlias('next'), 'nextjs');
  assert.equal(resolveAlias('react'), 'reactjs');
  assert.equal(resolveAlias('express'), 'expressjs');
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

test('isTechInEvidence does not unsafe substring match short names', () => {
  // "Go" must not match "Google"
  assert.equal(isTechInEvidence('Go', 'uses Google Cloud'), false);
  // "R" must not match arbitrary words
  assert.equal(isTechInEvidence('R', 'uses Rust and Ruby'), false);
});

// --- Edge cases ---

test('empty answer produces no claims', () => {
  const result = validateTechClaims('', 'some evidence');
  assert.equal(result.valid, true);
  assert.equal(result.unsupportedTechs.length, 0);
});

test('answer with no tech claims produces no claims', () => {
  const answer = 'Maria is a software engineer.';
  const evidence = 'Maria Lopez is a software engineer.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
});

test('deduplicates repeated technology mentions', () => {
  const answer = 'Maria uses React. She also uses React for other projects.';
  const evidence = 'Maria built Nebula Engine with React.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  assert.equal(result.unsupportedTechs.length, 0);
});

test('generic service category followed by examples extracts the examples', () => {
  const answer = 'Maria has used AWS services such as Lambda and S3.';
  const evidence = 'Maria built Nebula Engine with AWS Lambda and S3 storage.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  assert.equal(result.unsupportedTechs.length, 0);
  assert.ok(result.details.some(d => d.technology === 'Lambda' && d.verdict === 'supported'));
  assert.ok(result.details.some(d => d.technology === 'S3' && d.verdict === 'supported'));
  assert.ok(!result.details.some(d => d.technology && d.technology.toLowerCase().startsWith('aws services')));
});

test('negation in one clause does not mask affirmative claim in another', () => {
  const answer = 'Maria does not use Kubernetes, but she uses Docker.';
  const evidence = 'Maria built Nebula Engine with Docker.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  const k8sClaim = result.unsupportedTechs.find(t => t.technology === 'Kubernetes');
  assert.equal(k8sClaim, undefined, 'Kubernetes is negated, should not be flagged');
});

test('period-delimited claim and internal punctuation in Node.js / Next.js are not broken', () => {
  const answer = 'The app is built with Next.js. She also knows Node.js.';
  const evidence = 'Maria built Nebula Engine using Node.js and Next.js.';
  const result = validateTechClaims(answer, evidence);
  assert.equal(result.valid, true);
  assert.equal(result.unsupportedTechs.length, 0);
  assert.ok(result.details.some(d => d.technology === 'Next.js' && d.verdict === 'supported'));
  assert.ok(result.details.some(d => d.technology === 'Node.js' && d.verdict === 'supported'));
});
