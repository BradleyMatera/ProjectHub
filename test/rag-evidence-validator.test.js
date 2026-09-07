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
    experience: opts.experience || [],
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

// --- 5b. clause-aware project tech validation (regression for live 132 gate) ---

test('validateProjectTechnologyRelationships: tech in a separate clause is not misattributed', () => {
  const knowledge = makeKnowledge({
    skills: { core: ['AI'] },
    projects: [{ name: 'ProjectHub (Scout)', category: 'web app', tech: ['JavaScript', 'Node.js', 'Express'] }]
  });
  const text = 'ProjectHub (Scout) uses a two-branch release model, and it has a canonical instruction source for AI coding agents.';
  const invalid = validateProjectTechnologyRelationships(text, null, knowledge, '');
  assert.deepEqual(invalid, []);
});

test('validateProjectTechnologyRelationships: tech list still validates as a single claim', () => {
  const knowledge = makeKnowledge({
    skills: { core: ['AI'] },
    projects: [{ name: 'Atlas', category: 'web app', tech: ['React'] }]
  });
  const text = 'Atlas uses JavaScript, Node.js, and AI to process data.';
  const invalid = validateProjectTechnologyRelationships(text, null, knowledge, '');
  const details = invalid.filter(i => i.type === 'PROJECT_RELATIONSHIP_CLAIM');
  assert.ok(details.some(d => d.detail.toLowerCase().includes('ai')), 'AI not in Atlas tech should be flagged');
  assert.ok(!details.some(d => d.detail.toLowerCase().includes('javascript') || d.detail.toLowerCase().includes('node.js')), 'tech list items should not be false positives');
});

// --- 5c. project name/description should not be treated as unverified tech ---

test('validateProjectTechnologyRelationships: project name containing the tech is not a false claim', () => {
  const knowledge = makeKnowledge({
    skills: { core: ['AWS'] },
    projects: [{ name: 'AWS Serverless Metadata Extraction Workflow', category: 'web app', tech: ['AWS Lambda', 'DynamoDB'] }]
  });
  const text = 'His AWS internship capstone project uses Lambda and DynamoDB.';
  const invalid = validateProjectTechnologyRelationships(text, null, knowledge, '');
  const details = invalid.filter(i => i.type === 'PROJECT_RELATIONSHIP_CLAIM');
  assert.deepEqual(details, [], 'AWS in the project name should not be an unverified tech claim');
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

// --- 6b. claim-extractor: leading "This application" resolves to primary entity ---

test('extractClaims: "This application uses X" resolves to the question entity', () => {
  const graph = buildRelationshipGraph(makeKnowledge({
    skills: { core: ['React'] },
    projects: [{ name: 'Atlas', category: 'web app', tech: ['React', 'Scout'] }]
  }));
  const claims = extractClaims(
    'This application uses Scout.',
    graph,
    'Tell me about Atlas'
  );
  const uses = claims.find(c => c.relation === 'uses_tech' && c.object.toLowerCase().includes('scout'));
  assert.ok(uses, 'uses_tech claim for Scout should be extracted');
  assert.ok(/\bAtlas\b/.test(uses.subject), 'subject should resolve to the question entity Atlas, not "This application"');
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

// --- 10. project description: disavowal should not trigger unsupported_description ---

test('validateAnswer: saying a project is a separate/unrelated project is not an unsupported description', () => {
  const knowledge = makeKnowledge({
    skills: { core: ['React'] },
    projects: [
      { name: 'ProjectHub', category: 'web app', tech: ['React'], description: 'A portfolio widget with embedded chat.', aliases: ['ProjectHub'] },
      { name: 'Pokedex', category: 'demo', tech: ['React'], description: 'An interactive Pokedex that uses the PokeAPI.' }
    ]
  });
  const graph = buildRelationshipGraph(knowledge);
  const text = 'The Pokedex is a separate project, and its relationship to ProjectHub is not clear.';
  const result = validateAnswer(text, '', 'Tell me about ProjectHub', knowledge, [], graph);
  assert.ok(!result.reasons.some(r => r.startsWith('unsupported_description:')));
});

// --- 11. includes relationship with evidence support ---

test('validateRelationships: project featuring an included app is supported when evidence contains both', () => {
  const knowledge = makeKnowledge({
    skills: { core: ['React'] },
    projects: [
      { name: 'ProjectHub (Scout)', category: 'web app', tech: ['React'], description: 'ProjectHub Recruiter Alpha is the first application built on Scout.' }
    ]
  });
  const graph = buildRelationshipGraph(knowledge);
  const evidence = [{ kind: 'project', description: 'ProjectHub (Scout). ProjectHub Recruiter Alpha is the first application built on Scout. Tech: React' }];
  const result = validateRelationships('ProjectHub features ProjectHub Recruiter Alpha', graph, 'Tell me about ProjectHub', [], '', evidence);
  assert.ok(!result.unsupportedClaims.some(c => c.relation === 'context_drift'));
});

test('isTechInEvidence: multiword project-specific description is supported when it appears in evidence', () => {
  const evidence = 'Scout uses deterministic query understanding, BM25/RRF retrieval, and evidence tools.';
  const known = new Set(['JavaScript', 'React']);
  assert.equal(isTechInEvidence('deterministic query understanding', evidence, known), true);
  assert.equal(isTechInEvidence('BM25/RRF retrieval', evidence, known), true);
});

// --- 12. project-as-company should not fire when the entity is also a known employer ---

test('validateAnswer: project that is also a known employer is not flagged as project_as_company', () => {
  const knowledge = makeKnowledge({
    skills: { core: ['React'] },
    projects: [{ name: 'CIRIS Ethical AI', category: 'web app', tech: ['React'] }],
    experience: [{ company: 'CIRIS Ethical AI', role: 'Junior Frontend Developer', type: 'Freelance', dates: '2024-2025' }]
  });
  const graph = buildRelationshipGraph(knowledge);
  const text = 'Bradley worked as a Junior Frontend Developer at CIRIS Ethical AI.';
  const result = validateAnswer(text, '', 'What jobs has Bradley had?', knowledge, [], graph);
  assert.ok(!result.reasons.some(r => r.startsWith('wrong_relationship:project_as_company')));
});

const boundedRoleKnowledge = makeKnowledge({
  experience: [
    { company: 'Summit Roofing', role: 'Construction Worker' },
    { company: 'Harbor Clinic', role: 'Receptionist' }
  ]
});

for (const [label, text, rejected] of [
  ['documented pair', 'Alex worked as a Construction Worker at Summit Roofing.', false],
  ['invented role at known employer', 'Alex worked as a Neurosurgeon at Summit Roofing.', true],
  ['known role at wrong employer', 'Alex worked as a Construction Worker at Harbor Clinic.', true],
  ['unsupported surgeon at known employer', 'Alex worked as a Surgeon at Summit Roofing.', true],
  ['standalone documented role', 'Alex is a Construction Worker.', false],
  ['scoped role denial', 'Alex was not a Neurosurgeon at Summit Roofing.', false],
  ['unrelated denial cannot rescue role', 'Alex did not use React, but he worked as a Neurosurgeon at Summit Roofing.', true],
  ['denied role cannot hide later invention', 'Alex is not a Surgeon; he is a Neurosurgeon at Summit Roofing.', true]
]) {
  test(`bounded grounding roles: ${label}`, () => {
    const result = validateAnswer(text, 'Alex worked as a Construction Worker at Summit Roofing and a Receptionist at Harbor Clinic.',
      'What work has Alex done?', boundedRoleKnowledge, [], buildRelationshipGraph(boundedRoleKnowledge));
    assert.equal(result.reasons.some(r => r.startsWith('fabricated_occupation:')), rejected, JSON.stringify(result.reasons));
    if (rejected) assert.equal(result.valid, false);
  });
}

for (const title of ['Surgeon', 'Neurosurgeon', 'Expert']) {
  test(`bounded grounding roles: standalone documented ${title}`, () => {
    const knowledge = makeKnowledge();
    knowledge.identity.title = title;
    const text = `Alex is a ${title}. Alex provides documented guidance.`;
    const result = validateAnswer(text, text, 'Tell me about Alex', knowledge, [], buildRelationshipGraph(knowledge));
    assert.equal(result.valid, true, JSON.stringify(result.reasons));
  });
}

const boundedProvenanceKnowledge = makeKnowledge({ projects: [
  { name: 'Alpha', category: 'personal project', tech: ['React'], description: 'A dashboard discussing production environments.' },
  { name: 'Beta', category: 'freelance project', tech: ['Vue'], description: 'A freelance dashboard with authentication.' }
] });

for (const [label, text, rejected] of [
  ['A target cannot borrow freelance marker', 'Alpha is a freelance project.', true],
  ['B target supported freelance allowed', 'Beta is a freelance project.', false],
  ['C production mention is not ownership', 'Alex owned Alpha in production.', true],
  ['D separate internship disavowal', 'Alpha is separate from Beta and was not part of an internship.', false],
  ['E generic descriptive words', 'Alpha is a dashboard with authentication.', false],
  ['E generic production discussion', 'Alpha discusses production environments.', false],
  ['E own technology remains valid', 'Alpha uses React.', false],
  ['unsupported capstone with unrelated negation', 'Alpha is a capstone project that does not hardcode secrets.', true],
  ['named internship attribution', 'Alpha was built during his AWS internship.', true],
  ['affirmative target in multiple project sentence', 'Alpha is a freelance project, whereas Beta is a personal project.', true],
  ['cross project technology remains rejected', 'Alpha uses Vue.', true]
]) {
  test(`bounded grounding provenance: ${label}`, () => {
    const result = validateAnswer(text, '', 'Tell me about Alpha and Beta', boundedProvenanceKnowledge, [], buildRelationshipGraph(boundedProvenanceKnowledge));
    assert.equal(result.reasons.some(r => r.startsWith('wrong_relationship:project_provenance:')), rejected, JSON.stringify(result.reasons));
    if (rejected) assert.equal(result.valid, false);
  });
}

test('bounded grounding provenance: unsupported attribution needs no second project', () => {
  const knowledge = makeKnowledge({ projects: [boundedProvenanceKnowledge.projects[0]] });
  const result = validateAnswer('Alpha was built during an internship.', '', 'Tell me about Alpha', knowledge, [], buildRelationshipGraph(knowledge));
  assert.ok(result.reasons.some(r => r.startsWith('wrong_relationship:project_provenance:')), JSON.stringify(result.reasons));
});

for (const [label, evidence, rejected] of [
  ['explicit target relation', [{ kind: 'project', description: 'Alpha was built as a freelance project.' }], false],
  ['cross target relation', [{ kind: 'project', description: 'Alpha is a dashboard. Beta was built as a freelance project.' }], true],
  ['generic same block mention', [{ kind: 'project', description: 'Alpha explains freelance employment.' }], true],
  ['negated target relation', [{ kind: 'project', description: 'Alpha was not built as a freelance project.' }], true],
  ['structured target category', [{ kind: 'project', name: 'Alpha', category: 'freelance project' }], false],
  ['structured other category', [{ kind: 'project', name: 'Beta', category: 'freelance project' }], true]
]) {
  test(`bounded grounding provenance: evidence ${label}`, () => {
    const result = validateAnswer('Alpha is a freelance project.', '', 'Tell me about Alpha', boundedProvenanceKnowledge, [],
      buildRelationshipGraph(boundedProvenanceKnowledge), null, null, evidence);
    assert.equal(result.reasons.some(r => r.startsWith('wrong_relationship:project_provenance:')), rejected, JSON.stringify(result.reasons));
  });
}
