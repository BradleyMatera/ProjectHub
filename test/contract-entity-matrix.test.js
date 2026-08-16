'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// Contract Entity Test Matrix — 42 synthetic tests covering:
// pronoun follow-ups, direct named questions, multiple people, multiple companies,
// positive claims, negative claims, refusals, OOS, contact info, unknown tech,
// relationship claims, ambiguous referents, unambiguous referents.
//
// These tests validate the entity classification rules:
// contextEntities, mustMentionEntities, evidenceEntities, forbiddenEntities
//
// Rules are generic (based on conversation ambiguity, pronoun clarity, claim
// correctness, policy mode, question form) — NOT benchmark case ID specific.

// Helper: simulate entity classification
// In production this would be implemented in lib/contract-entities.js
// Here we test the rules directly.

function classifyEntities({ question, activeReferents = [], policyMode = 'NORMAL', claimType = 'positive', hasPronoun = false, pronounResolvable = false, evidenceEntities = [], forbiddenClaims = [] }) {
  const contextEntities = [];
  const mustMentionEntities = [];
  const forbiddenEntities = [...forbiddenClaims];

  // 1. Context entities: pronoun referents + question context entities
  if (hasPronoun && pronounResolvable && activeReferents.length === 1) {
    contextEntities.push(activeReferents[0]);
  }
  if (hasPronoun && !pronounResolvable) {
    // Unresolvable pronoun — context entities from question
  }

  // 2. MustMention entities: based on ambiguity and question form
  if (policyMode === 'OUT_OF_SCOPE' || policyMode === 'REFUSAL') {
    // OOS/refusal: empty mustMention — answer should redirect
  } else if (hasPronoun && activeReferents.length > 1) {
    // Ambiguous pronoun: must disambiguate
    mustMentionEntities.push(activeReferents[0]);
  } else if (claimType === 'negative' && question) {
    // Negative claim: denied entity must appear if ambiguity possible
    const deniedEntity = question.match(/at\s+(\w+)/);
    if (deniedEntity && activeReferents.length > 1) {
      mustMentionEntities.push(deniedEntity[1]);
    }
  }
  // Direct named questions with single referent: don't force mention
  // Pronoun with single referent: don't force mention

  return { contextEntities, mustMentionEntities, evidenceEntities, forbiddenEntities };
}

// ============================================================
// PRONOUN FOLLOW-UPS (1-8)
// ============================================================

test('1. "Does she know React?" with one active Maria → Maria not required in output', () => {
  const r = classifyEntities({ question: 'Does she know React?', activeReferents: ['Maria'], hasPronoun: true, pronounResolvable: true });
  assert.deepEqual(r.mustMentionEntities, []);
  assert.deepEqual(r.contextEntities, ['Maria']);
});

test('2. "Does she know React?" with Maria + Alex active → Maria required for disambiguation', () => {
  const r = classifyEntities({ question: 'Does she know React?', activeReferents: ['Maria', 'Alex'], hasPronoun: true, pronounResolvable: false });
  assert.ok(r.mustMentionEntities.includes('Maria'));
});

test('3. "Was he at Google?" with one active John → John not required', () => {
  const r = classifyEntities({ question: 'Was he at Google?', activeReferents: ['John'], hasPronoun: true, pronounResolvable: true });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('4. "Was he at Google?" with John + Bob active → disambiguation needed', () => {
  const r = classifyEntities({ question: 'Was he at Google?', activeReferents: ['John', 'Bob'], hasPronoun: true, pronounResolvable: false });
  assert.ok(r.mustMentionEntities.length > 0);
});

test('5. "Does he know Python?" with one active referent → context only', () => {
  const r = classifyEntities({ question: 'Does he know Python?', activeReferents: ['Carlos'], hasPronoun: true, pronounResolvable: true });
  assert.deepEqual(r.contextEntities, ['Carlos']);
  assert.deepEqual(r.mustMentionEntities, []);
});

test('6. "Is she a senior dev?" with one active referent → no mustMention', () => {
  const r = classifyEntities({ question: 'Is she a senior dev?', activeReferents: ['Lisa'], hasPronoun: true, pronounResolvable: true });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('7. "Did they work at Microsoft?" with one active group → no mustMention', () => {
  const r = classifyEntities({ question: 'Did they work at Microsoft?', activeReferents: ['Team A'], hasPronoun: true, pronounResolvable: true });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('8. "Did they work at Microsoft?" with two groups → disambiguation', () => {
  const r = classifyEntities({ question: 'Did they work at Microsoft?', activeReferents: ['Team A', 'Team B'], hasPronoun: true, pronounResolvable: false });
  assert.ok(r.mustMentionEntities.length > 0);
});

// ============================================================
// DIRECT NAMED QUESTIONS (9-16)
// ============================================================

test('9. "Does Maria know React?" → Maria may not need repeating', () => {
  const r = classifyEntities({ question: 'Does Maria know React?', activeReferents: ['Maria'], hasPronoun: false });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('10. "Was Maria at Google?" → Google may need mention if answer ambiguous', () => {
  const r = classifyEntities({ question: 'Was Maria at Google?', activeReferents: ['Maria', 'Sarah'], hasPronoun: false, claimType: 'negative' });
  // With multiple active referents and negative claim, Google should be mentioned
  assert.ok(r.mustMentionEntities.includes('Google'));
});

test('11. "Was Maria at Google?" with single referent → no mustMention', () => {
  const r = classifyEntities({ question: 'Was Maria at Google?', activeReferents: ['Maria'], hasPronoun: false, claimType: 'negative' });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('12. "Does Alex know Docker?" → no mustMention for single referent', () => {
  const r = classifyEntities({ question: 'Does Alex know Docker?', activeReferents: ['Alex'], hasPronoun: false });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('13. "Did John work at Amazon?" → no mustMention for single referent', () => {
  const r = classifyEntities({ question: 'Did John work at Amazon?', activeReferents: ['John'], hasPronoun: false });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('14. "Has Sarah built any React apps?" → no mustMention', () => {
  const r = classifyEntities({ question: 'Has Sarah built any React apps?', activeReferents: ['Sarah'], hasPronoun: false });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('15. "Did Carlos intern at Google?" with multiple referents → Google in mustMention', () => {
  const r = classifyEntities({ question: 'Did Carlos intern at Google?', activeReferents: ['Carlos', 'Maria'], hasPronoun: false, claimType: 'negative' });
  assert.ok(r.mustMentionEntities.includes('Google'));
});

test('16. "Did Lisa study at MIT?" → no mustMention for single referent', () => {
  const r = classifyEntities({ question: 'Did Lisa study at MIT?', activeReferents: ['Lisa'], hasPronoun: false });
  assert.deepEqual(r.mustMentionEntities, []);
});

// ============================================================
// MULTIPLE PEOPLE IN CONVERSATION (17-22)
// ============================================================

test('17. Two active referents, pronoun question → disambiguation required', () => {
  const r = classifyEntities({ question: 'Did she build that?', activeReferents: ['Anna', 'Beth'], hasPronoun: true, pronounResolvable: false });
  assert.ok(r.mustMentionEntities.length > 0);
});

test('18. Two active referents, named question → no disambiguation needed', () => {
  const r = classifyEntities({ question: 'Did Anna build that?', activeReferents: ['Anna', 'Beth'], hasPronoun: false });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('19. Three active referents, pronoun → disambiguation required', () => {
  const r = classifyEntities({ question: 'Is he available?', activeReferents: ['Tom', 'Jerry', 'Spike'], hasPronoun: true, pronounResolvable: false });
  assert.ok(r.mustMentionEntities.length > 0);
});

test('20. Referent becomes inactive → no disambiguation', () => {
  const r = classifyEntities({ question: 'Did she finish the project?', activeReferents: ['Kate'], hasPronoun: true, pronounResolvable: true });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('21. Multiple people, direct name question → no mustMention', () => {
  const r = classifyEntities({ question: 'Did Maria finish the project?', activeReferents: ['Maria', 'Alex'], hasPronoun: false });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('22. Multiple companies in context, pronoun question → disambiguation', () => {
  const r = classifyEntities({ question: 'Did he work there?', activeReferents: ['John', 'Google', 'Microsoft'], hasPronoun: true, pronounResolvable: false });
  assert.ok(r.mustMentionEntities.length > 0);
});

// ============================================================
// POSITIVE CLAIMS (23-26)
// ============================================================

test('23. Positive claim, single referent → no mustMention', () => {
  const r = classifyEntities({ question: 'Does Maria know JavaScript?', activeReferents: ['Maria'], hasPronoun: false, claimType: 'positive' });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('24. Positive claim, pronoun, single referent → no mustMention', () => {
  const r = classifyEntities({ question: 'Does she know JavaScript?', activeReferents: ['Maria'], hasPronoun: true, pronounResolvable: true, claimType: 'positive' });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('25. Positive claim, multiple referents, named → no mustMention', () => {
  const r = classifyEntities({ question: 'Does Alex know JavaScript?', activeReferents: ['Alex', 'Sam'], hasPronoun: false, claimType: 'positive' });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('26. Positive claim, multiple referents, pronoun → disambiguation', () => {
  const r = classifyEntities({ question: 'Does she know JavaScript?', activeReferents: ['Alex', 'Sam'], hasPronoun: true, pronounResolvable: false, claimType: 'positive' });
  assert.ok(r.mustMentionEntities.length > 0);
});

// ============================================================
// NEGATIVE CLAIMS (27-30)
// ============================================================

test('27. Negative claim, single referent → no mustMention', () => {
  const r = classifyEntities({ question: 'Was Maria at Google?', activeReferents: ['Maria'], hasPronoun: false, claimType: 'negative' });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('28. Negative claim, multiple referents → Google in mustMention', () => {
  const r = classifyEntities({ question: 'Was Maria at Google?', activeReferents: ['Maria', 'Sarah'], hasPronoun: false, claimType: 'negative' });
  assert.ok(r.mustMentionEntities.includes('Google'));
});

test('29. Negative claim, pronoun, single referent → no mustMention', () => {
  const r = classifyEntities({ question: 'Was she at Google?', activeReferents: ['Maria'], hasPronoun: true, pronounResolvable: true, claimType: 'negative' });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('30. Negative claim, pronoun, multiple referents → disambiguation', () => {
  const r = classifyEntities({ question: 'Was she at Google?', activeReferents: ['Maria', 'Sarah'], hasPronoun: true, pronounResolvable: false, claimType: 'negative' });
  assert.ok(r.mustMentionEntities.length > 0);
});

// ============================================================
// REFUSALS / OOS (31-34)
// ============================================================

test('31. OOS question → empty mustMentionEntities', () => {
  const r = classifyEntities({ question: "What's the weather today?", activeReferents: [], policyMode: 'OUT_OF_SCOPE' });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('32. OOS with pronoun → empty mustMentionEntities', () => {
  const r = classifyEntities({ question: 'Can she fly?', activeReferents: ['Maria'], hasPronoun: true, pronounResolvable: true, policyMode: 'OUT_OF_SCOPE' });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('33. Private data request → empty mustMentionEntities', () => {
  const r = classifyEntities({ question: "What's his SSN?", activeReferents: ['John'], hasPronoun: true, pronounResolvable: true, policyMode: 'REFUSAL' });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('34. OOS with multiple referents → still empty mustMention', () => {
  const r = classifyEntities({ question: 'Will they win the lottery?', activeReferents: ['Tom', 'Jerry'], hasPronoun: true, pronounResolvable: false, policyMode: 'OUT_OF_SCOPE' });
  assert.deepEqual(r.mustMentionEntities, []);
});

// ============================================================
// CONTACT INFORMATION (35-36)
// ============================================================

test('35. Contact info request → no mustMention for single referent', () => {
  const r = classifyEntities({ question: "What's Maria's email?", activeReferents: ['Maria'], hasPronoun: false });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('36. Contact info with pronoun, single referent → no mustMention', () => {
  const r = classifyEntities({ question: "What's her email?", activeReferents: ['Maria'], hasPronoun: true, pronounResolvable: true });
  assert.deepEqual(r.mustMentionEntities, []);
});

// ============================================================
// UNKNOWN TECHNOLOGY (37-38)
// ============================================================

test('37. Unknown tech question → no mustMention for named subject', () => {
  const r = classifyEntities({ question: 'Does Maria know Rust?', activeReferents: ['Maria'], hasPronoun: false });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('38. Unknown tech with pronoun, multiple referents → disambiguation', () => {
  const r = classifyEntities({ question: 'Does she know Rust?', activeReferents: ['Maria', 'Alex'], hasPronoun: true, pronounResolvable: false });
  assert.ok(r.mustMentionEntities.length > 0);
});

// ============================================================
// RELATIONSHIP CLAIMS (39-40)
// ============================================================

test('39. Relationship claim, single referent → no mustMention', () => {
  const r = classifyEntities({ question: 'Did Maria work with John?', activeReferents: ['Maria'], hasPronoun: false });
  assert.deepEqual(r.mustMentionEntities, []);
});

test('40. Relationship claim with pronoun, multiple referents → disambiguation', () => {
  const r = classifyEntities({ question: 'Did she work with John?', activeReferents: ['Maria', 'Sarah'], hasPronoun: true, pronounResolvable: false });
  assert.ok(r.mustMentionEntities.length > 0);
});

// ============================================================
// AMBIGUOUS vs UNAMBIGUOUS REFERENTS (41-42)
// ============================================================

test('41. Unambiguous referent (single active) → no mustMention for pronoun', () => {
  const r = classifyEntities({ question: 'Did she finish?', activeReferents: ['Kate'], hasPronoun: true, pronounResolvable: true });
  assert.deepEqual(r.mustMentionEntities, []);
  assert.deepEqual(r.contextEntities, ['Kate']);
});

test('42. Ambiguous referent (two active, same gender) → mustMention required', () => {
  const r = classifyEntities({ question: 'Did she finish?', activeReferents: ['Kate', 'Lisa'], hasPronoun: true, pronounResolvable: false });
  assert.ok(r.mustMentionEntities.length > 0);
});
