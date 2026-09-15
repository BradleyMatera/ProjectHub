'use strict';

// Canonical identity / relation-support collision tests.
//
// One identity precedence rules the whole pipeline:
//   exact entity / declared entity alias > declared tenant alias >
//   weak tenant name part > safe unknown.
// These tests prove assessRelationSupport, the response-policy layer, and
// the claim extractor all honor it — a colliding entity cannot borrow
// subject relationships, and a colliding subject name cannot steal a real
// entity's relationships. All fixtures are synthetic and tenant-neutral.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRelationshipGraph, resolveEntity, canonicalEntityNorm } = require('../lib/relationship-graph');
const { assessRelationSupport, assessPrimaryFacet } = require('../lib/response-planner');
const { classifyResponsePolicy } = require('../lib/response-policy-classifier');
const { planTurn } = require('../lib/semantic-plan');
const { extractClaims } = require('../lib/claim-extractor');
const { buildResponseContract } = require('../lib/response-contract');
const { validateAnswer } = require('../lib/grounding-validator');

// ---------- fixtures ----------

// Tenant "Avery Stone" whose preferred name collides with a project "Avery".
const T_NAME = {
  identity: { name: 'Avery Stone', preferredName: 'Avery' },
  agent: { name: 'Scout' },
  pronouns: { subject: 'ze', object: 'zir', possessive: 'zir' },
  skills: { languages: ['Python'] },
  projects: [{ name: 'Avery', tech: ['Go'], description: 'Go CLI.' }],
  summary: { honestGaps: ['Data structures and algorithms (DSA)'] }
};

// Tenant "Morgan Vale" whose surname collides with employer "Vale".
const T_SURNAME = {
  identity: { name: 'Morgan Vale' },
  agent: { name: 'Scout' },
  skills: { languages: ['Go'] },
  experience: [{ company: 'Vale', role: 'Engineer', summary: 'Built services.' }],
  summary: { honestGaps: ['Systems design depth'] }
};

// Tenant whose preferred name collides with a declared ENTITY alias.
const T_ALIAS = {
  identity: { name: 'Avery Stone', preferredName: 'Avery' },
  agent: { name: 'Scout' },
  skills: { languages: ['Python'] },
  projects: [{ name: 'Orion CLI', aliases: ['Avery'], tech: ['Go'], description: 'Deployment tool.' }]
};

// Product/service tenant with an owner-name collision.
const T_SERVICE = {
  identity: { name: 'Harbor Plumbing Co' },
  owner: 'Sam Harbor',
  agent: { name: 'Scout' },
  services: [{ name: 'Harbor Inspection', price: '$200', duration: '2 hours' }]
};

// Ordinary tenant, no collisions.
const T_PLAIN = {
  identity: { name: 'Morgan Reyes', preferredName: 'Morgan' },
  agent: { name: 'Scout' },
  pronouns: { subject: 'she', object: 'her', possessive: 'her' },
  skills: { languages: ['Python', 'Go'] }
};

const EMPTY = {};

const rel = (knowledge, subject, target, relation) =>
  assessRelationSupport({ graph: buildRelationshipGraph(knowledge), subject, target, requestedRelation: relation });

// ---------- A: first-name collision with a same-named project ----------

test('REL-A1: documented subject skill is SUPPORTED', () => {
  assert.equal(rel(T_NAME, 'Avery Stone', 'Python', 'has_skill').support, 'SUPPORTED');
});

test('REL-A2: undocumented subject skill is UNKNOWN', () => {
  assert.equal(rel(T_NAME, 'Avery Stone', 'Rust', 'has_skill').support, 'UNKNOWN');
});

test('REL-A3: project "Avery" cannot steal the tenant subject\'s skills', () => {
  // Old precedence canonicalized 'avery' to the tenant subject, so the
  // project "had" the subject's Python skill. It must now be UNKNOWN.
  assert.equal(rel(T_NAME, 'Avery', 'Python', 'has_skill').support, 'UNKNOWN');
});

test('REL-A4: project "Avery" keeps its own relationships', () => {
  assert.equal(rel(T_NAME, 'Avery', 'Go', 'usage').support, 'SUPPORTED');
});

test('REL-A5: asking whether the tenant "has_skill" the project stays UNKNOWN', () => {
  assert.equal(rel(T_NAME, 'Avery Stone', 'Avery', 'has_skill').support, 'UNKNOWN');
});

// ---------- B: surname collision with an employer ----------

test('REL-B1: company "Vale" cannot borrow the tenant\'s skills', () => {
  assert.equal(rel(T_SURNAME, 'Vale', 'Go', 'has_skill').support, 'UNKNOWN');
});

test('REL-B2: full tenant name still reaches subject relationships', () => {
  assert.equal(rel(T_SURNAME, 'Morgan Vale', 'Go', 'has_skill').support, 'SUPPORTED');
});

// ---------- C: preferred-name collision with a declared entity alias ----------

test('REL-C1: declared entity alias wins over tenant preferred name', () => {
  const graph = buildRelationshipGraph(T_ALIAS);
  assert.equal(resolveEntity(graph, 'avery'), 'orioncli');
  // The entity behind the alias cannot borrow subject skills.
  assert.equal(rel(T_ALIAS, 'Avery', 'Python', 'has_skill').support, 'UNKNOWN');
});

// ---------- E: has_gap collision ----------

test('REL-E1: documented subject gap is SUPPORTED', () => {
  assert.equal(rel(T_NAME, 'Avery Stone', 'DSA', 'has_gap').support, 'SUPPORTED');
});

test('REL-E2: colliding entity cannot steal the subject\'s gap', () => {
  assert.equal(rel(T_NAME, 'Avery', 'DSA', 'has_gap').support, 'UNKNOWN');
});

test('REL-E3: unknown gap target stays UNKNOWN — never invented FALSE', () => {
  assert.equal(rel(T_SURNAME, 'Morgan Vale', 'public speaking', 'has_gap').support, 'UNKNOWN');
});

// ---------- F: product/service collision ----------

test('REL-F1: service entity does not borrow subject relationships', () => {
  const graph = buildRelationshipGraph(T_SERVICE);
  assert.notEqual(resolveEntity(graph, 'harbor inspection'), graph.subjectNorm);
  assert.equal(rel(T_SERVICE, 'Harbor Inspection', 'drain cleaning', 'has_skill').support, 'UNKNOWN');
});

// ---------- G: empty KB ----------

test('REL-G1: empty knowledge base is safe and UNKNOWN', () => {
  const graph = buildRelationshipGraph(EMPTY);
  assert.equal(canonicalEntityNorm(graph, 'Python'), 'python');
  assert.equal(rel(EMPTY, 'Anyone', 'Python', 'has_skill').support, 'UNKNOWN');
});

// ---------- H: ordinary tenant reference, no collision ----------

test('REL-H1: tenant first name with no entity collision resolves to subject', () => {
  assert.equal(rel(T_PLAIN, 'Morgan', 'Python', 'has_skill').support, 'SUPPORTED');
  const graph = buildRelationshipGraph(T_PLAIN);
  assert.equal(canonicalEntityNorm(graph, 'Morgan'), graph.subjectNorm);
});

// ---------- response-policy level ----------

test('POL-1: documented skill → YES/TRUE/AFFIRM policy', () => {
  const p = classifyResponsePolicy('Does Avery Stone know Python?', [], T_NAME, null);
  assert.equal(p.directAnswer, 'YES');
  assert.equal(p.factState === 'TRUE' || p.answerStance === 'AFFIRM', true);
});

test('POL-2: undocumented skill → UNKNOWN/QUALIFY policy', () => {
  const p = classifyResponsePolicy('Does Avery Stone know Rust?', [], T_NAME, null);
  assert.equal(p.directAnswer, 'UNKNOWN');
  assert.equal(p.answerStance, 'QUALIFY');
});

test('POL-3: documented gap proposition → YES/TRUE/AFFIRM policy', () => {
  const p = classifyResponsePolicy('Is DSA documented as a gap?', [], T_NAME, null);
  assert.equal(p.directAnswer, 'YES');
  assert.equal(p.answerStance, 'AFFIRM');
});

test('POL-4: unknown gap proposition → UNKNOWN policy, not invented FALSE', () => {
  const p = classifyResponsePolicy('Is public speaking documented as a gap?', [], T_SURNAME, null);
  assert.equal(p.directAnswer, 'UNKNOWN');
  assert.equal(p.answerStance, 'QUALIFY');
});

test('POL-5: colliding entity question resolves to the entity, not the subject', () => {
  const { plan } = planTurn({ question: 'What tech does Avery use?', history: [], knowledge: T_NAME });
  assert.equal(plan.activeEntity?.name, 'Avery');
});

// ---------- claim-extractor subject collapse ----------

test('EXT-1: claim on colliding entity is NOT collapsed to the subject sentinel', () => {
  const graph = buildRelationshipGraph(T_NAME);
  const claims = extractClaims('Avery has experience with Go.', graph, 'What tech does Avery use?');
  const skillClaim = claims.find(c => /go/i.test(c.object || ''));
  assert.ok(skillClaim, 'expected a claim about Go');
  assert.notEqual(skillClaim.subject, 'subject');
  assert.equal(canonicalEntityNorm(graph, skillClaim.subject), 'avery');
  // The colliding subject name must not also mint a stolen subject claim.
  assert.equal(claims.filter(c => c.subject === 'subject').length, 0);
});

test('EXT-2: claim on the tenant full name still collapses to the subject sentinel', () => {
  const graph = buildRelationshipGraph(T_NAME);
  const claims = extractClaims('Avery Stone has experience with Python.', graph, 'Does Avery Stone know Python?');
  const skillClaim = claims.find(c => /python/i.test(c.object || ''));
  assert.ok(skillClaim, 'expected a claim about Python');
  assert.equal(skillClaim.subject, 'subject');
});

// ---------- alias / punctuation equivalence must not cause false shifts ----------

test('ALIAS-1: declared entity alias continuation is NOT an explicit-entity shift', () => {
  const history = [{ user: 'Tell me about Orion CLI', assistant: 'Orion CLI is a deployment tool.' }];
  const { plan } = planTurn({ question: 'What tech does Avery use?', history, knowledge: T_ALIAS });
  // 'Avery' is a declared alias of Orion CLI — same canonical entity.
  assert.notEqual(plan.topicShiftReason, 'explicit-entity');
  assert.equal(plan.activeEntity?.name && canonicalEntityNorm(buildRelationshipGraph(T_ALIAS), plan.activeEntity.name), 'orioncli');
});

test('ALIAS-2: alternate casing/punctuation of the same entity is NOT an explicit-entity shift', () => {
  const history = [{ user: 'Tell me about Orion CLI', assistant: 'Orion CLI is a deployment tool.' }];
  const { plan } = planTurn({ question: 'How is ORION-CLI deployed?', history, knowledge: T_ALIAS });
  assert.notEqual(plan.topicShiftReason, 'explicit-entity');
});

test('ALIAS-3: a genuinely different entity still shifts with explicit-entity', () => {
  const history = [{ user: 'Tell me about Orion CLI', assistant: 'Orion CLI is a deployment tool.' }];
  const { plan } = planTurn({ question: 'What tech does Avery Stone use?', history, knowledge: T_ALIAS });
  // 'Avery Stone' is the tenant — the token inside the full-name span is a
  // name part, not the aliased entity.
  assert.equal(plan.activeEntity, null);
});

test('ALIAS-4: different real entity still causes the explicit-entity shift', () => {
  const kb = {
    identity: { name: 'Morgan Reyes' }, agent: { name: 'Scout' },
    projects: [
      { name: 'Atlas', tech: ['Go'], description: 'Pipeline.' },
      { name: 'Beta', tech: ['Python'], description: 'Service.' }
    ]
  };
  const history = [{ user: 'Tell me about Atlas', assistant: 'Atlas is a data pipeline.' }];
  const { plan } = planTurn({ question: 'What tech does Beta use?', history, knowledge: kb });
  assert.equal(plan.topicShift, true);
  assert.equal(plan.topicShiftReason, 'explicit-entity');
  assert.equal(plan.activeEntity?.name, 'Beta');
});

// ---------- generative freedom: semantic contracts, not templates ----------

const FUTURE_KB = {
  identity: { name: 'Morgan Reyes', preferredName: 'Morgan' },
  agent: { name: 'Scout' },
  pronouns: { subject: 'she', object: 'her', possessive: 'her' },
  skills: { languages: ['Python', 'Go', 'SQL'], tools: ['Docker'] },
  projects: [{ name: 'Pipeline', tech: ['Python'], description: 'Data pipeline.' }]
};
const FUTURE_SRC = 'Morgan Reyes skills: Python, Go, SQL. Projects: Pipeline built with Python.';

function futureContract() {
  const c = buildResponseContract('Could she learn Rust?', FUTURE_SRC, FUTURE_KB, [], null);
  return c;
}

test('GEN-1: semantically equivalent future-capability phrasings all pass', () => {
  const graph = buildRelationshipGraph(FUTURE_KB);
  const contract = futureContract();
  assert.equal(contract.subIntent, 'FUTURE_CAPABILITY');
  const okForms = [
    'She could plausibly learn Rust given her documented Python and Go experience.',
    'Morgan could likely learn Rust; her documented Python and Go work shows she picks up languages quickly, though current Rust experience is not verified.',
    'Her documented Python and Go experience suggests she would be able to learn Rust in the future.'
  ];
  for (const a of okForms) {
    const v = validateAnswer(a, FUTURE_SRC, 'Could she learn Rust?', FUTURE_KB, [], graph, null, contract, null);
    assert.equal(v.valid, true, `expected valid: ${a} -> ${(v.reasons || []).join(',')}`);
  }
});

test('GEN-2: current-state affirmation under a future contract is rejected', () => {
  const graph = buildRelationshipGraph(FUTURE_KB);
  const contract = futureContract();
  const v = validateAnswer('She already knows Rust well.', FUTURE_SRC, 'Could she learn Rust?', FUTURE_KB, [], graph, null, contract, null);
  assert.equal(v.valid, false);
});

test('GEN-3: flat denial under a future contract is rejected as wrong frame', () => {
  const graph = buildRelationshipGraph(FUTURE_KB);
  const contract = futureContract();
  const v = validateAnswer('No, she does not know Rust.', FUTURE_SRC, 'Could she learn Rust?', FUTURE_KB, [], graph, null, contract, null);
  assert.equal(v.valid, false);
});

test('GEN-4: no exact-sentence ban remains on future capability', () => {
  const contract = futureContract();
  const exactBan = (contract.forbiddenClaims || []).find(c => /there is no verified evidence of .*; it is not documented/i.test(c));
  assert.equal(exactBan, undefined);
});

test('GEN-5: semantically equivalent UNKNOWN/QUALIFY phrasings pass', () => {
  const graph = buildRelationshipGraph(FUTURE_KB);
  const contract = buildResponseContract('Does she know Rust?', FUTURE_SRC, FUTURE_KB, [], null);
  assert.equal(contract.factState, 'UNKNOWN');
  const okForms = [
    'The public profile for Morgan Reyes does not establish Rust experience.',
    'Rust experience is not documented in Morgan Reyes\'s verified record.',
    "I can't verify current Rust experience for Morgan Reyes from the supplied evidence.",
    'There is no verified evidence that Morgan Reyes has Rust experience; it is not documented in the profile.'
  ];
  for (const a of okForms) {
    const v = validateAnswer(a, FUTURE_SRC, 'Does she know Rust?', FUTURE_KB, [], graph, null, contract, null);
    assert.equal(v.valid, true, `expected valid: ${a} -> ${(v.reasons || []).join(',')}`);
  }
});

test('GEN-6: hard denial and unjustified affirmations are rejected', () => {
  const graph = buildRelationshipGraph(FUTURE_KB);
  const contract = buildResponseContract('Does she know Rust?', FUTURE_SRC, FUTURE_KB, [], null);
  const bad = [
    'Morgan definitely cannot use Rust.',
    'She already knows Rust.',
    'She is an expert in Rust.'
  ];
  for (const a of bad) {
    const v = validateAnswer(a, FUTURE_SRC, 'Does she know Rust?', FUTURE_KB, [], graph, null, contract, null);
    assert.equal(v.valid, false, `expected rejection: ${a}`);
  }
});

test('GEN-7: contract instructions contain no lexical must-include word lists for UNKNOWN skills', () => {
  const contract = buildResponseContract('Does she know Rust?', FUTURE_SRC, FUTURE_KB, [], null);
  assert.ok(!/includes the words/i.test(JSON.stringify(contract)), 'lexical word-list instruction remains');
});
