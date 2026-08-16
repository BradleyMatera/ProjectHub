'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { validateAnswer } = require('../lib/grounding-validator');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { resolveReferent, buildConversationState } = require('../lib/conversation-resolver');

const knowledge = require('../data/recruiter-knowledge.json');
const source = require('fs').readFileSync('./data/recruiter-knowledge.json', 'utf8');
const graph = buildRelationshipGraph(knowledge);

// =========================================================
// Rust Identity Regression Tests
//
// These tests cover the exact production failure scenario:
// 1. Fabricated Rust expertise claims
// 2. Identity drift (racecar driver / wrong occupation)
// 3. Conversation contradiction (deny then affirm Rust)
// 4. Pronoun resolution ("he" → Bradley)
// 5. Stale Ollama UI text removed
// =========================================================

// R1: Unsupported Rust tech claim must be a hard fail
test('R1: Answer claiming Bradley knows Rust → unsupported (hard fail)', () => {
  const result = validateAnswer(
    'Bradley has experience with Rust and uses it for systems programming.',
    source, 'Does Bradley know Rust?', knowledge, [], graph, null
  );
  assert.equal(result.valid, false, 'Answer claiming Rust experience must be rejected');
  assert.ok(
    result.reasons.some(r => r.startsWith('unsupported_tech_claim')),
    `Should include unsupported_tech_claim reason, got: ${result.reasons.join(', ')}`
  );
});

// R2: Answer claiming Bradley is proficient in Rust → unsupported
test('R2: Answer claiming Bradley is proficient in Rust → unsupported', () => {
  const result = validateAnswer(
    'Bradley is proficient in Rust and has built several projects with it.',
    source, 'What languages does Bradley know?', knowledge, [], graph, null
  );
  assert.equal(result.valid, false, 'Answer claiming Rust proficiency must be rejected');
  assert.ok(
    result.reasons.some(r => r.startsWith('unsupported_tech_claim')),
    `Should include unsupported_tech_claim reason, got: ${result.reasons.join(', ')}`
  );
});

// R3: Answer claiming Bradley worked with Rust → unsupported
test('R3: Answer claiming Bradley worked with Rust → unsupported', () => {
  const result = validateAnswer(
    'Bradley has worked with Rust on several personal projects.',
    source, 'Has Bradley worked with Rust?', knowledge, [], graph, null
  );
  assert.equal(result.valid, false, 'Answer claiming Rust work experience must be rejected');
  assert.ok(
    result.reasons.some(r => r.startsWith('unsupported_tech_claim')),
    `Should include unsupported_tech_claim reason, got: ${result.reasons.join(', ')}`
  );
});

// R4: Fabricated occupation — racecar driver
test('R4: Answer claiming Bradley is a racing driver → unsupported (fabricated_occupation)', () => {
  const result = validateAnswer(
    'Bradley Matera is an American professional stock car racing driver. He competes full-time in the NASCAR Cup Series.',
    source, 'Who is Bradley Matera?', knowledge, [], graph, null
  );
  assert.equal(result.valid, false, 'Answer claiming racing driver occupation must be rejected');
  assert.ok(
    result.reasons.some(r => r.startsWith('fabricated_occupation')),
    `Should include fabricated_occupation reason, got: ${result.reasons.join(', ')}`
  );
});

// R5: Fabricated occupation — doctor
test('R5: Answer claiming Bradley is a doctor → unsupported (fabricated_occupation)', () => {
  const result = validateAnswer(
    'Bradley is a doctor who practices medicine at a local hospital.',
    source, 'What does Bradley do?', knowledge, [], graph, null
  );
  assert.equal(result.valid, false, 'Answer claiming doctor occupation must be rejected');
  assert.ok(
    result.reasons.some(r => r.startsWith('fabricated_occupation')),
    `Should include fabricated_occupation reason, got: ${result.reasons.join(', ')}`
  );
});

// R6: Conversation contradiction — previously denied Rust, now affirming
test('R6: Affirming Rust after previously denying it → contradiction', () => {
  const history = [
    { assistant: "Bradley doesn't have experience with Rust. His skills are primarily in JavaScript, Node.js, and web technologies." }
  ];
  const result = validateAnswer(
    'Yes, Bradley has experience with Rust and uses it regularly.',
    source, 'Does he know Rust?', knowledge, history, graph, null
  );
  assert.equal(result.valid, false, 'Contradictory Rust affirmation must be rejected');
  assert.ok(
    result.reasons.some(r => r.startsWith('conversation_contradiction')),
    `Should include conversation_contradiction reason, got: ${result.reasons.join(', ')}`
  );
});

// R7: Conversation contradiction — previously affirmed Rust, now denying
test('R7: Denying Rust after previously affirming it → contradiction', () => {
  const history = [
    { assistant: "Bradley has extensive experience with Rust and uses it for systems programming." }
  ];
  const result = validateAnswer(
    "No, Bradley doesn't have any experience with Rust at all.",
    source, 'Does he know Rust?', knowledge, history, graph, null
  );
  assert.equal(result.valid, false, 'Contradictory Rust denial must be rejected');
  assert.ok(
    result.reasons.some(r => r.startsWith('conversation_contradiction')),
    `Should include conversation_contradiction reason, got: ${result.reasons.join(', ')}`
  );
});

// R8: Correct answer about Rust (no Rust experience) → supported
test('R8: Answer correctly stating Bradley has no Rust experience → valid', () => {
  const result = validateAnswer(
    "Bradley doesn't have experience with Rust. His technical skills are primarily in JavaScript, Node.js, HTML, CSS, and related web technologies.",
    source, 'Does Bradley know Rust?', knowledge, [], graph, null
  );
  // Should not be rejected for unsupported_tech_claim (Rust is mentioned in negation)
  assert.ok(
    !result.reasons.some(r => r.startsWith('unsupported_tech_claim')),
    `Should not flag unsupported_tech_claim for negated Rust mention, got: ${result.reasons.join(', ')}`
  );
});

// R9: Pronoun resolution — "he" resolves to Bradley
test('R9: "he" pronoun resolves to Bradley Matera', () => {
  const convState = buildConversationState([], knowledge);
  const result = resolveReferent('Does he know Rust?', convState, knowledge);
  assert.ok(result.resolved, 'Should resolve "he" pronoun');
  assert.ok(
    result.rewrittenQuery.toLowerCase().includes('bradley'),
    `Rewritten query should contain "Bradley", got: ${result.rewrittenQuery}`
  );
  assert.equal(result.referentType, 'pronoun_he');
});

// R10: Pronoun resolution — "him" resolves to Bradley
test('R10: "him" pronoun resolves to Bradley Matera', () => {
  const convState = buildConversationState([], knowledge);
  const result = resolveReferent('Tell me about him.', convState, knowledge);
  assert.ok(result.resolved, 'Should resolve "him" pronoun');
  assert.ok(
    result.rewrittenQuery.toLowerCase().includes('bradley'),
    `Rewritten query should contain "Bradley", got: ${result.rewrittenQuery}`
  );
});

// R11: Pronoun resolution — "his" resolves to Bradley's
test('R11: "his" pronoun resolves to Bradley Matera', () => {
  const convState = buildConversationState([], knowledge);
  const result = resolveReferent('What are his skills?', convState, knowledge);
  assert.ok(result.resolved, 'Should resolve "his" pronoun');
  assert.ok(
    result.rewrittenQuery.toLowerCase().includes('bradley'),
    `Rewritten query should contain "Bradley", got: ${result.rewrittenQuery}`
  );
});

// R12: Correct identity answer (junior software engineer) → valid
test('R12: Answer correctly identifying Bradley as a junior software engineer → valid', () => {
  const result = validateAnswer(
    'Bradley Matera is a junior software engineer based in Denver, Colorado. He focuses on web development with JavaScript and Node.js.',
    source, 'Who is Bradley Matera?', knowledge, [], graph, null
  );
  assert.ok(
    !result.reasons.some(r => r.startsWith('fabricated_occupation')),
    `Should not flag fabricated_occupation for correct title, got: ${result.reasons.join(', ')}`
  );
});

// R13: lenientValidate rejects fabricated occupation (not just style)
// This tests that the lenient validator no longer tolerates factual errors
test('R13: Fabricated occupation in recovery is still rejected (not tolerated as style)', () => {
  // Simulate what lenientValidate does: only style reasons are tolerated
  const result = validateAnswer(
    'Bradley Matera is a professional racing driver who competes in NASCAR.',
    source, 'Who is Bradley?', knowledge, [], graph, null
  );
  assert.equal(result.valid, false, 'Must be rejected');
  const factualReasons = (result.reasons || []).filter(r => {
    const prefix = r.split(':')[0];
    return !['too_long', 'no_terminal_punctuation', 'too_many_sentences'].includes(r) &&
           !['too_long', 'no_terminal_punctuation', 'too_many_sentences'].includes(prefix);
  });
  assert.ok(factualReasons.length > 0, 'Must have factual reasons (not just style)');
});

// R14: No stale Ollama text in ProjectHub.js
test('R14: ProjectHub.js must not contain stale Ollama references', () => {
  const phContent = require('fs').readFileSync('./ProjectHub.js', 'utf8');
  assert.ok(
    !/ollama/i.test(phContent),
    'ProjectHub.js must not contain "Ollama" references'
  );
});

// R15: No stale Ollama text in ui.js
test('R15: ui.js must not contain stale Ollama references', () => {
  const uiContent = require('fs').readFileSync('./ui.js', 'utf8');
  assert.ok(
    !/ollama/i.test(uiContent),
    'ui.js must not contain "Ollama" references'
  );
});
