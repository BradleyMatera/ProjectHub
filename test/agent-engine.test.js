'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAnswer, validateToolDecision, attemptJsonRepair, extractCompleteSentences } = require('../lib/grounding-validator');
const { buildReasoningPacket, buildSynthesisPacket, buildRawPacket, estimateTokens, renderEvidenceList } = require('../lib/context-packet');
const { freshState, updateState, getState, clearState, detectTopic, detectProjects, resolveReferents } = require('../lib/session-state');
const { parseDecision, clampArgs, clampObservation, allToolNames } = require('../lib/agent-engine');
const router = require('../lib/local-model-router');

// Grounding validator
test('validateAnswer accepts a grounded answer', () => {
  const source = 'Bradley built ProjectHub using JavaScript and AWS Lambda. He has an AWS certification.';
  const result = validateAnswer('Bradley built ProjectHub with JavaScript and AWS Lambda.', source, 'What did Bradley build?');
  assert.equal(result.valid, true);
  assert.equal(result.verdict, 'supported');
});

test('validateAnswer rejects overclaim language', () => {
  const source = 'Bradley has an AWS certification and built a Lambda project.';
  const result = validateAnswer('Bradley is an AWS expert with deep expertise in Lambda.', source, 'Does Bradley know AWS?');
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r === 'overclaim_language' || r.startsWith('upgrade:')));
});

test('validateAnswer rejects unsupported entity', () => {
  const source = 'Bradley built ProjectHub with JavaScript.';
  const result = validateAnswer('Bradley built ProjectHub and also worked at Google with Kubernetes.', source, 'What did Bradley build?');
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.startsWith('entity_not_grounded:')));
});

test('validateAnswer rejects unsupported number', () => {
  const source = 'Bradley has an AWS certification.';
  const result = validateAnswer('Bradley has 10 years of AWS experience.', source, 'Does Bradley know AWS?');
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.startsWith('number_not_grounded') || r.startsWith('upgrade:years')));
});

test('validateAnswer rejects AI slop', () => {
  const source = 'Bradley built ProjectHub with JavaScript and AWS Lambda.';
  const result = validateAnswer('Based on the data provided, Bradley built ProjectHub with JavaScript.', source, 'What did Bradley build?');
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('ai_slop'));
});

test('validateAnswer rejects irrelevant answer', () => {
  const source = 'Bradley built ProjectHub with JavaScript and AWS Lambda.';
  const result = validateAnswer('Bradley lives in California and likes hiking.', source, 'What did Bradley build with AWS?');
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('not_relevant_to_question'));
});

test('validateToolDecision accepts a valid tool request', () => {
  const result = validateToolDecision({ action: 'tool', tool: 'search_portfolio', arguments: { query: 'AWS' } }, ['search_portfolio', 'get_project']);
  assert.equal(result.valid, true);
  assert.equal(result.decision.tool, 'search_portfolio');
});

test('validateToolDecision rejects unknown tool', () => {
  const result = validateToolDecision({ action: 'tool', tool: 'delete_database', arguments: {} }, ['search_portfolio']);
  assert.equal(result.valid, false);
  assert.ok(result.error.startsWith('unknown_tool:'));
});

test('validateToolDecision accepts a direct answer', () => {
  const result = validateToolDecision({ action: 'answer', answer: 'Bradley built ProjectHub with AWS Lambda.' }, []);
  assert.equal(result.valid, true);
  assert.equal(result.decision.action, 'answer');
});

test('validateToolDecision rejects unknown action with no answer or tool', () => {
  const result = validateToolDecision({ action: 'shell', command: 'rm -rf /' }, []);
  assert.equal(result.valid, false);
});

test('attemptJsonRepair extracts JSON from markdown fences', () => {
  const repaired = attemptJsonRepair('```json\n{"action":"answer","answer":"yes"}\n```');
  assert.equal(repaired.action, 'answer');
});

test('attemptJsonRepair handles trailing commas', () => {
  const repaired = attemptJsonRepair('{"action":"tool","tool":"get_project","arguments":{"name":"ProjectHub",}}');
  assert.equal(repaired.tool, 'get_project');
});

test('attemptJsonRepair returns null for non-JSON', () => {
  assert.equal(attemptJsonRepair('I cannot help with that.'), null);
});

// Context packet
test('buildReasoningPacket produces compact context', () => {
  const packet = buildReasoningPacket({
    question: 'What did Bradley do with AWS?',
    conversationState: { currentTopic: 'aws', currentProjects: [], recentTurns: [] },
    evidence: [
      { kind: 'project', name: 'ProjectHub', description: 'A chat widget using AWS Lambda', tech: ['JavaScript', 'AWS Lambda'] },
      { kind: 'certification', name: 'AWS Certified' }
    ],
    toolNames: ['search_portfolio', 'get_project'],
    rules: 'Answer grounded.',
    phase: 'reason'
  });
  assert.ok(packet.systemPrompt.includes('VERIFIED_EVIDENCE'));
  assert.ok(packet.systemPrompt.includes('AVAILABLE_TOOLS'));
  assert.ok(packet.systemPrompt.includes('search_portfolio'));
  assert.ok(packet.estimatedTokens > 50 && packet.estimatedTokens < 800);
  assert.equal(packet.evidenceCount, 2);
  assert.equal(packet.toolsCount, 2);
});

test('buildSynthesisPacket includes tool observations', () => {
  const packet = buildSynthesisPacket({
    question: 'Compare ProjectHub and Voice Ops',
    conversationState: freshState(),
    evidence: [],
    toolObservations: [{ tool: 'compare_projects', result: { projects: [{ name: 'ProjectHub' }, { name: 'Voice Ops' }] } }],
    rules: null
  });
  assert.ok(packet.systemPrompt.includes('TOOL_OBSERVATIONS'));
  assert.ok(packet.systemPrompt.includes('compare_projects'));
});

test('buildRawPacket is minimal for raw comparison', () => {
  const packet = buildRawPacket({ question: 'What did Bradley do with AWS?', agentName: 'Scout' });
  assert.ok(!packet.systemPrompt.includes('VERIFIED_EVIDENCE'));
  assert.equal(packet.evidenceCount, 0);
  assert.ok(packet.estimatedTokens < 50);
});

test('renderEvidenceList deduplicates', () => {
  const items = [
    { kind: 'project', name: 'ProjectHub', description: 'A chat widget' },
    { kind: 'project', name: 'ProjectHub', description: 'A chat widget' },
    { kind: 'certification', name: 'AWS Certified' }
  ];
  const rendered = renderEvidenceList(items, 5, 200);
  assert.equal(rendered.length, 2);
});

test('estimateTokens is roughly chars/4', () => {
  assert.equal(estimateTokens('hello world!'), 3);
});

// Session state
test('freshState returns empty state', () => {
  const state = freshState();
  assert.equal(state.currentTopic, null);
  assert.deepEqual(state.currentProjects, []);
  assert.equal(state.recentTurns.length, 0);
});

test('updateState detects topic and projects', () => {
  const knowledge = { projects: [{ name: 'ProjectHub' }, { name: 'Voice Ops Platform' }] };
  clearState('test-session-1');
  const state = updateState('test-session-1', 'Tell me about ProjectHub and AWS.', 'Bradley built ProjectHub.', knowledge, 'project_query');
  assert.equal(state.currentTopic, 'aws'); // aws hint matches first
  assert.ok(state.currentProjects.includes('ProjectHub'));
  assert.equal(state.recentTurns.length, 1);
});

test('updateState detects job description', () => {
  clearState('test-session-job');
  const longJob = 'We are hiring a junior developer. Requirements: JavaScript, React, Node.js. Responsibilities include building web applications. Must have a bachelor degree. Nice to have AWS certification.';
  const state = updateState('test-session-job', longJob, 'Here is a fit analysis.', {}, 'job_fit');
  assert.ok(state.currentJob);
  assert.ok(state.currentJob.length > 50);
});

test('updateState detects unresolved reference', () => {
  clearState('test-session-ref');
  const state = updateState('test-session-ref', 'What about the backend?', 'The backend uses Node.', {}, null);
  assert.ok(state.unresolvedReference);
});

test('resolveReferents returns current projects', () => {
  clearState('test-session-resolve');
  updateState('test-session-resolve', 'Tell me about ProjectHub', 'Bradley built ProjectHub.', { projects: [{ name: 'ProjectHub' }] }, null);
  const state = getState('test-session-resolve');
  const refs = resolveReferents(state);
  assert.ok(refs.projects.includes('ProjectHub'));
});

test('detectTopic matches aws', () => {
  assert.equal(detectTopic('What about AWS Lambda?'), 'aws');
  assert.equal(detectTopic('hello there'), null);
});

test('detectProjects finds named projects', () => {
  const knowledge = { projects: [{ name: 'ProjectHub' }, { name: 'Pokedex' }] };
  assert.deepEqual(detectProjects('Tell me about ProjectHub', knowledge), ['ProjectHub']);
  assert.deepEqual(detectProjects('What projects does he have?', knowledge), []);
});

// Agent engine helpers
test('parseDecision parses valid JSON', () => {
  const parsed = parseDecision('{"action":"answer","answer":"yes"}');
  assert.equal(parsed.action, 'answer');
});

test('parseDecision repairs markdown-fenced JSON', () => {
  const parsed = parseDecision('```json\n{"action":"tool","tool":"get_project","arguments":{}}\n```');
  assert.equal(parsed.tool, 'get_project');
});

test('parseDecision returns null for prose', () => {
  assert.equal(parseDecision('I think Bradley knows AWS.'), null);
});

test('clampArgs truncates long strings', () => {
  const longStr = 'a'.repeat(1000);
  const clamped = clampArgs({ query: longStr });
  assert.ok(clamped.query.length <= 500);
});

test('clampObservation truncates large results', () => {
  const large = { data: 'x'.repeat(2000) };
  const clamped = clampObservation(large);
  assert.ok(clamped.truncated);
});

test('allToolNames returns the five tools', () => {
  const names = allToolNames();
  assert.ok(names.includes('search_portfolio'));
  assert.ok(names.includes('get_project'));
  assert.ok(names.includes('compare_projects'));
  assert.ok(names.includes('match_role'));
  assert.ok(names.includes('get_candidate_profile'));
});

// Local model router
test('router defaultModel is qwen2.5:0.5b', () => {
  assert.equal(router.defaultModel(), 'qwen2.5:0.5b');
});

test('router modelInfo returns pinned metadata', () => {
  const info = router.modelInfo('qwen2.5:0.5b');
  assert.ok(info);
  assert.equal(info.parameterSize, '0.5B');
  assert.ok(info.license.includes('Apache'));
});

test('router listPinnedModels includes qwen2.5:0.5b', () => {
  const models = router.listPinnedModels();
  assert.ok(models.some(m => m.name === 'qwen2.5:0.5b'));
});
