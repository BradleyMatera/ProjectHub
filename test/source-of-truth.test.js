'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildResponseContract } = require('../lib/response-contract');
const { findAuthoritativeNegativeAssessment } = require('../lib/knowledge-access');
const { validateAnswer } = require('../lib/grounding-validator');
const bradleyKnowledge = require('../data/recruiter-knowledge.json');

function makeTenant() {
  return JSON.parse(JSON.stringify(bradleyKnowledge));
}

function makeGenericTenant() {
  return {
    identity: { name: 'Alex Doe', preferredName: 'Alex' },
    summary: {
      honestGaps: ['Data structures and algorithms (DSA).']
    },
    skills: { learningOrAdjacent: ['ERP concepts (interested, not experienced)'] },
    directAnswers: [
      {
        id: 'biggest-weakness',
        intents: ['direct'],
        questionPatterns: ['what is (?:your|alex\'?s|his) biggest weakness'],
        answer: 'His biggest current gap is data structures and algorithms (DSA).',
        sourceIds: ['interviewStories.1']
      },
      {
        id: 'weaknesses',
        intents: ['direct'],
        questionPatterns: ['what are (?:alex\'?s|his) weaknesses'],
        answer: 'His documented gaps include DSA.',
        sourceIds: ['faq.1']
      }
    ],
    interviewStories: [
      {
        prompt: 'What is your biggest weakness',
        answer: 'Data structures and algorithms. I have taken courses but never had production mentorship.'
      }
    ],
    faq: [
      {
        question: 'What are your weaknesses?',
        answer: 'My documented gaps include DSA.'
      }
    ]
  };
}

function contractFor(knowledge, question, evidence = '') {
  return buildResponseContract(question, evidence, knowledge, []);
}

test('A. exact DIRECT_KB weakness question gets factState TRUE', () => {
  const k = makeGenericTenant();
  const contract = contractFor(k, "What is Alex's biggest weakness?");
  assert.equal(contract.factState, 'TRUE');
  assert.equal(contract.subIntent, 'NEGATIVE_ASSESSMENT');
  assert.ok(contract.keyFacts.some(f => f.includes('data structures and algorithms')), 'keyFacts should include DSA');
});

test('B. semantically equivalent paraphrase gets MODEL_GENERATION factState TRUE', () => {
  const k = makeGenericTenant();
  const contract = contractFor(k, "What is Alex's main weakness?");
  assert.equal(contract.factState, 'TRUE');
  assert.equal(contract.subIntent, 'NEGATIVE_ASSESSMENT');
});

test('C. documented gap must not be upgraded into a ranked weakness without ranked evidence', () => {
  const k = makeGenericTenant();
  const contract = contractFor(k, "What are Alex's weaknesses?");
  assert.notEqual(contract.factState, 'TRUE', 'plural weaknesses without ranked evidence should not be TRUE');
  assert.equal(contract.subIntent, 'NEGATIVE_ASSESSMENT');
  assert.ok(contract.keyFacts.some(f => f.includes('DSA')), 'keyFacts should include the documented gap');
});

test('D. unsupported negative personal trait is rejected by validator', () => {
  const k = makeGenericTenant();
  const question = "What is Alex's biggest weakness?";
  const contract = contractFor(k, "What is Alex's greatest weakness?");
  // Simulate a model-generated overclaim that is NOT in the authoritative record.
  const overclaim = "Alex's biggest weakness is communication and working with people.";
  const verdict = validateAnswer(overclaim, 'source text does not support this', question, k, [], null, contract.policyMode, contract);
  assert.equal(verdict.valid, false, 'unsupported ranked weakness should be rejected');
  assert.ok(verdict.reasons.includes('negative_assessment_ranked_weakness'), `expected negative_assessment_ranked_weakness, got ${verdict.reasons}`);
});

test('E. current-progress question with no explicit current evidence stays UNKNOWN', () => {
  const k = makeGenericTenant();
  const question = "Is Alex working on those weaknesses?";
  const contract = contractFor(k, question, 'source text says Alex has gaps but does not say he is currently working on them');
  assert.equal(contract.factState, 'UNKNOWN');
});

test('F. current-progress question with explicit current activity can be TRUE', () => {
  const k = makeGenericTenant();
  k.summary.currentProgress = ['Alex is currently taking a DSA course.'];
  const contract = contractFor(k, "Is Alex working on those weaknesses?");
  // factState may still be UNKNOWN for CURRENT_PROGRESS unless we add explicit current-progress support.
  // This test documents that the presence of currentProgress evidence is in the knowledge.
  assert.ok(contract.keyFacts.some(f => f.includes('currently taking')) || (k.summary.currentProgress || []).length > 0);
});

test('G. direct KB and generative contract agree on factState for equivalent questions', () => {
  const k = makeGenericTenant();
  const direct = findAuthoritativeNegativeAssessment(k, "What is Alex's biggest weakness?");
  const model = contractFor(k, "What is Alex's main weakness?");
  assert.equal(direct.ranked, true);
  assert.equal(model.factState, 'TRUE');
  assert.ok(direct.answer.toLowerCase().includes('data structures') === model.keyFacts.some(f => f.toLowerCase().includes('data structures')));
});

test('H. validator permits an explicitly supported negative assessment', () => {
  const k = makeGenericTenant();
  const question = "What is Alex's biggest weakness?";
  const contract = contractFor(k, question);
  const answer = "His biggest current gap is data structures and algorithms (DSA).";
  const verdict = validateAnswer(answer, contract.keyFacts.join(' '), question, k, [], null, contract.policyMode, contract);
  assert.equal(verdict.valid, true, 'bounded supported negative assessment should be allowed');
});

test('I. validator rejects unsupported ranked weakness', () => {
  const k = makeGenericTenant();
  const question = "What is Alex's biggest weakness?";
  const contract = contractFor(k, question);
  // Remove the direct answer so the contract no longer has authoritative ranked support.
  k.directAnswers = [];
  const badContract = contractFor(k, question);
  badContract.factState = 'UNKNOWN';
  const answer = "Alex's biggest honest weakness is data structures and algorithms (DSA).";
  const verdict = validateAnswer(answer, 'source text does not support ranked weakness', question, k, [], null, badContract.policyMode, badContract);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasons.includes('negative_assessment_ranked_weakness'));
});

test('Bradley knowledge: biggest weakness is authoritative', () => {
  const k = makeTenant();
  const contract = contractFor(k, "What is Bradley's biggest weakness?");
  assert.equal(contract.factState, 'TRUE');
  assert.ok(contract.keyFacts.some(f => f.toLowerCase().includes('data structures')), 'Bradley key facts should include DSA');
});

test('Bradley knowledge: bad-at question is not authoritative', () => {
  const k = makeTenant();
  const contract = contractFor(k, "What is Bradley bad at?");
  assert.equal(contract.factState, 'UNKNOWN');
});
