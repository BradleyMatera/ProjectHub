'use strict';

// Regression coverage for Copilot review 5192195572 (PR #31, commit 4d81b05).
// Fixtures are synthetic and tenant-neutral (Morgan Vale / Avery Stone) — no
// Bradley or corpus strings. Each test names its finding.

const { test } = require('node:test');
const assert = require('node:assert');

const { getSubjectPronouns } = require('../lib/knowledge-access');
const { executeAgentTool } = require('../lib/agent-tools');
const { validateAnswer, parseLeadingStance } = require('../lib/grounding-validator');
const { evidenceSupportsTechnologyRelation } = require('../lib/evidence-relations');
const { extractRequestedRole } = require('../lib/response-contract');
const { assessPrimaryFacet } = require('../lib/response-planner');
const { buildRelationshipGraph } = require('../lib/relationship-graph');

const zeKb = () => ({
  identity: { name: 'Morgan Vale', pronouns: 'ze/zir' },
  subjectAliases: ['Morgan', 'Vale'],
  skills: { core: ['React', 'Node'] },
  projects: [{ name: 'Atlas', tech: ['React'] }],
  experience: []
});

// ---------- P1. agent-tools: isKnown must be token-aware ----------
// Criterion "JavaScript" with known skill "Java" — substring containment hid
// the gap; the role match falsely treated Java as satisfying JavaScript.

test('P1: Java skill does not satisfy a JavaScript criterion', () => {
  const kb = { identity: { name: 'Morgan Vale' }, skills: { core: ['Java'] }, projects: [] };
  const r = executeAgentTool('match_role', { jobDescription: 'We require JavaScript for this build' }, kb);
  assert.ok((r.gaps || []).some(g => /javascript/i.test(g.skill)),
    `expected a JavaScript gap, got ${JSON.stringify(r.gaps)}`);
});

// ---------- P2. server-gemini: cache discriminator covers Unicode operators ----------
// normalizeQuery strips punctuation; "4 × 2" and "4 - 2" must not share a
// cache entry. The discriminator must match every operator the arithmetic
// parser accepts (×, ÷ in addition to ASCII).

test('P2: cache discriminator recognizes Unicode arithmetic operators', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server-gemini.js'), 'utf8');
  const m = src.match(/const exprKeyed = ([^\n]+)/);
  assert.ok(m, 'exprKeyed discriminator present');
  assert.ok(/×/.test(m[1]) && /÷/.test(m[1]), `expected × and ÷ in discriminator: ${m[1]}`);
});

// ---------- P3. response-contract: looking-for title without "role" marker ----------
// "Looking for a data scientist requiring Python" — the title is role context,
// not a criterion. Role extraction must stop at the next requirement marker.

test('P3: bare looking-for title does not leak into explicit criteria', () => {
  const kb = { identity: { name: 'Morgan Vale' }, skills: { core: ['Python'] }, projects: [] };
  const r = executeAgentTool('match_role', { jobDescription: 'Looking for a data scientist requiring Python' }, kb);
  assert.ok(!(r.explicitCriteria || []).some(c => /data\s*scientist/i.test(c)),
    `title leaked into criteria: ${JSON.stringify(r.explicitCriteria)}`);
  assert.ok((r.explicitCriteria || []).some(c => /python/i.test(c)),
    `requirement lost: ${JSON.stringify(r.explicitCriteria)}`);
});

test('P3b: seeking title also strips before requirement marker', () => {
  const kb = { identity: { name: 'Morgan Vale' }, skills: { core: ['Python'] }, projects: [] };
  const r = executeAgentTool('match_role', { jobDescription: 'Seeking a platform engineer with experience in Go' }, kb);
  assert.ok(!(r.explicitCriteria || []).some(c => /platform\s*engineer/i.test(c)),
    `seeking title leaked: ${JSON.stringify(r.explicitCriteria)}`);
});

// ---------- P4. grounding-validator: leading stance honors configured pronouns ----------
// "Ze is not experienced with X" under an AFFIRM-required contract was parsed
// as UNKNOWN, so the denial bypassed the stance guard.

test('P4: configured-pronoun denial parses as DENY', () => {
  assert.equal(parseLeadingStance('Ze is not experienced with Rust.', zeKb()), 'DENY');
  assert.equal(parseLeadingStance('Ze cannot use Rust.', zeKb()), 'DENY');
  assert.equal(parseLeadingStance('Ze is experienced with React.', zeKb()), 'AFFIRM');
  // Defaults still work.
  assert.equal(parseLeadingStance('He is not experienced with Rust.', zeKb()), 'DENY');
  assert.equal(parseLeadingStance('They are not experienced with Rust.', null), 'DENY');
});

test('P4b: configured-pronoun denial fails an AFFIRM-required contract', () => {
  const kb = zeKb();
  const r = validateAnswer(
    'Ze is not experienced with Rust.',
    'Morgan Vale uses React. Morgan Vale uses Node.',
    'Is ze experienced with Rust?', kb, [], null, null,
    { directAnswer: 'YES', factState: 'TRUE' });
  assert.ok(!r.valid && (r.reasons || []).some(x => /stance_mismatch/.test(x)),
    `expected stance_mismatch, got ${JSON.stringify(r.reasons)}`);
});

// ---------- P5. knowledge-access: partial object pronouns fill missing fields ----------
// { subject: 'ze' } returned verbatim made prompt interpolation emit
// "ze/undefined" and undefined possessives.

test('P5: object-form pronouns fill missing object/possessive fields', () => {
  const pr = getSubjectPronouns({ identity: { name: 'X', pronouns: { subject: 'ze' } } });
  assert.equal(pr.subject, 'ze');
  assert.ok(pr.object && pr.object !== 'undefined', `object missing: ${JSON.stringify(pr)}`);
  assert.ok(pr.possessive && pr.possessive !== 'undefined', `possessive missing: ${JSON.stringify(pr)}`);
  const partial = getSubjectPronouns({ identity: { name: 'X', pronouns: { subject: 'ze', object: 'zir' } } });
  assert.deepEqual(partial, { subject: 'ze', object: 'zir', possessive: 'zir' });
});

// ---------- P6. claim-validator: clause boundary honors configured pronouns ----------
// ", and ze has used Vue in Atlas" is a new clause whatever the pronoun set —
// without it, the personal-use clause merges with the project clause and the
// technology is misattributed to the project.

test('P6: configured pronoun triggers clause boundary', () => {
  const { validateProjectTechnologyRelationships } = require('../lib/claim-validator');
  const kb = {
    identity: { name: 'Morgan Vale', pronouns: 'ze/zir' },
    projects: [{ name: 'Atlas', tech: ['React'] }, { name: 'Beta', tech: ['Vue'] }]
  };
  // Personal-use clause after a project clause — Vue must not attach to Atlas.
  assert.deepEqual(validateProjectTechnologyRelationships(
    'Atlas is a dashboard, and ze wrote plugins using Vue.', {}, kb, ''), []);
  // A genuine undocumented project-tech claim still flags.
  assert.ok(validateProjectTechnologyRelationships(
    'Atlas is a dashboard and Atlas uses Vue.', {}, kb, '').length > 0,
    'undocumented project tech should flag');
  assert.deepEqual(validateProjectTechnologyRelationships(
    'Atlas is a dashboard and Atlas uses React.', {}, kb, ''), []);
});

// ---------- P7. evidence-relations: metadata colons inside propositions ----------
// "Project Atlas: a dashboard. Tech: React" — colon split stranded the subject
// from the Tech: label, so documented technology evidence did not support.

test('P7: rendered label-colon project evidence supports technology claim', () => {
  assert.equal(evidenceSupportsTechnologyRelation(['Atlas'], 'React',
    'Project Atlas: a dashboard tool. Tech: React, Node'), true);
  assert.equal(evidenceSupportsTechnologyRelation(['Atlas'], 'Node',
    'Project Atlas: a dashboard tool. Tech: React, Node'), true);
  // A different subject must not inherit the label field.
  assert.equal(evidenceSupportsTechnologyRelation(['Beta'], 'React',
    'Project Atlas: a dashboard tool. Tech: React, Node'), false);
  // And a label field with no established subject stays unsupported.
  assert.equal(evidenceSupportsTechnologyRelation(['Atlas'], 'React',
    'Something else entirely. Tech: React'), false);
});

test('P7b: label-colon subject form still parses', () => {
  assert.equal(evidenceSupportsTechnologyRelation(['Atlas'], 'React', 'Atlas: uses React for rendering.'), true);
  assert.equal(evidenceSupportsTechnologyRelation(['Atlas'], 'React', 'Note: Atlas uses React.'), true);
  assert.equal(evidenceSupportsTechnologyRelation(['Atlas'], 'Vue', 'Atlas uses React; Beta uses Vue.'), false);
});

// ---------- P8. grounding-validator: signed computed results are grounded ----------
// A computed "-1" was extracted as magnitude "1" and rejected as
// number_not_grounded:1 — the sign must be part of the token.

test('P8: negative computed result is grounded', () => {
  const r = validateAnswer(
    'The result is -1.',
    'Arithmetic tool output: 3 - 4 = -1.',
    'What is 3 - 4?', zeKb(), [], null, null,
    { computedFacts: [{ result: -1, display: '3 - 4' }] });
  assert.ok(!(r.reasons || []).some(x => /number_not_grounded/.test(x)),
    `signed result flagged: ${JSON.stringify(r.reasons)}`);
});

test('P8b: hyphenated ranges do not fabricate negative numbers', () => {
  // "3-4" unspaced is a range/expression, not "-4" — the extracted tokens are
  // 3 and 4, and neither may be misread as a signed value.
  const src = 'range 3-4 noted';
  const matches = [...src.matchAll(/(?<![\w.])[-+]?\d[\d.,]*\b/g)].map(m => m[0]);
  assert.deepEqual(matches, ['3', '4']);
});

// ---------- P9. response-planner: configured pronouns are subject refs ----------
// "What skills does ze have?" must resolve ze to the tenant subject rather
// than an unresolved entity.

test('P9: configured pronoun resolves as subject in facet question', () => {
  const kb = zeKb();
  const graph = buildRelationshipGraph(kb);
  const r = assessPrimaryFacet({ question: 'What projects has ze built?', knowledge: kb, graph, subjectName: 'Morgan Vale' });
  assert.ok(r && r.matched, `facet not matched: ${JSON.stringify(r)}`);
  assert.equal(r.supported, true);
  assert.equal(r.subject, 'Morgan Vale', `ze should resolve to the tenant subject, got ${r.subject}`);
  // Object form works too.
  const r2 = assessPrimaryFacet({ question: 'What projects has zir built?', knowledge: kb, graph, subjectName: 'Morgan Vale' });
  assert.equal(r2.subject, 'Morgan Vale');
  // Without configured pronouns, "ze" is an unknown entity — not the subject.
  const kbDef = { identity: { name: 'Morgan Vale' }, subjectAliases: ['Morgan', 'Vale'], projects: kb.projects };
  const r3 = assessPrimaryFacet({ question: 'What projects has ze built?', knowledge: kbDef, graph: buildRelationshipGraph(kbDef), subjectName: 'Morgan Vale' });
  assert.notEqual(r3.subject, 'Morgan Vale');
});
