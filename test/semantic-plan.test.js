'use strict';

// Long-conversation semantic-plan / retrieval-architecture tests.
//
// These exercise the REAL pipeline pieces (buildSemanticPlan,
// buildRetrievalLegs, understandQuery, evaluateCompleteness) against
// synthetic tenants with long multi-turn histories. The invariants under
// test are the context-isolation guarantees:
//
//   - current-turn semantics always have priority over stale history
//   - no prior-turn salient words may leak into any retrieval leg
//   - continuations resolve through structure (referents, ordinals, facets),
//     never through bag-of-words history merges
//   - supported values must be surfaced for enumeration questions
//   - false unknowns are rejected when supported values exist

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSemanticPlan, buildRetrievalLegs } = require('../lib/semantic-plan');
const { understandQuery, normalizeQuery, expandQueryAliases } = require('../lib/query-understanding');
const { buildResponseContract } = require('../lib/response-contract');
const { evaluateCompleteness } = require('../lib/completeness-check');

// ---------- synthetic tenants ----------

const TENANT_PROFESSIONAL = {
  identity: { name: 'Morgan Reyes', preferredName: 'Morgan' },
  agent: { name: 'Scout' },
  pronouns: { subject: 'she', object: 'her', possessive: 'her' },
  skills: {
    languages: ['Python', 'Go', 'SQL'],
    frameworks: ['Django', 'FastAPI'],
    tools: ['Terraform', 'Kubernetes']
  },
  experience: [
    { company: 'Atlas Cloud', role: 'Backend Engineer', summary: 'Built billing services in Python and Go.' },
    { company: 'Field Research Collective', role: 'Research Assistant', summary: 'Supported field missions and data collection.' }
  ],
  projects: [
    { name: 'Orion Dashboard', tech: ['Python', 'FastAPI'], description: 'Analytics dashboard.' },
    { name: 'Pioneer CLI', tech: ['Go'], description: 'Command-line deployment tool.' }
  ],
  publications: [
    { title: 'Notes on Field Methodology' },
    { title: 'A Practical Guide to Billing Pipelines' }
  ]
};

const TENANT_BUSINESS = {
  identity: { name: 'Harbor Plumbing Co', preferredName: 'Harbor Plumbing' },
  agent: { name: 'Scout' },
  services: [
    { name: 'Drain Cleaning', price: '$150', duration: '1 hour' },
    { name: 'Water Heater Install', price: '$900', warranty: '2 years' }
  ],
  hours: 'Mon-Fri 8am-6pm',
  serviceArea: 'Greater Lakeside'
};

const TENANT_RESEARCHER = {
  identity: { name: 'Dr. Elena Vasquez', preferredName: 'Dr. Vasquez' },
  agent: { name: 'Scout' },
  pronouns: { subject: 'she', object: 'her', possessive: 'her' },
  education: { school: 'Coastal University', degree: 'PhD Marine Biology' },
  publications: [
    { title: 'Tidal Pool Ecology' },
    { title: 'Kelp Forest Recovery Patterns' }
  ],
  projects: [
    { name: 'Reef Survey 2024', description: 'Surveyed kelp density along the coast.' }
  ],
  awards: [{ name: 'Marine Stewardship Prize' }]
};

const TENANT_PRODUCT = {
  identity: { name: 'FerroStack', preferredName: 'FerroStack' },
  agent: { name: 'Scout' },
  product: {
    name: 'FerroStack',
    price: '$29/month',
    deployment: 'single binary, self-hosted',
    warranty: '30-day refund',
    supportedUsers: 'teams up to 50'
  }
};

const TENANT_EMPTY = {};

const TENANT_RECRUITER = require('../data/recruiter-knowledge.json');

// ---------- helpers ----------

function historyOf(pairs) {
  return pairs.map(([user, assistant]) => ({ user, assistant }));
}

function planFor(question, history, knowledge, resolvedQuestion) {
  return buildSemanticPlan({
    question,
    resolvedQuestion: resolvedQuestion || question,
    history,
    knowledge
  });
}

function legsFor(question, history, knowledge, resolvedQuestion) {
  const plan = planFor(question, history, knowledge, resolvedQuestion);
  const legs = buildRetrievalLegs({
    plan,
    normalize: q => normalizeQuery(q, knowledge),
    expand: expandQueryAliases
  });
  return { plan, legs };
}

function legQueries(legs) {
  return legs.map(l => l.query.toLowerCase()).join('  ');
}

// Words that must never leak into a later turn's legs.
const CONTAMINANTS = {
  professional: ['python', 'django', 'terraform', 'atlas', 'billing'],
  researcher: ['kelp', 'marine', 'tidal', 'reef', 'phd'],
  business: ['drain', 'plumbing', 'heater', 'lakeside'],
};

// ---------- Tenant A: software professional, long switching history ----------

test('LC-A1: long software-professional history does not contaminate a new topic', () => {
  const history = historyOf([
    ['What skills does Morgan have?', 'Morgan works with Python, Go, and SQL.'],
    ['Tell me about Atlas Cloud.', 'Morgan built billing services there in Python and Go.'],
    ['Which frameworks does she use?', 'Django and FastAPI are documented.'],
    ['What about Terraform?', 'Terraform is listed among her tools.'],
    ['Has she published anything?', 'She wrote Notes on Field Methodology.'],
    ['What missions did she support?', 'She supported field missions at the Research Collective.'],
    ['Tell me more about the field work.', 'Field work involved coastal data collection.'],
    ['Did she win anything for it?', 'No awards are documented for that work.'],
    ['What about her education?', 'Her education is not documented here.'],
    ['Where did she work before Atlas?', 'Field Research Collective.'],
  ]);
  const { plan, legs } = legsFor('What certifications does she hold?', history, TENANT_PROFESSIONAL);
  assert.equal(plan.topicShift, true);
  const qs = legQueries(legs);
  for (const word of CONTAMINANTS.professional) {
    assert.ok(!qs.includes(word), `leg leaked prior-turn word: ${word}`);
  }
  assert.ok(qs.includes('certifications'));
});

test('LC-A2: pronoun-only facet shift still targets the subject, not stale entities', () => {
  const history = historyOf([
    ['Tell me about Atlas Cloud.', 'Morgan built billing services there in Python and Go.'],
    ['What did she build?', 'Billing services in Python and Go.'],
    ['And the infrastructure?', 'Terraform and Kubernetes.'],
  ]);
  const { plan, legs } = legsFor('What is her tech stack?', history, TENANT_PROFESSIONAL);
  // "her" is a subject reference, not a discourse referent — the question is
  // a standalone facet request, so the old employer must not become a leg.
  const qs = legQueries(legs);
  assert.ok(!qs.includes('atlas'), 'Atlas leaked into legs');
  assert.ok(!qs.includes('terraform'), 'Terraform leaked into legs');
});

test('LC-A3: explicit entity switch wins over the active entity', () => {
  const history = historyOf([
    ['Tell me about Atlas Cloud.', 'Morgan built billing services there.'],
    ['What services does it use?', 'Billing runs on Python and Go services.'],
  ]);
  const { plan, legs } = legsFor('Now tell me about the Field Research Collective.', history, TENANT_PROFESSIONAL);
  assert.equal(plan.topicShift, true);
  assert.equal(plan.topicShiftReason, 'explicit-entity');
  const qs = legQueries(legs);
  assert.ok(!qs.includes('billing'), 'stale facet leaked');
});

test('LC-A4: ordinal continuation resolves through structure', () => {
  const history = historyOf([
    ['Compare Orion Dashboard and Pioneer CLI.', 'Orion is a Python dashboard; Pioneer is a Go CLI.'],
  ]);
  const resolved = 'Tell me more about Orion Dashboard';
  const { plan, legs } = legsFor('Tell me more about the first one', history, TENANT_PROFESSIONAL, resolved);
  assert.equal(plan.continuationType, 'ordinal');
  assert.ok(legQueries(legs).includes('orion'), 'resolved leg must carry the entity');
});

test('LC-A5: comparison continuation uses the alternatives set', () => {
  const history = historyOf([
    ['Compare Orion Dashboard and Pioneer CLI.', 'Orion is a Python dashboard; Pioneer is a Go CLI.'],
  ]);
  const plan = planFor('Which of them is more complex?', history, TENANT_PROFESSIONAL);
  assert.equal(plan.continuationType, 'comparison');
});

// ---------- Tenant B: local service business ----------

test('LC-B1: business facet questions stay on current-turn topic', () => {
  const history = historyOf([
    ['What services do you offer?', 'Drain Cleaning and Water Heater Install.'],
    ['How much is drain cleaning?', 'Drain Cleaning is $150.'],
    ['How long does it take?', 'About 1 hour.'],
    ['Do you cover Lakeside?', 'Yes, Greater Lakeside is the service area.'],
    ['What are your hours?', 'Mon-Fri 8am-6pm.'],
  ]);
  const { plan, legs } = legsFor('What is the warranty on installs?', history, TENANT_BUSINESS);
  const qs = legQueries(legs);
  for (const word of CONTAMINANTS.business) {
    assert.ok(!qs.includes(word), `leg leaked prior-turn word: ${word}`);
  }
});

// ---------- Tenant C: researcher ----------

test('LC-C1: researcher switch from education to publications', () => {
  const history = historyOf([
    ['Where did Dr. Vasquez study?', 'Coastal University, PhD Marine Biology.'],
    ['What is her specialty?', 'Kelp forest ecology.'],
    ['Tell me about Reef Survey 2024.', 'It surveyed kelp density along the coast.'],
  ]);
  const { legs } = legsFor('What has she published?', history, TENANT_RESEARCHER);
  const qs = legQueries(legs);
  for (const word of CONTAMINANTS.researcher) {
    assert.ok(!qs.includes(word), `leg leaked prior-turn word: ${word}`);
  }
});

// ---------- Tenant D: empty KB ----------

test('LC-D1: empty knowledge produces a safe plan with literal legs only', () => {
  const history = historyOf([
    ['What is 2+2?', '2 plus 2 equals 4.'],
    ['Hi there', 'Hello! How can I help?'],
  ]);
  const { plan, legs } = legsFor('Tell me something interesting', history, TENANT_EMPTY);
  assert.equal(plan.activeEntity, null);
  assert.ok(legs.length >= 1);
  assert.equal(legs[0].name, 'literal');
});

// ---------- Tenant E: product ----------

test('LC-E1: product facet switch does not inherit stale facets', () => {
  const history = historyOf([
    ['What does FerroStack cost?', 'It is $29/month.'],
    ['How is it deployed?', 'Single binary, self-hosted.'],
    ['Who is it for?', 'Teams up to 50.'],
  ]);
  const { legs } = legsFor('What is the warranty?', history, TENANT_PRODUCT);
  const qs = legQueries(legs);
  assert.ok(!qs.includes('deploy'), 'deployment facet leaked');
  assert.ok(!qs.includes('price') && !qs.includes('29'), 'price facet leaked');
});

// ---------- Tenant F: recruiter archived-style long context ----------

test('LC-F1: tech stack after Army history is not contaminated', () => {
  const history = historyOf([
    ['Tell me about his Army service', 'Bradley served as a 68W Combat Medic in the US Army.'],
    ['What awards did he get?', 'There is no verified record of awards.'],
    ['Did he lead anyone in the Army?', 'Leadership details are not documented.'],
    ['So would he do well in a team?', 'He has documented communication and pressure experience.'],
  ]);
  const { plan, legs } = legsFor('What is his tech stack?', history, TENANT_RECRUITER);
  assert.equal(plan.topicShift, true);
  const qs = legQueries(legs);
  for (const word of ['army', 'medic', '68w', 'awards', 'leadership']) {
    assert.ok(!qs.includes(word), `leg leaked prior-turn word: ${word}`);
  }
  assert.ok(qs.includes('tech stack') || qs.includes('stack'));
});

test('LC-F2: AWS services facet enumerates supported values', () => {
  const contract = buildResponseContract(
    'What AWS services has he used?',
    'AWS Lambda, Amazon DynamoDB, Amazon S3, AWS Amplify, Amazon CloudFront',
    TENANT_RECRUITER, [], null
  );
  const ob = contract.answerObligation;
  assert.ok(ob.supportedValues.length > 0, 'supported values must exist');
  assert.equal(ob.unknownAllowed, false);
  // An answer naming zero supported values must be rejected.
  const bad = evaluateCompleteness('He completed an AWS internship.', 'What AWS services has he used?',
    'AWS Lambda DynamoDB S3', contract);
  assert.equal(bad.complete, false);
  assert.equal(bad.reason, 'ENUMERATION_MISSING_VALUES');
  const good = evaluateCompleteness('He has used AWS Lambda and Amazon DynamoDB in his internship work.',
    'What AWS services has he used?', 'AWS Lambda DynamoDB S3', contract);
  assert.equal(good.complete, true);
});

test('LC-F3: false unknown under supported profile is rejected', () => {
  const contract = buildResponseContract(
    'Summarize Bradley as a junior software engineer',
    'Bradley Matera skills: JavaScript, TypeScript, React, Node.js, AWS.',
    TENANT_RECRUITER, [], null
  );
  const bad = evaluateCompleteness(
    'Bradley Matera is a junior software engineer with no verified record of specific skills, technologies, or experience beyond his current role.',
    'Summarize Bradley as a junior software engineer',
    'Bradley Matera skills: JavaScript, TypeScript, React, Node.js, AWS.', contract);
  assert.equal(bad.complete, false);
  assert.equal(bad.reason, 'FALSE_UNKNOWN_WITH_SUPPORT');
});

test('LC-F4: honest unknown for an unsupported facet remains valid', () => {
  const contract = buildResponseContract(
    'What awards did he get?',
    'Bradley Matera skills: JavaScript.',
    TENANT_RECRUITER, [], null
  );
  const ok = evaluateCompleteness(
    'There is no verified record of Bradley receiving awards; the public profile does not document any.',
    'What awards did he get?', 'Bradley Matera skills: JavaScript.', contract);
  assert.equal(ok.complete, true);
});

// ---------- history-length invariance ----------

test('LC-INV: long history never shrinks current-turn semantics', () => {
  // The same current-turn question must produce the same plan whether the
  // history is short or long.
  const shortHistory = historyOf([['Hi', 'Hello!']]);
  const longHistory = historyOf(Array.from({ length: 20 }, (_, i) =>
    [`Tell me about thing ${i}`, `Thing ${i} is a project in Go and Python.`]));

  const q = 'What is her tech stack?';
  const a = planFor(q, shortHistory, TENANT_PROFESSIONAL);
  const b = planFor(q, longHistory, TENANT_PROFESSIONAL);
  assert.equal(a.requestedFacet, b.requestedFacet);
  assert.equal(a.requestedTopic, b.requestedTopic);
  assert.equal(a.topicContinuity === 'shift' || a.topicContinuity === 'standalone', true);
  assert.equal(b.topicContinuity, a.topicContinuity);
});
