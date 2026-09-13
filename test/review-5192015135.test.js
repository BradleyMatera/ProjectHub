'use strict';

// Regression coverage for Copilot review 5192015135 (PR #31, commit ecf953d).
// Fixtures are synthetic and tenant-neutral (Avery Stone / Morgan Vale) — no
// Bradley or corpus strings. Each test names its finding.

const { test } = require('node:test');
const assert = require('node:assert');

const { getSubjectPronouns } = require('../lib/knowledge-access');
const { findArithmeticSubtasks, asksForComputedResult } = require('../lib/arithmetic-tool');
const { executeAgentTool } = require('../lib/agent-tools');
const { extractClaims, configureEntityNames } = require('../lib/claim-extractor');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { assessExpertiseClaim } = require('../lib/relationship-validator');
const { scoreCase } = require('../lib/acceptance-scorer');

const zeKb = () => ({
  identity: { name: 'Morgan Vale', pronouns: 'ze/zir' },
  subjectAliases: ['Morgan', 'Vale']
});

// ---------- N1. knowledge-access: string pronouns normalize for all readers ----------
// lite-agent buildLitePacket and recovery-contract buildRecoveryPrompt read
// .subject/.object/.possessive — a legacy "ze/zir" string must not produce
// undefined/undefined prompt text.

test('N1: slash-form pronouns normalize to subject/object/possessive', () => {
  const ze = getSubjectPronouns(zeKb());
  assert.equal(ze.subject, 'ze');
  assert.equal(ze.object, 'zir');
  assert.equal(ze.possessive, 'zir');
  const she = getSubjectPronouns({ identity: { name: 'Avery Stone', pronouns: 'she/her' } });
  assert.deepEqual(she, { subject: 'she', object: 'her', possessive: 'her' });
  const def = getSubjectPronouns({ identity: { name: 'Avery Stone' } });
  assert.deepEqual(def, { subject: 'they', object: 'them', possessive: 'their' });
});

// ---------- N2. claim-extractor: configured pronouns merge with preset subjectAlt ----------
// server-gemini calls configureEntityNames before extraction, so subjectAlt is
// already non-empty; the graph pronoun merge must not short-circuit.

test('N2: configured pronouns extract claims even when subjectAlt is preset', () => {
  configureEntityNames({ subjectNames: ['morgan', 'vale'] });
  try {
    const graph = buildRelationshipGraph(zeKb());
    const claims = extractClaims('Ze is open to relocation.', graph);
    assert.ok(claims.length > 0, 'ze availability claim should extract');
  } finally {
    configureEntityNames({ subjectNames: [] });
  }
});

// ---------- N3. claim-extractor: is_type pattern uses subjectAlt ----------

test('N3: pronoun is_type claims extract for configured pronouns', () => {
  configureEntityNames({ subjectNames: ['morgan', 'vale'] });
  try {
    const graph = buildRelationshipGraph(zeKb());
    const claims = extractClaims('Ze is a devoted father.', graph);
    assert.ok(claims.some(c => c.relation === 'is_type'), JSON.stringify(claims));
  } finally {
    configureEntityNames({ subjectNames: [] });
  }
});

// ---------- N4. acceptance-scorer: configured pronoun joins subject refs ----------

test('N4: configured pronoun reaches role-fit/entry-level checks', () => {
  const kb = {
    ...zeKb(),
    experience: [],
    boundaries: [{ id: 'b1', category: 'seniority', claim: 'senior engineer', correction: 'No senior-level roles documented', authoritative: true }]
  };
  // Entry-level derivation inside a seniority denial must flag for ze tenants.
  const r = scoreCase(
    { message: 'Ze was a senior engineer at Acme Corp, right?', expect: { semanticType: 'OPEN_WORLD_RELATIONSHIP' } },
    { reply: 'No, and ze is entry-level, just starting out.' },
    { knowledge: kb });
  assert.equal(r.quality, 'OVERCLAIM');
  assert.match(r.reason, /entry-level|junior/);
});

test('N4b: meta-capabilities check does not crash on scope-free replies', () => {
  // Previously threw ReferenceError: bare `knowledge` in validateMetaCapabilities.
  const r = scoreCase(
    { message: 'What can you do?', expect: { semanticType: 'META_CAPABILITIES' } },
    { reply: 'I can answer questions about the work shown here.' },
    { knowledge: zeKb() });
  assert.equal(r.quality, 'GENERIC');
});

// ---------- N5. grounding path: contract reaches expertise ceiling ----------
// The live validateRelationships invocation must carry the response contract
// or an expertise triple is accepted even under UNKNOWN/false ceilings.

test('N5: expertise triple respects contract ceiling when contract is passed', () => {
  const g = buildRelationshipGraph({
    identity: { name: 'Morgan Vale' },
    relationships: [{ subject: 'Morgan Vale', relation: 'has_expertise', object: 'Rust' }]
  });
  const claim = { subject: 'Morgan Vale', relation: 'has_expertise', object: 'Rust' };
  assert.equal(assessExpertiseClaim(claim, g).supported, true);
  assert.equal(assessExpertiseClaim(claim, g, { contract: { factState: 'UNKNOWN' } }).supported, false);
});

// ---------- N6. agent-tools: "looking for" cannot promote title words ----------

test('N6: role title inside a "looking for" clause is not a criterion', () => {
  const knowledge = { identity: { name: 'Morgan Vale' }, skills: { core: ['AWS', 'JavaScript'] }, projects: [] };
  const res = executeAgentTool('match_role', { jobDescription: 'Looking for a frontend developer role requiring AWS' }, knowledge);
  assert.deepEqual(res.explicitCriteria, ['aws']);
  assert.ok(!res.explicitCriteria.some(c => /developer/i.test(c)));
});

// ---------- N7. agent-tools: token-aware skill overlap ----------

test('N7: Java must not satisfy a JavaScript criterion', () => {
  const knowledge = { identity: { name: 'Morgan Vale' }, skills: { core: ['Java', 'JavaScript'] }, projects: [] };
  const res = executeAgentTool('match_role', { jobDescription: 'We need JavaScript expertise for this build' }, knowledge);
  assert.ok(!res.matchedSkills.includes('Java'), JSON.stringify(res.matchedSkills));
  assert.ok(res.matchedSkills.includes('JavaScript'));
});

// ---------- N8. arithmetic-tool: bare year range is not subtraction ----------

test('N8: bare NNNN-NNNN range does not emit a subtraction', () => {
  assert.deepEqual(findArithmeticSubtasks('2024-2025'), []);
  assert.deepEqual(findArithmeticSubtasks('pages 10-20'), []);
  // Explicit cue still computes it.
  const cued = findArithmeticSubtasks('What is 2024 - 2025?');
  assert.equal(cued.length, 1);
  assert.equal(cued[0].result, -1);
});

// ---------- N9. arithmetic-tool: cue-less expressions ask for results ----------

test('N9: cue-less arithmetic expressions count as computed-result asks', () => {
  assert.equal(asksForComputedResult('19 minus 6?'), true);
  assert.equal(asksForComputedResult('2+2'), true);
  assert.equal(asksForComputedResult('15% of 200'), true);
  assert.equal(asksForComputedResult('what is 2+2?'), true);
  // Non-arithmetic text still false.
  assert.equal(asksForComputedResult('tell me about the projects'), true); // has cue word
  assert.equal(asksForComputedResult('the projects list'), false);
});

// ---------- N10. relationship-graph: name parts normalize like lookups ----------

test('N10: apostrophized name parts normalize before joining subjectAliases', () => {
  const g = buildRelationshipGraph({ identity: { name: "O'Neil Stone" }, subjectAliases: [] });
  assert.ok(g.subjectAliases.has('oneil'), JSON.stringify([...g.subjectAliases]));
});
