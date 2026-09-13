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

// ---------- Q-group: Copilot review 5192491141 (5 suppressed findings) ----------

// ---------- Q1. acceptance-scorer: explicitWeakness honors configured pronouns ----------
// "Ze is weak at Rust" under a negative-assessment contract was scored GOOD.

test('Q1: configured-pronoun weakness claims score OVERCLAIM', () => {
  const { scoreCase } = require('../lib/acceptance-scorer');
  const kb = { identity: { name: 'Morgan Vale', pronouns: 'ze/zir/hir' }, subjectAliases: ['Morgan', 'Vale'] };
  for (const reply of ['Ze is weak at Rust.', 'Zir weakness is Rust.', 'Hir struggles with Rust.']) {
    const r = scoreCase(
      { id: 'q1', question: 'What is his honest weakness?', expect: { semanticType: 'NEGATIVE_ASSESSMENT' } },
      { reply, contract: { factState: 'UNKNOWN' } }, { knowledge: kb });
    assert.equal(r.quality, 'OVERCLAIM', `${reply} -> ${r.quality}`);
  }
  // Bounded unknown stays GOOD.
  const ok = scoreCase(
    { id: 'q1b', question: 'What is his honest weakness?', expect: { semanticType: 'NEGATIVE_ASSESSMENT' } },
    { reply: 'No weakness is documented or verified.', contract: { factState: 'UNKNOWN' } }, { knowledge: kb });
  assert.equal(ok.quality, 'GOOD');
});

// ---------- Q2. claim-extractor: is_type captures a pronoun as subject ----------
// "Hir is a nurse" left subject='hir' — treated as an unknown entity, skipping
// grounding. Configured pronouns must canonicalize to 'subject'.

test('Q2: configured pronoun in is_type claim canonicalizes to subject', () => {
  const { extractClaims, configureEntityNames } = require('../lib/claim-extractor');
  configureEntityNames({ subjectNames: ['morgan', 'vale'] });
  try {
    const graph = buildRelationshipGraph({ identity: { name: 'Morgan Vale', pronouns: 'ze/zir/hir' } });
    const claims = extractClaims('Hir is a nurse at the clinic.', graph);
    const isType = (claims || []).find(c => c.relation === 'is_type');
    assert.ok(isType && isType.subject === 'subject', `expected subject canonicalization, got ${JSON.stringify(isType)}`);
  } finally {
    configureEntityNames({ subjectNames: [] });
  }
});

// ---------- Q3. grounding-validator: epistemic cannot-confirm is QUALIFY ----------
// "Morgan cannot confirm whether Rust is documented" is bounded uncertainty,
// not a capability denial.

test('Q3: epistemic cannot-confirm parses as QUALIFY', () => {
  assert.equal(parseLeadingStance('Morgan cannot confirm whether Rust is documented.', zeKb()), 'QUALIFY');
  assert.equal(parseLeadingStance('Morgan definitely cannot use Rust.', zeKb()), 'DENY');
});

// ---------- Q4. grounding-validator: professional_inflation keeps all possessives ----------
// "He developed his projects professionally" / "Ze developed zir projects
// professionally" lost coverage when the pattern only kept their/the.

test('Q4: professional inflation covers his/her/zir possessives', () => {
  const r1 = validateAnswer('He developed his projects professionally.',
    'Morgan interned at Acme.', 'Tell me about his work.', zeKb(), [], null, null, null);
  assert.ok((r1.reasons || []).some(x => /professional_inflation/.test(x)), JSON.stringify(r1.reasons));
  const r2 = validateAnswer('Ze developed zir projects professionally.',
    'Morgan interned at Acme.', 'Tell me about zir work.', zeKb(), [], null, null, null);
  assert.ok((r2.reasons || []).some(x => /professional_inflation/.test(x)), JSON.stringify(r2.reasons));
});

// ---------- Q5. grounding-validator: pronoun-headed is_a claims not exempted ----------
// "Ze is a support ticketing platform" bypassed occupation validation because
// neither headIsSubject nor the bare is-a subject pattern recognized 'ze'.

test('Q5: configured-pronoun is_a claim flagged as fabricated occupation', () => {
  const kb = {
    identity: { name: 'Morgan Vale', pronouns: 'ze/zir' },
    subjectAliases: ['Morgan', 'Vale'],
    entities: [{ name: 'Northstar Desk', type: 'support ticketing platform' }],
    experience: [{ role: 'Developer', company: 'Acme' }]
  };
  const src = 'Northstar Desk is a support ticketing platform. Morgan is a Developer at Acme.';
  const r = validateAnswer('Ze is a support ticketing platform.', src, 'What is ze?', kb, [], null, null, null);
  assert.ok(!r.valid && (r.reasons || []).some(x => /fabricated_occupation/.test(x)),
    `expected fabricated_occupation, got ${JSON.stringify(r.reasons)}`);
  const r2 = validateAnswer('Ze is a support ticketing platform at Acme.', src, 'What is ze?', kb, [], null, null, null);
  assert.ok(!r2.valid && (r2.reasons || []).some(x => /fabricated_occupation/.test(x)),
    `expected fabricated_occupation, got ${JSON.stringify(r2.reasons)}`);
  // Generic assessment is not an occupation claim.
  const ok = validateAnswer('Ze is a good fit for the role based on the documented evidence.',
    src + ' The documented evidence supports a good fit.', 'Is ze a fit?', kb, [], null, null, null);
  assert.ok(!(ok.reasons || []).some(x => /fabricated_occupation/.test(x)),
    `generic assessment flagged: ${JSON.stringify(ok.reasons)}`);
});

// ---------- P10. source-preparation: slash-form pronouns voice sources correctly ----------
// The dead string branch in normalizeSourceVoice parsed only the subject
// token; the normalized object from getSubjectPronouns is the single source.

test('P10: slash-form pronouns produce correct subject/object/possessive voice', () => {
  const { normalizeSourceVoice } = require('../lib/source-preparation');
  const she = normalizeSourceVoice('I am available and my schedule is mine.', { identity: { name: 'X', pronouns: 'she/her' } });
  assert.equal(she, 'She is available and her schedule is her.');
  const ze = normalizeSourceVoice('I am available and my schedule is mine.', { identity: { name: 'X', pronouns: 'ze/zir' } });
  assert.equal(ze, 'Ze is available and zir schedule is zir.');
});

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
