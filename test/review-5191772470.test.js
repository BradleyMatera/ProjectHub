'use strict';

// Regression coverage for Copilot review 5191772470 (PR #31, commit ddf4506).
// Fixtures are synthetic and tenant-neutral (Avery Stone / Morgan Vale) — no
// Bradley or corpus strings. Each test names its finding.

const { test } = require('node:test');
const assert = require('node:assert');

const { findArithmeticSubtasks } = require('../lib/arithmetic-tool');
const { extractClaims } = require('../lib/claim-extractor');
const { validateClaims } = require('../lib/claim-validator');
const { evidenceSupportsTechnologyRelation } = require('../lib/evidence-relations');
const { executeAgentTool } = require('../lib/agent-tools');
const { buildRelationshipGraph, resolveEntity } = require('../lib/relationship-graph');
const { validateRelationships } = require('../lib/relationship-validator');
const { normalizeSourceVoice } = require('../lib/source-preparation');
const { scoreCase } = require('../lib/acceptance-scorer');
const { validateAnswer } = require('../lib/grounding-validator');
const router = require('../lib/local-model-router');
const { runLiteAgent } = require('../lib/lite-agent');

// ---------- R1. acceptance-scorer: global regex lastIndex carryover ----------

test('R1: currentAbilityFromFuture lastIndex does not leak across scoreCase calls', () => {
  const tc = { message: 'Could he learn rust?', expect: { semanticType: 'FUTURE_CAPABILITY' } };
  // First call returns early on an unnegated match, leaving lastIndex > 0.
  const r1 = scoreCase(tc, { reply: 'He currently knows rust well and uses it daily.' });
  assert.equal(r1.quality, 'OVERCLAIM');
  // Second call must rescan from 0 — a stale lastIndex used to skip the match.
  const r2 = scoreCase(tc, { reply: 'yes he can use rust today.' });
  assert.equal(r2.quality, 'OVERCLAIM');
});

// ---------- R2. arithmetic-tool: WORD_SEQ word boundaries ----------

test('R2: word-number sequences cannot match inside ordinary words', () => {
  for (const text of ['stone plus two', 'anyone times two', 'done minus one']) {
    assert.deepEqual(findArithmeticSubtasks(text), [], text);
  }
  // Real word-number expressions still work.
  assert.equal(findArithmeticSubtasks('one plus two')[0].result, 3);
  assert.equal(findArithmeticSubtasks('twenty one plus three')[0].result, 24);
});

// ---------- R3. claim-extractor: configured pronouns in subject patterns ----------

test('R3: configured subject pronouns extract property claims like he/she/they', () => {
  const knowledge = {
    identity: { name: 'Avery Stone', pronouns: { subject: 'ze', object: 'zir', possessive: 'zir' } },
    experience: [{ company: 'Acme', role: 'Engineer' }],
  };
  const graph = buildRelationshipGraph(knowledge);
  const claims = extractClaims('Ze is open to relocation.', graph, '', []);
  assert.ok(claims.some(c => c.relation === 'has_property'),
    'configured pronoun "ze" must reach claim extraction');
});

// ---------- R4. evidence-relations: token-bounded subject prefix ----------

test('R4: a subject name prefix cannot claim a longer entity\'s relation', () => {
  // "Avery Chen" is a different entity than subject "Avery".
  assert.equal(
    evidenceSupportsTechnologyRelation(['Avery'], 'React', 'Avery Chen uses React for his work.'),
    false);
  assert.equal(
    evidenceSupportsTechnologyRelation(['Avery'], 'React', 'avery chen uses react for his work.'),
    false);
  // Exact subject and declared multi-word names still anchor the relation.
  assert.equal(
    evidenceSupportsTechnologyRelation(['Avery'], 'React', 'Avery uses React for his work.'),
    true);
  assert.equal(
    evidenceSupportsTechnologyRelation(['Avery', 'Avery Chen'], 'React', 'Avery Chen uses React.'),
    true);
});

// ---------- R5. grounding-validator: provenance metadata needs exact naming ----------

test('R5: evidence block for a prefix-sibling cannot supply provenance', () => {
  const knowledge = {
    identity: { name: 'Avery Stone' },
    projects: [{ name: 'Alpha Beta', description: 'Second project for parsing logs' }],
  };
  const graph = buildRelationshipGraph(knowledge);
  const answer = 'Alpha Beta is a freelance project for parsing logs.';
  // Only an unrelated "Alpha" block carries the freelance category.
  const evidence = [{ name: 'Alpha', category: 'freelance', text: 'Alpha is a parsing tool.' }];
  const res = validateAnswer(answer, answer, 'what is Alpha Beta?', knowledge, [], graph, null, null, evidence);
  assert.ok(res.reasons.some(r => r.startsWith('wrong_relationship:project_provenance')),
    `expected provenance rejection, got ${JSON.stringify(res.reasons)}`);
});

// ---------- R6. grounding-validator: is_type exemption scoped to entity ----------

test('R6: is_type exemption cannot excuse a subject occupation claim', () => {
  const knowledge = {
    identity: { name: 'Morgan Vale' },
    relationships: [{ subject: 'Panel Upgrade', relation: 'is_type', object: 'Electrical Service' }],
    experience: [{ company: 'Acme', role: 'Engineer' }],
  };
  const graph = buildRelationshipGraph(knowledge);
  const flagged = validateAnswer('He is an electrical service at Acme.', '', 'what does morgan do?',
    knowledge, [], graph, null, null, null);
  assert.ok(flagged.reasons.some(r => r.startsWith('fabricated_occupation')),
    `expected fabricated_occupation, got ${JSON.stringify(flagged.reasons)}`);
  // The exemption still applies when the sentence is about the entity itself.
  const okCase = validateAnswer('It is an electrical service offered at Acme.', '', 'what is it?',
    knowledge, [], graph, null, null, null);
  assert.ok(!okCase.reasons.some(r => r.startsWith('fabricated_occupation')),
    `entity-type sentence should stay exempt, got ${JSON.stringify(okCase.reasons)}`);
});

// ---------- R7. lite-agent: shared router.generate never mutated ----------

test('R7: runLiteAgent does not mutate the shared router', async () => {
  const stub = async () => ({ ok: true, text: '{"answer":"hi"}', model: 'm', latencyMs: 1 });
  const original = router.generate;
  router.generate = stub;
  try {
    await runLiteAgent({
      question: 'hello',
      conversationState: {},
      evidence: '',
      knowledge: { identity: { name: 'Avery Stone' } },
      sessionId: 's1',
      model: 'm',
      policyContract: { mode: 'GREETING' },
      deadlineAt: Date.now() + 10000,
      abortSignal: null,
    });
    assert.equal(router.generate, stub, 'router.generate must not be replaced');
  } finally {
    router.generate = original;
  }
});

// ---------- R8. relationship-graph: entity vs name-part collision ----------

test('R8: an exact entity named like a subject name part is not shadowed', () => {
  const knowledge = {
    identity: { name: 'Avery Stone', preferredName: 'Avi' },
    subjectAliases: ['Av'],
    projects: [{ name: 'Avery', tech: ['React'], description: 'A CLI tool' }],
    experience: [{ company: 'Acme', role: 'Engineer' }],
  };
  const graph = buildRelationshipGraph(knowledge);
  assert.equal(resolveEntity(graph, 'Avery'), 'avery', 'project "Avery" keeps its identity');
  assert.equal(resolveEntity(graph, 'Avery Stone'), 'averystone');
  assert.equal(resolveEntity(graph, 'Avi'), 'averystone', 'declared alias still resolves to subject');
  assert.equal(resolveEntity(graph, 'Stone'), 'averystone', 'uncontested name part still resolves');
});

// ---------- R9. relationship-validator: predicate-order negation ----------

test('R9: authored value "X is not Y" does not affirm the property claim', () => {
  const knowledge = {
    identity: { name: 'Avery Stone' },
    relationships: [{
      subject: 'Avery Stone', relation: 'has_property', object: 'relocation',
      meta: { property: 'relocation', value: 'Relocation is not possible' },
    }],
  };
  const graph = buildRelationshipGraph(knowledge);
  const res = validateRelationships('Avery is open to relocation.', graph, 'is avery open?', [], '', null);
  assert.ok(res.unsupportedClaims.some(c => c.relation === 'has_property'),
    'a negated authored value must not support the affirmative claim');
});

test('R9b: affirmative authored value still supports the claim', () => {
  const knowledge = {
    identity: { name: 'Avery Stone' },
    relationships: [{
      subject: 'Avery Stone', relation: 'has_property', object: 'relocation',
      meta: { property: 'relocation', value: 'Open to relocation' },
    }],
  };
  const graph = buildRelationshipGraph(knowledge);
  const res = validateRelationships('Avery is open to relocation.', graph, 'is avery open?', [], '', null);
  assert.deepEqual(res.unsupportedClaims, []);
});

// ---------- R10/R11. agent-tools: slash pass + token-aware skill matching ----------

test('R10: slash-joined words inside the role title are not criteria', () => {
  const knowledge = { skills: { languages: ['Go', 'Java', 'React', 'TypeScript'] }, experience: [], projects: [] };
  const res = executeAgentTool('match_role', {
    jobDescription: 'We are hiring for a React/TypeScript developer role with AWS experience.',
    role: 'react/typescript developer',
  }, knowledge);
  assert.ok(!res.explicitCriteria.some(c => /react/i.test(c)),
    `role title leaked as criterion: ${JSON.stringify(res.explicitCriteria)}`);
});

test('R11: skill matching is token-aware (Go != good, Java != JavaScript)', () => {
  const knowledge = { skills: { languages: ['Go', 'Java'] }, experience: [], projects: [] };
  const res = executeAgentTool('match_role', {
    jobDescription: 'Looking for a developer with good communication. JavaScript experience required.',
  }, knowledge);
  assert.ok(!res.explicitCriteria.includes('Go'), `Go matched inside "good": ${JSON.stringify(res.explicitCriteria)}`);
  assert.ok(!res.explicitCriteria.includes('Java'), `Java matched inside "JavaScript": ${JSON.stringify(res.explicitCriteria)}`);
  // Boundary-safe positives still match.
  const res2 = executeAgentTool('match_role', {
    jobDescription: 'Requiring Go and Java experience.',
  }, knowledge);
  assert.ok(res2.explicitCriteria.includes('Go') || res2.matchedSkills.includes('Go'));
  assert.ok(res2.explicitCriteria.includes('Java') || res2.matchedSkills.includes('Java'));
});

// ---------- R12. claim-validator: current-employment pattern coverage ----------

test('R12: present-tense employment phrasing reaches the temporal check', () => {
  const knowledge = {
    identity: { name: 'Avery Stone' },
    experience: [{ company: 'Acme', role: 'Engineer' }],
  };
  for (const text of [
    'Morgan is currently working for Globex.',
    'Morgan is currently a software engineer at Globex.',
    'Morgan is employed by Globex.',
    'Morgan is now a senior engineer at Globex.',
  ]) {
    const res = validateClaims(text, '', {}, '', knowledge);
    assert.ok(res.some(i => i.type === 'CURRENT_TEMPORAL_CLAIM'),
      `"${text}" should trigger the current-employment check`);
  }
  // Non-employment phrasing must not trip the temporal check: "is a <role>
  // at <possessive phrase>" without a temporal cue is a role claim, and
  // "working with <tech>" is usage, not employment.
  for (const text of [
    'He is a TypeScript developer at his current job.',
  ]) {
    const res = validateClaims(text, '', {}, '', knowledge);
    assert.ok(!res.some(i => i.type === 'CURRENT_TEMPORAL_CLAIM'),
      `"${text}" should not trigger the current-employment check`);
  }
});

// ---------- R13. relationship-validator: has_relation triples are support ----------

test('R13: a documented has_relation triple supports the claim', () => {
  const knowledge = {
    identity: { name: 'Avery Stone' },
    relationships: [{ subject: 'Avery Stone', relation: 'has_relation', object: 'daughter' }],
  };
  const graph = buildRelationshipGraph(knowledge);
  const res = validateRelationships('Avery has a daughter.', graph, 'does avery have kids?', [], '', null);
  assert.deepEqual(res.unsupportedClaims, [],
    `documented has_relation must validate: ${JSON.stringify(res.unsupportedClaims)}`);
  const fab = validateRelationships('Avery has a son.', graph, 'does avery have kids?', [], '', null);
  assert.ok(fab.unsupportedClaims.length > 0, 'fabricated relation still rejected');
});

// ---------- R14. source-preparation: plural agreement for the They fallback ----------

test('R14: they-fallback uses plural agreement; configured pronouns stay singular', () => {
  const out = normalizeSourceVoice('I am a dev. I have 5 years. I was hired.', { identity: { name: 'Avery Stone' } });
  assert.ok(out.includes('They are') && out.includes('They have') && out.includes('They were'), out);
  const ze = normalizeSourceVoice('I am a dev. I have 5 years.', { identity: { pronouns: { subject: 'ze' } } });
  assert.ok(ze.includes('Ze is') && ze.includes('Ze has'), ze);
});
