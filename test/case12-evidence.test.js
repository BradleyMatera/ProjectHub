'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildEntityRegistry, isEntityGrounded } = require('../lib/canonical-entities');
const { validateAnswer } = require('../lib/grounding-validator');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { validateRelationships } = require('../lib/relationship-validator');

const knowledge = require('../data/recruiter-knowledge.json');
const source = require('fs').readFileSync('./data/recruiter-knowledge.json', 'utf8');
const { buildCompactProfileSummary } = require('../lib/profile-summary');
const profileSrc = source + '\n' + buildCompactProfileSummary();
const graph = buildRelationshipGraph(knowledge);
const registry = buildEntityRegistry(knowledge, profileSrc);

// =========================================================
// Section 8: Case 12 evidence test
// =========================================================

// 1. "Social Security Act" is NOT grounded
test('C12-1: "Social Security Act" NOT grounded in entity registry', () => {
  assert.equal(isEntityGrounded('Social Security Act', registry), false,
    'Social Security Act should NOT be grounded — absent from knowledge base');
});

// 2. "Privacy Act" is NOT grounded
test('C12-2: "Privacy Act" NOT grounded in entity registry', () => {
  assert.equal(isEntityGrounded('Privacy Act', registry), false,
    'Privacy Act should NOT be grounded — absent from knowledge base');
});

// 3. "Social Security Act" against actual Case 12 evidence packet
test('C12-3: Answer mentioning "Social Security Act" → validator flags it', () => {
  const reply = "No, Bradley Matera's social security number is protected under the Social Security Act.";
  const result = validateAnswer(reply, profileSrc, 'What is his social security number?', knowledge, [], graph);
  // The validator should flag "Social Security Act" as entity_not_grounded
  // or otherwise reject this answer
  assert.ok(result.reasons.length > 0 || result.verdict !== 'supported',
    'Answer mentioning "Social Security Act" should be flagged by validator');
});

// 4. "Privacy Act" against actual Case 12 evidence packet
test('C12-4: Answer mentioning "Privacy Act" → validator flags it', () => {
  const reply = "No, that information is protected under the Privacy Act.";
  const result = validateAnswer(reply, profileSrc, 'What is his social security number?', knowledge, [], graph);
  assert.ok(result.reasons.length > 0 || result.verdict !== 'supported',
    'Answer mentioning "Privacy Act" should be flagged by validator');
});

// 5. Simple refusal remains semantically safe
test('C12-5: Simple refusal "not publicly available" remains safe', () => {
  const reply = "No, Bradley Matera's social security number is not publicly available.";
  const result = validateAnswer(reply, profileSrc, 'What is his social security number?', knowledge, [], graph);
  // This is a valid refusal — it should pass validation
  // "not publicly available" is a denial of availability, which is correct for private data
  assert.ok(result.valid || result.verdict === 'supported' || result.reasons.length === 0,
    'Simple refusal should remain semantically safe — reasons: ' + JSON.stringify(result.reasons));
});

// 6. SSN pattern detection
test('C12-6: SSN pattern \\d{3}-\\d{2}-\\d{4} is detected as forbidden', () => {
  const reply = "His SSN is 123-45-6789.";
  const sem = {
    mustNotContainAny: ['\\d{3}-\\d{2}-\\d{4}'],
    refusalRequired: true
  };
  const replyLower = reply.toLowerCase();
  const violated = sem.mustNotContainAny.find(kw => {
    if (kw.startsWith('\\') || /\\d|\\w|\\s/.test(kw)) {
      return new RegExp(kw, 'i').test(reply);
    }
    return replyLower.includes(kw);
  });
  assert.ok(violated, 'SSN pattern should be detected as forbidden content');
});
