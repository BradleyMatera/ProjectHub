'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { validateRelationships } = require('../lib/relationship-validator');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { validateProjectTechnologyRelationships } = require('../lib/claim-validator');
const { isTechInEvidence } = require('../lib/tech-claim-validator');
const { evidenceSupportsTechnologyRelation } = require('../lib/evidence-relations');
const { extractClaims } = require('../lib/claim-extractor');
const { isTokenNegated } = require('../lib/negation-scope');
const { validateAnswer } = require('../lib/grounding-validator');

// =========================================================
// Tenant-agnostic regression tests for RAG evidence-aware
// validation fixes.
// =========================================================

function makeKnowledge(opts = {}) {
  return {
    identity: { name: opts.name || 'Alex Doe', preferredName: opts.preferredName || 'Alex' },
    skills: opts.skills || { core: ['React'] },
    projects: opts.projects || [{ name: 'Atlas', category: 'web app', tech: ['React'] }],
  };
}

// --- 1. Candidate uses_tech -> has_skill fallback ---

test('validateRelationships: candidate uses_tech falls back to has_skill', () => {
  const graph = buildRelationshipGraph(makeKnowledge({
    skills: { core: ['React', 'Node.js'] },
    projects: [{ name: 'Atlas', category: 'web app', tech: ['React'] }]
  }));
  const result = validateRelationships('Alex uses React.', graph, '', [], '');
  assert.equal(result.valid, true);
  const detail = result.details.find(d => d.claim?.relation === 'uses_tech');
  assert.ok(detail, 'Expected a uses_tech claim to be validated');
  assert.equal(detail.verdict, 'supported');
  assert.ok(detail.message.includes('has_skill'), detail.message);
});

test('validateRelationships: candidate uses_tech without skill is still unsupported', () => {
  const graph = buildRelationshipGraph(makeKnowledge({
    skills: { core: ['React'] },
    projects: [{ name: 'Atlas', category: 'web app', tech: ['React'] }]
  }));
  const result = validateRelationships('Alex uses Kubernetes.', graph, '', [], '');
  assert.equal(result.valid, false);
  assert.ok(result.unsupportedClaims.some(uc =>
    uc.relation === 'uses_tech' && uc.object.toLowerCase().includes('kubernetes')));
});

// --- 2. Project uses_tech backed by same-FACT evidence ---

test('validateRelationships: project uses_tech supported by same-FACT evidence', () => {
  const graph = buildRelationshipGraph(makeKnowledge({
    skills: { core: ['React'] },
    projects: [{ name: 'Orion', category: 'web app', tech: [] }]
  }));
  const evidence = 'FACT 1 [project:Orion]\nOrion is built with React and Node.js.';
  const result = validateRelationships('Orion uses React.', graph, '', [], evidence);
  assert.equal(result.valid, true);
  assert.ok(result.details.some(d => d.verdict === 'supported' &&
    d.message.includes('retrieved evidence')));
});

test('validateRelationships: cross-FACT uses_tech contamination is rejected', () => {
  const graph = buildRelationshipGraph(makeKnowledge({
    skills: { core: ['React'] },
    projects: [
      { name: 'Atlas', category: 'web app', tech: ['React'] },
      { name: 'Orion', category: 'web app', tech: ['Vue'] }
    ]
  }));
  const evidence =
    'FACT 1 [project:Atlas]\nAtlas uses React.\n\n' +
    'FACT 2 [project:Orion]\nOrion uses Vue.';
  const result = validateRelationships('Atlas uses Vue.', graph, '', [], evidence);
  assert.equal(result.valid, false);
  assert.ok(result.unsupportedClaims.some(uc =>
    uc.relation === 'uses_tech' && uc.object.toLowerCase().includes('vue')));
});

// --- 3. evidence-relations helper: same-block co-occurrence ---

test('evidenceSupportsTechnologyRelation: requires subject and tech in the same fact block', () => {
  const evidence =
    'FACT 1 [project:Atlas]\nAtlas uses React.\n\n' +
    'FACT 2 [project:Orion]\nOrion uses Vue.';

  assert.ok(
    evidenceSupportsTechnologyRelation(['Atlas'], 'React', evidence),
    'Atlas and React should match within fact 1'
  );
  assert.ok(
    !evidenceSupportsTechnologyRelation(['Atlas'], 'Vue', evidence),
    'Atlas and Vue are in different blocks and should not match'
  );
});

// --- 4. Token-sequence tech matching: Go vs Google ---

test('isTechInEvidence: Go does not match Google via substring', () => {
  const evidence = 'Atlas is built with Google Cloud and React.';
  assert.equal(isTechInEvidence('Go', evidence), false);
  assert.equal(isTechInEvidence('Google Cloud', evidence), true);
  assert.equal(isTechInEvidence('Go', 'Atlas is built with Go.'), true);
});

test('isTechInEvidence: multi-token vanilla JavaScript is matched correctly', () => {
  const evidence = 'Atlas is built with vanilla JavaScript and HTML/CSS.';
  assert.equal(isTechInEvidence('vanilla JavaScript', evidence), true);
  assert.equal(isTechInEvidence('vanilla', evidence), true);
  assert.equal(isTechInEvidence('HTML/CSS', evidence), true);
});

// --- 5. claim-validator: project technology claims use token-sequence matching ---

test('validateProjectTechnologyRelationships: Google Cloud not confused with Go', () => {
  const knowledge = makeKnowledge({
    skills: { core: ['Go'] },
    projects: [{ name: 'Atlas', category: 'web app', tech: ['Google Cloud'] }]
  });
  const invalid = validateProjectTechnologyRelationships(
    'Atlas uses Google Cloud.', null, knowledge, ''
  );
  assert.deepEqual(invalid, []);
});

test('validateProjectTechnologyRelationships: unsupported project tech still flagged', () => {
  const knowledge = makeKnowledge({
    skills: { core: ['Go'] },
    projects: [{ name: 'Atlas', category: 'web app', tech: ['React'] }]
  });
  const invalid = validateProjectTechnologyRelationships(
    'Atlas uses Go and Vue.', null, knowledge, ''
  );
  const details = invalid.filter(i => i.type === 'PROJECT_RELATIONSHIP_CLAIM');
  assert.ok(details.length >= 1);
  assert.ok(details.some(d => d.detail.toLowerCase().includes('go') || d.detail.toLowerCase().includes('vue')));
});

test('validateProjectTechnologyRelationships: evidence rescues project tech claim', () => {
  const knowledge = makeKnowledge({
    skills: { core: ['React'] },
    projects: [{ name: 'Orion', category: 'web app', tech: [] }]
  });
  const evidence = 'FACT 1 [project:Orion]\nOrion uses vanilla JavaScript.';
  const invalid = validateProjectTechnologyRelationships(
    'Orion uses vanilla JavaScript.', null, knowledge, evidence
  );
  assert.deepEqual(invalid, []);
});

// --- 6. claim-extractor: degree and certificate false extraction ---

test('extractClaims: degree not extracted from narrative phrases', () => {
  const graph = buildRelationshipGraph(makeKnowledge({
    skills: { core: ['AWS', 'React'] },
    projects: [{ name: 'Atlas', category: 'web app', tech: ['React'] }]
  }));
  const claims = extractClaims(
    'He has AWS experience from an internship and holds AWS certifications.',
    graph
  );
  const degreeClaims = claims.filter(c => c.relation === 'has_degree');
  assert.equal(degreeClaims.length, 0, 'Should not extract false has_degree claims');

  const certClaims = claims.filter(c => c.relation === 'has_cert');
  assert.ok(certClaims.length >= 1, 'Should recover the valid has_cert claim');
  assert.ok(certClaims.every(c =>
    !/\b(?:experience|internship|project|work|role|job)\b/i.test(c.object)
  ), 'Cert objects must not contain narrative words');
});

test('extractClaims: legitimate degree and certificate claims still extracted', () => {
  const graph = buildRelationshipGraph(makeKnowledge({
    skills: { core: ['React'] },
    projects: [{ name: 'Atlas', category: 'web app', tech: ['React'] }]
  }));
  const claims = extractClaims(
    'He has a Bachelor of Science in Computer Science from State University and holds AWS certifications.',
    graph
  );
  assert.ok(claims.some(c => c.relation === 'has_degree' && c.object.toLowerCase().includes('state university')));
  assert.ok(claims.some(c => c.relation === 'has_cert' && c.object.toLowerCase().includes('aws')));
});

// --- 7. Negation scope: question entity in a denial clause ---

test('isTokenNegated: tokenized matching avoids Go matching Google', () => {
  assert.equal(isTokenNegated('He does not know Go.', 'Go'), true);
  assert.equal(isTokenNegated('He does not know Go.', 'Google'), false);
  assert.equal(isTokenNegated('No, he does not use Google Cloud.', 'Google Cloud'), true);
});

test('isTokenNegated: question entity in denial is detected', () => {
  assert.equal(isTokenNegated('No, Alex does not know COBOL.', 'COBOL'), true);
  assert.equal(isTokenNegated('Yes, Alex knows COBOL.', 'COBOL'), false);
});

// --- 8. Grounding validator: question entity in denial is not flagged ungrounded ---

test('validateAnswer: question entity repeated inside a denial is not entity_not_grounded', () => {
  const knowledge = makeKnowledge({
    skills: { core: ['React'] },
    projects: [{ name: 'Atlas', category: 'web app', tech: ['React'] }]
  });
  const graph = buildRelationshipGraph(knowledge);
  // Evidence must mention the denied topic so content-overlap checks do not
  // block a valid refutation.
  const source = 'FACT 1 [profile]\nAlex is skilled in React and has no COBOL experience.';
  const result = validateAnswer(
    'No, Alex does not know COBOL.',
    source,
    'Does Alex know COBOL?',
    knowledge,
    [],
    graph
  );
  assert.equal(result.valid, true);
  assert.ok(!result.reasons.some(r => r.startsWith('entity_not_grounded')));
});

// --- 9. Negative: positive unsupported claim for question entity is still caught ---

test('validateAnswer: positive unsupported claim for a question entity still fails', () => {
  const knowledge = makeKnowledge({
    skills: { core: ['React'] },
    projects: [{ name: 'Atlas', category: 'web app', tech: ['React'] }]
  });
  const graph = buildRelationshipGraph(knowledge);
  const source = 'FACT 1 [profile]\nAlex is skilled in React.';
  const result = validateAnswer(
    'Alex knows COBOL.',
    source,
    'Does Alex know COBOL?',
    knowledge,
    [],
    graph
  );
  assert.equal(result.valid, false);
});
