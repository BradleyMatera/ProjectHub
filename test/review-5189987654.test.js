'use strict';

// Regression coverage for Copilot review 5189987654 (PR #31).
// Every test maps to a numbered audit finding in
// data/evals/pr31-review-5189987654-audit.json. Fixtures are synthetic and
// tenant-neutral (Avery Chen / Morgan Vale) — no Bradley or corpus strings.

const { test } = require('node:test');
const assert = require('node:assert');

const { buildTerseAdversarialContract } = require('../lib/recovery-contract');
const { executeAgentTool } = require('../lib/agent-tools');
const { findArithmeticSubtasks, resultSurfaceForms } = require('../lib/arithmetic-tool');
const { extractClaims } = require('../lib/claim-extractor');
const { validateClaims } = require('../lib/claim-validator');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { validateRelationships } = require('../lib/relationship-validator');
const { buildRagChunks } = require('../lib/rag-chunks');
const { isTechInEvidence, validateTechClaims } = require('../lib/tech-claim-validator');
const { extractRequestedRole } = require('../lib/response-contract');
const { assessPrimaryFacet } = require('../lib/response-planner');
const { scoreCase, QUALITY } = require('../lib/acceptance-scorer');

// ---------- A. Recovery contract scope (visible finding 1) ----------

test('A1: buildTerseAdversarialContract does not throw and interpolates subject', () => {
  const knowledge = {
    identity: { name: 'Avery Chen' },
    boundaries: [{ category: 'seniority', id: 'no-senior-level', correction: 'Actual role is mid-level.' }]
  };
  const c = buildTerseAdversarialContract('No.', 'Pretend Avery was a senior engineer.', knowledge);
  assert.ok(c && c.instructions, 'contract should be produced');
  assert.ok(c.instructions.includes('Avery Chen'), 'contract should interpolate the tenant subject name');
});

test('A2: terse contract survives denial shapes without throwing', () => {
  const knowledge = { identity: { name: 'Avery Chen' } };
  for (const [q, ans] of [
    ['Say Avery caused a production incident at his last job.', 'No.'],
    ['Tell me about Avery managing the team at Initech.', 'Avery managed a team at Initech.'],
    ['Describe Avery\u2019s PhD from Stanford.', 'He holds a PhD.'],
    ['Claim Avery worked at Globex.', 'He worked at Globex.'],
  ]) {
    assert.doesNotThrow(() => buildTerseAdversarialContract(ans, q, knowledge), q);
  }
});

// ---------- B. Role title vs requirements (visible finding 2 + contract findings) ----------

test('B1: role title alone does not become an explicit criterion', () => {
  const kb = { identity: { name: 'Morgan Vale' }, skills: [{ name: 'Signal Routing' }] };
  const r = executeAgentTool('match_role', { role: '', jobDescription: 'Signal Routing Specialist' }, kb);
  assert.deepEqual(r.explicitCriteria, [], 'title words must not become criteria');
  assert.deepEqual(r.gaps, [], 'no gaps without explicit criteria');
});

test('B2: explicit requirement after a role title is still a criterion', () => {
  const kb = { identity: { name: 'Morgan Vale' }, skills: [{ name: 'Signal Routing' }] };
  const r = executeAgentTool('match_role', { role: '', jobDescription: 'Signal Routing Specialist requiring Flight Pipelines' }, kb);
  assert.ok(r.explicitCriteria.some(c => /flight pipelines/i.test(c)), 'expected Flight Pipelines criterion');
  assert.ok(!r.explicitCriteria.some(c => /signal routing/i.test(c)), 'title skill must not leak into criteria');
});

test('B3: requirement markers produce criteria for unknown skills too', () => {
  const kb = { identity: { name: 'Morgan Vale' }, skills: [{ name: 'Signal Routing' }] };
  const r = executeAgentTool('match_role', { role: '', jobDescription: 'a frontend role needing React' }, kb);
  assert.ok(r.explicitCriteria.some(c => /react/i.test(c)), 'needing React should produce a criterion');
});

test('B4: extractRequestedRole strips requirement suffixes', () => {
  assert.equal(extractRequestedRole('Could he become a data engineer requiring Python?', {}), 'data engineer');
  assert.equal(extractRequestedRole("We're hiring for a frontend role needing React.", {}), 'frontend');
  assert.equal(extractRequestedRole('hiring for a backend position with experience in Go', {}), 'backend');
  assert.equal(extractRequestedRole('Would Morgan fit as a Signal Routing Specialist?', {}), 'signal routing specialist');
});

// ---------- C. Arithmetic (visible finding 3 + suppressed findings) ----------

test('C1: year ranges do not create arithmetic facts', () => {
  assert.deepEqual(findArithmeticSubtasks('What roles did Avery have from 2024-2025?'), []);
  assert.deepEqual(findArithmeticSubtasks('In 2024-2025 he worked there.'), []);
});

test('C2: explicit subtraction across years still computes', () => {
  const facts = findArithmeticSubtasks('What is 2024 - 2025?');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].result, -1);
});

test('C3: signed operands are preserved', () => {
  const facts = findArithmeticSubtasks('What is -3 + 5?');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].result, 2);
});

test('C4: composite number words parse as one operand', () => {
  const facts = findArithmeticSubtasks('What is two hundred plus two?');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].result, 202);
});

test('C5: percent-of grammar computes the advertised result', () => {
  const facts = findArithmeticSubtasks('What is 15% of 200?');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].result, 30);
});

test('C6: modulo stays distinct from percent-of', () => {
  const a = findArithmeticSubtasks('What is 15 % 4?');
  const b = findArithmeticSubtasks('What is 15 modulo 4?');
  assert.equal(a[0]?.result, 3);
  assert.equal(b[0]?.result, 3);
});

test('C7: unrelated declarative quantities do not create math', () => {
  assert.deepEqual(findArithmeticSubtasks('She has 2 projects and uses 3 frameworks. How many projects?'), []);
});

test('C8: contained word problem still computes', () => {
  const facts = findArithmeticSubtasks('Avery has 12 tickets and closes 5. How many remain?');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].result, 7);
});

test('C9: negative results have matchable surface forms', () => {
  const forms = resultSurfaceForms(-2);
  assert.ok(forms.includes('-2'));
  const esc = '-2'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w])${esc}(?![\\w])`, 'i');
  assert.ok(re.test('the answer is -2'), 'signed result must be matchable in answer text');
  assert.ok(!re.test('the answer is -22'), 'must not prefix-match a longer number');
});

// ---------- D. Property claims (suppressed findings) ----------

const propKnowledge = {
  identity: { name: 'Avery Chen' },
  preferences: { relocation: 'Open to relocation' }
};

test('D1: coordinated property predicates extract every proposition', () => {
  const graph = buildRelationshipGraph(propKnowledge);
  const claims = extractClaims('Avery is open to relocation and willing to travel.', graph);
  const props = claims.filter(c => c.relation === 'has_property').map(c => c.object);
  assert.ok(props.some(o => /relocation/i.test(o)), `missing relocation in ${JSON.stringify(props)}`);
  assert.ok(props.some(o => /travel/i.test(o)), `missing travel in ${JSON.stringify(props)}`);
});

test('D2: unsupported coordinated property is rejected even when the first is supported', () => {
  const graph = buildRelationshipGraph(propKnowledge);
  const result = validateRelationships('Avery is open to relocation and willing to travel.', graph);
  assert.equal(result.valid, false, `expected rejection, got ${JSON.stringify(result.unsupportedClaims)}`);
  assert.ok(result.unsupportedClaims.some(c => /travel/i.test(c.object || c.claim?.object || '')));
});

test('D3: reversed coordination order is also rejected', () => {
  const graph = buildRelationshipGraph(propKnowledge);
  const result = validateRelationships('Avery is willing to travel and open to relocation.', graph);
  assert.equal(result.valid, false);
});

test('D4: frame-only property with no content words is unsupported', () => {
  const graph = buildRelationshipGraph({ identity: { name: 'Avery Chen' } });
  const result = validateRelationships('Avery is open to the role.', graph);
  assert.equal(result.valid, false, 'empty-content property must not auto-pass');
});

test('D5: property key existence does not prove affirmative polarity', () => {
  const kb = { identity: { name: 'Avery Chen' }, goals: { relocation: 'Not open to relocation' } };
  const graph = buildRelationshipGraph(kb);
  const result = validateRelationships('Avery is open to relocation.', graph);
  assert.equal(result.valid, false, 'negated authored value must not support a positive claim');
});

test('D6: affirmative authored value supports the positive claim', () => {
  const kb = { identity: { name: 'Avery Chen' }, goals: { relocation: 'Open to relocation' } };
  const graph = buildRelationshipGraph(kb);
  const result = validateRelationships('Avery is open to relocation.', graph);
  assert.equal(result.valid, true, JSON.stringify(result.unsupportedClaims));
});

test('D7: string availability sections index as has_property evidence', () => {
  const kb = { identity: { name: 'Avery Chen' }, availability: 'Available for remote work' };
  const graph = buildRelationshipGraph(kb);
  assert.ok(graph.triples.some(t => t.relation === 'has_property' && /remote work/i.test(String(t.object))),
    'string availability should produce a property triple');
});

test('D8: array preference sections index separately with preserved polarity', () => {
  const kb = { identity: { name: 'Avery Chen' }, preferences: ['Remote preferred', 'No overnight travel'] };
  const graph = buildRelationshipGraph(kb);
  const props = graph.triples.filter(t => t.relation === 'has_property');
  assert.ok(props.some(t => /remote/i.test(String(t.object))), 'remote preference indexed');
  assert.ok(props.some(t => /overnight travel/i.test(String(t.object))), 'travel preference indexed');
});

// ---------- E. Technology scoped grounding (2 suppressed findings) ----------

test('E1: negated evidence does not support a positive tech claim', () => {
  assert.equal(isTechInEvidence('Rust', 'Rust is not documented.', ['Rust']), false);
  assert.equal(isTechInEvidence('Rust', 'There is no verified evidence of Rust experience.', ['Rust']), false);
});

test('E2: affirmative scoped evidence supports the claim', () => {
  assert.equal(isTechInEvidence('Rust', 'Avery uses Rust in Project Alpha.', ['Rust']), true);
});

test('E3: global known tech does not override absent scoped evidence', () => {
  const knowledge = {
    identity: { name: 'Avery Chen' },
    projects: [
      { name: 'Project Alpha', tech: ['React'] },
      { name: 'Project Beta', tech: ['Rust'] },
    ]
  };
  const graph = buildRelationshipGraph(knowledge);
  const result = validateRelationships('Project Alpha uses Rust.', graph);
  assert.equal(result.valid, false, 'cross-project tech must be rejected');
});

test('E4: unrelated negated clause does not support the tech', () => {
  assert.equal(
    isTechInEvidence('COBOL', 'She does not know COBOL, but has experience with JavaScript.', ['COBOL']),
    false
  );
});

// ---------- F. Facet semantics (4 suppressed findings) ----------

const facetKnowledge = {
  identity: { name: 'Morgan Vale' },
  skills: [{ name: 'JavaScript' }, { name: 'React' }],
  services: [{ name: 'Atlas Consulting', duration: '6 weeks' }],
  products: [{ name: 'Northstar Desk', price: '$10', warranty: '2 years' }]
};

function facetOf(question, knowledge) {
  const graph = buildRelationshipGraph(knowledge);
  return assessPrimaryFacet({ question, knowledge, graph, subjectName: 'Morgan Vale' });
}

test('F1: offered services resolve the services collection, not technologies', () => {
  const f = facetOf('What services does Morgan Vale offer?', facetKnowledge);
  assert.equal(f.matched, true);
  assert.equal(f.facet, 'services');
  assert.ok(f.values.some(v => /Atlas Consulting/i.test(v)), JSON.stringify(f.values));
  assert.ok(!f.values.some(v => /JavaScript|React/i.test(v)), 'technologies must not be listed as offered services');
});

test('F2: named product attribute facets resolve without top-level collections', () => {
  const price = facetOf('What price does Northstar Desk have?', facetKnowledge);
  assert.equal(price.matched, true);
  assert.ok(price.values.some(v => /\$10/.test(v)), JSON.stringify(price.values));
  const warranty = facetOf('What warranty does Northstar Desk have?', facetKnowledge);
  assert.equal(warranty.matched, true);
  assert.ok(warranty.values.some(v => /2 years/i.test(v)), JSON.stringify(warranty.values));
});

test('F3: service attribute facets resolve through normalized entities', () => {
  const f = facetOf('What duration does Atlas Consulting have?', facetKnowledge);
  assert.equal(f.matched, true);
  assert.ok(f.values.some(v => /6 weeks/i.test(v)), JSON.stringify(f.values));
});

test('F4: publishing verb variants select the publications facet', () => {
  for (const q of ['What is Morgan publishing?', 'What did Morgan Vale publish?']) {
    const f = facetOf(q, facetKnowledge);
    assert.equal(f.matched, true, q);
    assert.equal(f.facet, 'publications', q);
  }
});

// ---------- G. Deployment metadata parity + provenance (visible 4-5 + suppressed) ----------

test('G1: all supported deployment fields appear in retrieval text', () => {
  const kb = {
    identity: { name: 'Avery Chen' },
    projects: [
      { name: 'Alpha', description: 'A thing', deployedAt: 'Netlify' },
      { name: 'Beta', description: 'B thing', platform: 'Vercel', deployment: 'Edge' },
    ],
    codePens: [{ name: 'Pen One', deployment: 'CodePen.io' }],
    products: [{ name: 'Northstar Desk', deployment: 'Shopify' }],
  };
  const chunks = buildRagChunks(kb).map(c => c.text).join('\n');
  for (const value of ['Netlify', 'Vercel', 'Edge', 'CodePen.io', 'Shopify']) {
    assert.ok(chunks.includes(value), `retrieval text should contain ${value}`);
  }
});

test('G2: deployment provenance names the actual source field', () => {
  const kb = {
    identity: { name: 'Avery Chen' },
    projects: [{ name: 'Alpha', description: 'A thing', deployedAt: 'Netlify' }],
    codePens: [{ name: 'Pen One', deployment: 'CodePen.io' }],
    products: [{ name: 'Northstar Desk', deployment: 'Shopify' }],
  };
  const graph = buildRelationshipGraph(kb);
  const bySubject = Object.fromEntries(
    graph.triples.filter(t => t.relation === 'deployed_at').map(t => [t.subject, t.source])
  );
  assert.equal(bySubject['Alpha'], 'projects[0].deployedAt');
  assert.equal(bySubject['Pen One'], 'codePens[0].deployment');
  assert.equal(bySubject['Northstar Desk'], 'products[0].deployment');
});

test('G3: platform provenance stays platform when platform supplies the value', () => {
  const kb = {
    identity: { name: 'Avery Chen' },
    projects: [{ name: 'Beta', description: 'B thing', platform: 'Vercel' }],
  };
  const graph = buildRelationshipGraph(kb);
  const t = graph.triples.find(t => t.relation === 'deployed_at' && t.subject === 'Beta');
  assert.equal(t.source, 'projects[0].platform');
  assert.equal(t.object, 'Vercel');
});

// ---------- H. Scorer clause scope + claim-validator evidence fallback ----------

function makeResult(reply, contract = {}) {
  return { body: { ok: true, reply, provider: 'ollama', proseSource: 'MODEL_GENERATION', contract } };
}
const scorerKb = { identity: { name: 'Avery Chen' }, skills: [] };

test('H1: affirmative clause after a negated clause is not suppressed', () => {
  const c = { id: 'unknown-skill', message: 'Does she know COBOL?', semanticType: 'UNKNOWN_SKILL', expect: {} };
  const contract = { intent: 'SKILL', subIntent: 'SKILL_EVIDENCE', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' };
  const s = scoreCase(c, makeResult('She does not know COBOL, but has experience with COBOL.', contract), { knowledge: scorerKb });
  assert.equal(s.quality, QUALITY.OVERCLAIM, s.reason);
});

test('H2: negated mastery in the same clause stays suppressed', () => {
  const c = { id: 'unknown-skill', message: 'Does she know COBOL?', semanticType: 'UNKNOWN_SKILL', expect: {} };
  const contract = { intent: 'SKILL', subIntent: 'SKILL_EVIDENCE', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' };
  const s = scoreCase(c, makeResult('She does not have experience with COBOL.', contract), { knowledge: scorerKb });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

test('C10: control-mode turns still enforce computed-result completeness', () => {
  const { validateAnswer } = require('../lib/grounding-validator');
  const contract = { computedFacts: [{ display: '2024 - 2025', result: -1, kind: 'expression' }] };
  const missing = validateAnswer(
    'He has one year less experience than 2024.',
    '', 'What is 2024 - 2025?', null, [], null, 'CONVERSATIONAL', contract, []);
  assert.equal(missing.valid, false);
  assert.ok((missing.reasons || []).some(r => r.startsWith('missing_computed_result:')));
  const stated = validateAnswer(
    '2024 minus 2025 is -1.',
    '', 'What is 2024 - 2025?', null, [], null, 'CONVERSATIONAL', contract, []);
  assert.equal(stated.valid, true, JSON.stringify(stated.reasons));
});

test('H3: project-tech claim supported only by evidenceText validates', () => {
  const knowledge = {
    identity: { name: 'Avery Chen' },
    projects: [{ name: 'Alpha', description: 'A thing' }],
  };
  const contract = { requestedTopic: 'Rust' };
  const evidenceText = '- [project:Alpha] Alpha uses Rust for its runtime.';
  // Empty structured evidence must fall back to evidenceText instead of
  // discarding it as a truthy empty array.
  const invalid = validateClaims('Project Alpha uses Rust.', 'What does Alpha use?', contract, evidenceText, knowledge, []);
  assert.ok(!invalid.some(i => i.type === 'PROJECT_RELATIONSHIP_CLAIM'), JSON.stringify(invalid));
});

// ---------- I. Live-qualification follow-ups (post-deploy battery) ----------

test('I1: bare computed result answer is not a parse failure', async () => {
  // Live battery: "What is 2024 - 2025?" — the model answered
  // {"answer":"-1"}; the <3-char check rejected it and the repair produced
  // the same correct JSON, yielding INFERENCE_UNAVAILABLE for a correct
  // computed answer.
  const router = require('../lib/local-model-router');
  const { runRagPrimaryAgent } = require('../lib/rag-agent');
  const knowledge = { identity: { name: 'Avery Chen' } };
  const origGenerate = router.generate;
  router.generate = async () => ({
    ok: true,
    text: JSON.stringify({ answer: '-1' }),
    usage: { provider: 'stub', promptEvalCount: 10, evalCount: 4 },
    latencyMs: 50,
    model: 'stub-model'
  });
  try {
    const result = await runRagPrimaryAgent({
      question: 'What is 2024 - 2025?',
      conversationState: { turns: [] },
      evidence: [],
      knowledge,
      sessionId: 'i1',
      policyContract: { mode: 'CONVERSATIONAL' },
      deadlineAt: Date.now() + 15000
    });
    assert.equal(result.inferenceUnavailable, undefined, JSON.stringify(result.events));
    assert.equal(result.reply, '-1');
    assert.equal(result.proseSource, 'MODEL_GENERATION');
  } finally {
    router.generate = origGenerate;
  }
});

test('I2: declared subjectAliases resolve as the tenant subject in facet questions', () => {
  // Live battery: "What roles did Bradley have from 2024-2025?" — the
  // contract's framing subject was a company, so 'bradley' was not a name
  // part and the facet silently resolved to entity 'brad' → supported:false
  // → the correct model answer was rejected and "not documented" accepted.
  const knowledge = {
    identity: { name: 'Avery Chen' },
    subjectAliases: ['Avery', 'Chen'],
    experience: [{ role: 'Data Engineer', company: 'Acme Corp', type: 'Full-time' }]
  };
  const g = buildRelationshipGraph(knowledge);
  const r = assessPrimaryFacet({
    question: 'What roles did Chen have from 2024-2025?',
    knowledge,
    graph: g,
    subjectName: 'Acme Corp'  // framing subject is a company, not the person
  });
  assert.equal(r.matched, true);
  assert.equal(r.supported, true, JSON.stringify(r));
  assert.deepEqual(r.values, ['Data Engineer']);
});

test('I3: token resolving to the tenant subject stays a subject reference', () => {
  // No declared aliases: 'avery chen' is not in subjectAliases but fuzzy-
  // resolves to the subjectNorm — it must not become an entitySubject.
  const knowledge = {
    identity: { name: 'Avery Chen-Watanabe' },
    experience: [{ role: 'Site Reliability Engineer', company: 'Initech', type: 'Full-time' }]
  };
  const g = buildRelationshipGraph(knowledge);
  const r = assessPrimaryFacet({
    question: 'What roles did Avery Chen have?',
    knowledge,
    graph: g,
    subjectName: 'Initech'
  });
  assert.equal(r.matched, true);
  assert.equal(r.supported, true, JSON.stringify(r));
  assert.deepEqual(r.values, ['Site Reliability Engineer']);
});
