'use strict';

/**
 * Synthetic Tenant Semantics Tests
 *
 * Proves Scout engine correctly distinguishes TRUE / FALSE / UNKNOWN
 * and does not collapse UNKNOWN into FALSE.
 *
 * Tests:
 * 1. Open-world synthetic tenant (Jane Doe) — unknown facts return UNKNOWN, not FALSE
 * 2. Closed-world synthetic tenant — absent employment resolves to FALSE
 * 3. No-tenant fail-closed
 * 4. Direct-answer portability (KB knows, engine doesn't)
 * 5. Knowledge-removal tests (cert, project, employer, education, technology)
 * 6. Query-echo-as-evidence regression
 * 7. Boundary-driven denial vs no-boundary UNKNOWN
 * 8. Claim extraction with synthetic tenant
 * 9. Relationship graph with synthetic tenant
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const knowledgeAccess = require('../lib/knowledge-access');
const { detectAdversarialCaveat } = require('../lib/lite-agent');
const { buildRecoveryContract, detectAdversarialContract } = require('../lib/recovery-contract');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { validateAnswer } = require('../lib/grounding-validator');
const { extractClaims } = require('../lib/claim-extractor');

// === Synthetic Jane Doe KB (open-world) ===
const janeOpenWorld = {
  identity: {
    name: 'Jane Doe',
    preferredName: 'Jane',
    title: 'Software Developer',
    location: 'Madison, WI',
    pronouns: { subject: 'she', object: 'her', possessive: 'her' }
  },
  summary: {
    whoIAm: 'Jane is a software developer with experience in Python and cloud technologies.',
    level: 'mid-level'
  },
  education: {
    school: 'University of Wisconsin',
    degree: 'B.S. Computer Science'
  },
  certifications: [
    { name: 'Microsoft Azure Fundamentals' }
  ],
  skills: {
    core: ['Python', 'PostgreSQL', 'Docker'],
    cloud: ['Azure']
  },
  experience: [
    { company: 'Example Company', role: 'Developer', skills: ['Python'] }
  ],
  projects: [
    { name: 'Example Project', tech: ['Python', 'PostgreSQL'], description: 'A data pipeline tool.' }
  ],
  subjectAliases: ['Jane', 'Doe'],
  boundaries: [],
  claimCorrections: [],
  directAnswers: []
};

// === Synthetic Jane Doe KB (closed-world employment) ===
const janeClosedWorld = {
  ...janeOpenWorld,
  knowledgeCompleteness: {
    employmentHistory: {
      mode: 'closed_world',
      complete: true,
      authoritative: true
    }
  }
};

// === Synthetic Jane Doe KB with direct answer ===
const janeWithDirectAnswer = {
  ...janeOpenWorld,
  directAnswers: [
    {
      questionPatterns: ['\\bdoes\\s+she\\s+know\\s+cobol\\b', '\\bcobol\\b'],
      answer: 'Jane has introductory COBOL experience from Example Course.'
    }
  ]
};

// === Synthetic Jane Doe KB with boundaries ===
const janeWithBoundaries = {
  ...janeOpenWorld,
  boundaries: [
    {
      id: 'no-team-management',
      category: 'seniority',
      claim: 'managed a software team',
      correction: 'She has not held a software team management role.',
      authoritative: true
    }
  ]
};

// === Bradley KB (for knowledge-removal tests) ===
const bradleyKB = require('../data/recruiter-knowledge.json');

// === HELPERS ===
function checkNoBradleyLeakage(value) {
  const leakage = [];
  const lower = typeof value === 'string' ? value.toLowerCase() : JSON.stringify(value || '').toLowerCase();
  const forbidden = [
    'bradley', 'matera', 'full sail', 'ciris', 'convo ai',
    'fairway', 'saa-c03', 'aif-c01', 'projecthub'
  ];
  for (const term of forbidden) {
    if (lower.includes(term)) leakage.push(term);
  }
  return leakage;
}

// === 1. OPEN-WORLD SYNTHETIC TENANT ===

test('PORT-1A: Jane identity is used, not Bradley', () => {
  const name = knowledgeAccess.getSubjectName(janeOpenWorld);
  assert.equal(name, 'Jane Doe');
  assert.ok(!name.includes('Bradley'));
});

test('PORT-1B: Jane aliases derived from KB', () => {
  const aliases = knowledgeAccess.getSubjectAliasSet(janeOpenWorld);
  assert.ok(aliases.has('jane'));
  assert.ok(aliases.has('doe'));
  assert.ok(aliases.has('jane doe'));
  assert.ok(!aliases.has('bradley'));
});

test('PORT-1C: Jane known companies from KB', () => {
  const companies = knowledgeAccess.getKnownCompanies(janeOpenWorld);
  assert.deepEqual(companies, ['Example Company']);
  assert.ok(!companies.includes('Amazon Web Services'));
});

test('PORT-1D: Jane known schools from KB', () => {
  const schools = knowledgeAccess.getKnownSchools(janeOpenWorld);
  assert.ok(schools.includes('University of Wisconsin'));
  assert.ok(!schools.includes('Full Sail'));
});

test('PORT-1E: Jane known certifications from KB', () => {
  const certs = knowledgeAccess.getKnownCertifications(janeOpenWorld);
  assert.ok(certs.includes('Microsoft Azure Fundamentals'));
  assert.ok(!certs.some(c => c.includes('AWS') || c.includes('SAA')));
});

test('PORT-1F: Jane known technologies from KB', () => {
  const techs = knowledgeAccess.getKnownTechnologies(janeOpenWorld);
  assert.ok(techs.includes('python'));
  assert.ok(techs.includes('postgresql'));
  assert.ok(techs.includes('docker'));
  assert.ok(!techs.includes('react'));
  assert.ok(!techs.includes('rust'));
});

test('PORT-1G: Open-world unknown employer → UNKNOWN, not FALSE', () => {
  const caveat = detectAdversarialCaveat('Did Jane work at Google?', '', janeOpenWorld);
  assert.ok(caveat, 'Should produce a caveat for unknown employer');
  assert.equal(caveat.directAnswer, 'UNKNOWN', 'Should use UNKNOWN direct answer');
  assert.equal(caveat.factState, 'UNKNOWN', 'Should have UNKNOWN fact state');
  assert.ok(!/\bdid not\b|\bnever\b/i.test(JSON.stringify(caveat)), 'Must NOT assert FALSE in open-world mode');
});

test('PORT-1H: Open-world unknown employer fallback → UNKNOWN', () => {
  const fallback = detectAdversarialContract('Tell me about her time at Google.', janeOpenWorld, '');
  if (fallback) {
    assert.equal(fallback.directAnswer, 'UNKNOWN', 'Fallback should use UNKNOWN direct answer');
    assert.equal(fallback.factState, 'UNKNOWN', 'Fallback should have UNKNOWN fact state');
    assert.ok(!/\bdid not\b|\bnever\b/i.test(JSON.stringify(fallback)), 'Must NOT assert FALSE in open-world');
  }
});

test('PORT-1I: Open-world team management → UNKNOWN (no boundary)', () => {
  const fallback = detectAdversarialContract('She managed a team of developers, right?', janeOpenWorld, '');
  assert.equal(fallback, null, 'Must NOT fabricate denial without boundary data');
});

test('PORT-1J: Open-world unknown skill (Rust) → not in known technologies', () => {
  const techs = knowledgeAccess.getKnownTechnologies(janeOpenWorld);
  assert.ok(!techs.includes('rust'), 'Rust should not be in Jane known technologies');
});

test('PORT-1K: No Bradley leakage in any Jane response', () => {
  const caveat = detectAdversarialCaveat('Did Jane work at Google?', '', janeOpenWorld);
  const leakage = checkNoBradleyLeakage(caveat);
  assert.deepEqual(leakage, [], `Caveat leaked Bradley terms: ${leakage.join(', ')}`);
});

// === 2. CLOSED-WORLD SYNTHETIC TENANT ===

test('PORT-2A: Closed-world employment is complete + authoritative', () => {
  assert.ok(knowledgeAccess.isCategoryComplete(janeClosedWorld, 'employmentHistory'));
  assert.ok(knowledgeAccess.isCategoryAuthoritative(janeClosedWorld, 'employmentHistory'));
});

test('PORT-2B: Closed-world unknown employer → FALSE', () => {
  const caveat = detectAdversarialCaveat('Did Jane work at Google?', '', janeClosedWorld);
  assert.ok(caveat, 'Should produce a caveat');
  assert.equal(caveat.directAnswer, 'NO', 'Closed-world should have NO direct answer');
  assert.equal(caveat.factState, 'FALSE', 'Closed-world should have FALSE fact state');
});

test('PORT-2C: Closed-world fallback → FALSE denial', () => {
  const fallback = detectAdversarialContract('Tell me about her time at Google.', janeClosedWorld, '');
  if (fallback) {
    assert.equal(fallback.directAnswer, 'NO', 'Closed-world fallback should deny');
    assert.equal(fallback.factState, 'FALSE', 'Closed-world fallback should have FALSE fact state');
  }
});

test('PORT-2D: resolveFactState returns false for closed-world absent', () => {
  const state = knowledgeAccess.resolveFactState(janeClosedWorld, 'employmentHistory', false, false);
  assert.equal(state, 'false');
});

test('PORT-2E: resolveFactState returns unknown for open-world absent', () => {
  const state = knowledgeAccess.resolveFactState(janeOpenWorld, 'employmentHistory', false, false);
  assert.equal(state, 'unknown');
});

test('PORT-2F: resolveFactState returns true when evidence exists', () => {
  const state = knowledgeAccess.resolveFactState(janeOpenWorld, 'employmentHistory', true, false);
  assert.equal(state, 'true');
});

test('PORT-2G: resolveFactState returns false when boundary exists', () => {
  const state = knowledgeAccess.resolveFactState(janeWithBoundaries, 'employmentHistory', false, true);
  assert.equal(state, 'false');
});

test('PORT-2H: Open-world isCategoryComplete returns false', () => {
  assert.ok(!knowledgeAccess.isCategoryComplete(janeOpenWorld, 'employmentHistory'));
});

// === 3. NO-TENANT FAIL-CLOSED ===

test('PORT-3A: No-tenant getSubjectName returns empty', () => {
  assert.equal(knowledgeAccess.getSubjectName(null), '');
  assert.equal(knowledgeAccess.getSubjectName({}), '');
});

test('PORT-3B: No-tenant getKnownCompanies returns empty', () => {
  assert.deepEqual(knowledgeAccess.getKnownCompanies(null), []);
  assert.deepEqual(knowledgeAccess.getKnownCompanies({}), []);
});

test('PORT-3C: No-tenant getKnownTechnologies returns empty', () => {
  assert.deepEqual(knowledgeAccess.getKnownTechnologies(null), []);
});

test('PORT-3D: No-tenant isCategoryComplete returns false', () => {
  assert.ok(!knowledgeAccess.isCategoryComplete(null, 'employmentHistory'));
  assert.ok(!knowledgeAccess.isCategoryComplete({}, 'employmentHistory'));
});

test('PORT-3E: No-tenant detectAdversarialCaveat does not produce Bradley facts', () => {
  const caveat = detectAdversarialCaveat('Did he work at Google?', '', null);
  if (caveat) {
    const leakage = checkNoBradleyLeakage(caveat);
    assert.deepEqual(leakage, [], `No-tenant caveat leaked: ${leakage.join(', ')}`);
  }
});

test('PORT-3F: No-tenant detectAdversarialContract does not produce Bradley facts', () => {
  const fallback = detectAdversarialContract('Tell me about his time at Google.', null, '');
  if (fallback) {
    const leakage = checkNoBradleyLeakage(fallback);
    assert.deepEqual(leakage, [], `No-tenant fallback leaked: ${leakage.join(', ')}`);
  }
});

test('PORT-3G: No-tenant buildRecoveryContract does not produce Bradley facts', () => {
  const contract = buildRecoveryContract({ results: [] }, { operation: 'search' }, 'Who is this candidate?', '', null, 'Who is this candidate?');
  if (contract) {
    const leakage = checkNoBradleyLeakage(contract);
    assert.deepEqual(leakage, [], `No-tenant recovery contract leaked: ${leakage.join(', ')}`);
  }
});

// === 4. DIRECT-ANSWER PORTABILITY ===

test('PORT-4A: Direct answer from KB is retrieved for Jane', () => {
  const answer = knowledgeAccess.findDirectAnswer(janeWithDirectAnswer, 'Does she know COBOL?');
  assert.ok(answer, 'Should find direct answer');
  assert.ok(answer.answer.includes('COBOL'), 'Answer should mention COBOL');
  assert.ok(answer.answer.includes('Jane'), 'Answer should mention Jane');
});

test('PORT-4B: Direct answer removed → not found', () => {
  const answer = knowledgeAccess.findDirectAnswer(janeOpenWorld, 'Does she know COBOL?');
  assert.equal(answer, null, 'Should NOT find direct answer when KB lacks it');
});

test('PORT-4C: Direct answer does not leak Bradley', () => {
  const answer = knowledgeAccess.findDirectAnswer(janeWithDirectAnswer, 'Does she know COBOL?');
  if (answer) {
    const leakage = checkNoBradleyLeakage(answer.answer);
    assert.deepEqual(leakage, [], `Direct answer leaked: ${leakage.join(', ')}`);
  }
});

// === 5. KNOWLEDGE-REMOVAL TESTS ===

test('PORT-5A: Certification removal — Scout does not still know it', () => {
  const bradleyCerts = knowledgeAccess.getKnownCertifications(bradleyKB);
  assert.ok(bradleyCerts.length > 0, 'Bradley should have certifications');
  const reduced = { ...bradleyKB, certifications: [] };
  const reducedCerts = knowledgeAccess.getKnownCertifications(reduced);
  assert.deepEqual(reducedCerts, [], 'Removed certifications should not be found');
});

test('PORT-5B: Project removal — Scout does not still know it', () => {
  const bradleyProjects = knowledgeAccess.getKnownProjects(bradleyKB);
  assert.ok(bradleyProjects.length > 0, 'Bradley should have projects');
  const reduced = { ...bradleyKB, projects: [] };
  const reducedProjects = knowledgeAccess.getKnownProjects(reduced);
  assert.deepEqual(reducedProjects, [], 'Removed projects should not be found');
});

test('PORT-5C: Employer removal — Scout does not still know it', () => {
  const bradleyCompanies = knowledgeAccess.getKnownCompanies(bradleyKB);
  assert.ok(bradleyCompanies.length > 0, 'Bradley should have employers');
  const reduced = { ...bradleyKB, experience: [] };
  const reducedCompanies = knowledgeAccess.getKnownCompanies(reduced);
  assert.deepEqual(reducedCompanies, [], 'Removed employers should not be found');
});

test('PORT-5D: Education removal — Scout does not still know it', () => {
  const bradleySchools = knowledgeAccess.getKnownSchools(bradleyKB);
  assert.ok(bradleySchools.length > 0, 'Bradley should have schools');
  const reduced = { ...bradleyKB, education: {} };
  const reducedSchools = knowledgeAccess.getKnownSchools(reduced);
  assert.deepEqual(reducedSchools, [], 'Removed schools should not be found');
});

test('PORT-5E: Technology removal — Scout does not still know it', () => {
  const bradleyTechs = knowledgeAccess.getKnownTechnologies(bradleyKB);
  assert.ok(bradleyTechs.length > 0, 'Bradley should have technologies');
  const reduced = { ...bradleyKB, skills: {}, projects: bradleyKB.projects.map(p => ({ ...p, tech: [] })) };
  const reducedTechs = knowledgeAccess.getKnownTechnologies(reduced);
  assert.deepEqual(reducedTechs, [], 'Removed technologies should not be found');
});

// === 6. QUERY-ECHO-AS-EVIDENCE REGRESSION ===

test('PORT-6A: Query entity is not treated as evidence', () => {
  const result = validateAnswer(
    'Yes, she knows FORTRAN.',
    'Jane has experience in Python and PostgreSQL.',
    'Does she know FORTRAN?',
    janeOpenWorld
  );
  assert.ok(
    result.reasons.some(r => r.includes('fabricated') || r.includes('unsupported') || r.includes('not_grounded') || r.includes('insufficient')),
    'FORTRAN claim should be flagged when no evidence exists'
  );
});

test('PORT-6B: Known skill is grounded when in source evidence', () => {
  const result = validateAnswer(
    'Yes, she knows Python.',
    'Jane has experience in Python and PostgreSQL.',
    'Does she know Python?',
    janeOpenWorld
  );
  assert.ok(
    !result.reasons.some(r => r.startsWith('fabricated_entity:Python')),
    'Python should not be flagged as fabricated when in evidence'
  );
});

// === 7. BOUNDARY-DRIVEN DENIAL ===

test('PORT-7A: Team management with boundary → denial', () => {
  const fallback = detectAdversarialContract('She managed a team of developers, right?', janeWithBoundaries, '');
  assert.ok(fallback, 'Should produce a denial when boundary exists');
  assert.equal(fallback.directAnswer, 'NO', 'Denial should have direct answer NO');
  assert.equal(fallback.factState, 'FALSE', 'Denial should have FALSE fact state');
  const factText = (f) => typeof f === 'string' ? f : JSON.stringify(f);
  assert.ok(fallback.keyFacts.some(f => /team/i.test(factText(f))), 'Denial should have team evidence');
});

test('PORT-7B: Team management without boundary → no fabricated denial', () => {
  const fallback = detectAdversarialContract('She managed a team of developers, right?', janeOpenWorld, '');
  assert.equal(fallback, null, 'Must NOT fabricate denial without boundary');
});

// === 8. CLAIM EXTRACTION WITH JANE ===

test('PORT-8A: Claim extraction works with Jane KB', () => {
  const graph = buildRelationshipGraph(janeOpenWorld);
  const claims = extractClaims('Jane worked at Example Company as a Developer.', graph, 'Where did Jane work?');
  assert.ok(claims.length > 0, 'Should extract claims from Jane text');
  const workClaim = claims.find(c => c.relation === 'worked_at' || c.relation === 'interned_at');
  assert.ok(workClaim, 'Should extract employment claim');
  assert.ok(workClaim.object.toLowerCase().includes('example company'), 'Should extract correct company');
});

test('PORT-8B: Claim extraction does not produce Bradley claims', () => {
  const graph = buildRelationshipGraph(janeOpenWorld);
  const claims = extractClaims('Jane worked at Example Company.', graph, 'Where did Jane work?');
  for (const claim of claims) {
    const leakage = checkNoBradleyLeakage(claim.raw || '');
    assert.deepEqual(leakage, [], `Claim leaked Bradley terms: ${leakage.join(', ')}`);
  }
});

// === 9. RELATIONSHIP GRAPH WITH JANE ===

test('PORT-9A: Relationship graph builds for Jane', () => {
  const graph = buildRelationshipGraph(janeOpenWorld);
  assert.ok(graph, 'Graph should build');
  assert.ok(graph.triples.length > 0, 'Should have triples');
});

test('PORT-9B: Relationship graph does not contain Bradley entities', () => {
  const graph = buildRelationshipGraph(janeOpenWorld);
  const entityKeys = Array.from(graph.entityIndex.keys());
  for (const key of entityKeys) {
    const leakage = checkNoBradleyLeakage(key);
    assert.deepEqual(leakage, [], `Graph entity leaked: ${leakage.join(', ')}`);
  }
});
