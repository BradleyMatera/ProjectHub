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
  assert.ok(packet.systemPrompt.includes('TOOL_RESULTS'));
  assert.ok(packet.systemPrompt.includes('compare_projects'));
});

test('buildRawPacket is minimal for raw comparison', () => {
  const packet = buildRawPacket({ question: 'What did Bradley do with AWS?', agentName: 'Scout' });
  assert.ok(!packet.systemPrompt.includes('VERIFIED_EVIDENCE'));
  assert.equal(packet.evidenceCount, 0);
  assert.ok(packet.estimatedTokens < 80);
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

test('allToolNames returns the seven tools', () => {
  const names = allToolNames();
  assert.ok(names.includes('search_portfolio'));
  assert.ok(names.includes('get_project'));
  assert.ok(names.includes('compare_projects'));
  assert.ok(names.includes('match_role'));
  assert.ok(names.includes('get_candidate_profile'));
  assert.ok(names.includes('get_skill_evidence'));
  assert.ok(names.includes('build_recruiter_brief'));
  assert.strictEqual(names.length, 7);
});

// New tools
const { executeAgentTool } = require('../lib/agent-tools');
const fs = require('fs');
const path = require('path');
const KNOWLEDGE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'recruiter-knowledge.json'), 'utf8'));

test('get_skill_evidence finds AWS evidence', () => {
  const result = executeAgentTool('get_skill_evidence', { skill: 'AWS' }, KNOWLEDGE);
  assert.ok(result.evidence !== 'unknown');
  assert.ok(result.details.length > 0);
  assert.ok(result.details.some(d => d.type === 'direct' || d.type === 'project' || d.type === 'certification'));
});

test('get_skill_evidence returns unknown for unsupported skill', () => {
  const result = executeAgentTool('get_skill_evidence', { skill: 'Kubernetes' }, KNOWLEDGE);
  assert.equal(result.evidence, 'unknown');
});

test('get_skill_evidence finds React evidence', () => {
  const result = executeAgentTool('get_skill_evidence', { skill: 'React' }, KNOWLEDGE);
  assert.ok(result.evidence !== 'unknown');
  assert.ok(result.details.length > 0);
});

test('build_recruiter_brief returns structured brief', () => {
  const result = executeAgentTool('build_recruiter_brief', {}, KNOWLEDGE);
  assert.ok(result.candidateName);
  assert.ok(Array.isArray(result.topProjects));
  assert.ok(Array.isArray(result.topSkills));
  assert.ok(result.assessmentRule);
});

test('build_recruiter_brief with focus filters projects', () => {
  const result = executeAgentTool('build_recruiter_brief', { focus: 'AWS' }, KNOWLEDGE);
  assert.ok(result.focus === 'aws');
});

test('unknown tool fails closed', () => {
  const result = executeAgentTool('hack_the_mainframe', {}, KNOWLEDGE);
  assert.ok(result.error);
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

// === Relationship-aware grounding tests ===

const { buildRelationshipGraph, checkRelationship, getProjectTech, getTechProjects } = require('../lib/relationship-graph');
const { extractClaims, cleanEntityName } = require('../lib/claim-extractor');
const { validateRelationships, detectExpandedOverclaim, detectFabricatedEntities } = require('../lib/relationship-validator');

const KNOWLEDGE_PATH = require('path').join(__dirname, '..', 'data', 'recruiter-knowledge.json');
const testKnowledge = JSON.parse(require('fs').readFileSync(KNOWLEDGE_PATH, 'utf8'));
const testGraph = buildRelationshipGraph(testKnowledge);

test('relationship graph builds triples from knowledge', () => {
  assert.ok(testGraph.triples.length > 100, `Expected 100+ triples, got ${testGraph.triples.length}`);
  assert.ok(testGraph.entityIndex.size > 50, `Expected 50+ entities, got ${testGraph.entityIndex.size}`);
});

test('relationship graph maps project to its technologies correctly', () => {
  const pokedexTech = getProjectTech(testGraph, 'Interactive Pokedex');
  assert.ok(pokedexTech.includes('JavaScript'));
  assert.ok(pokedexTech.includes('HTML'));
  assert.ok(pokedexTech.includes('CSS'));
  assert.ok(!pokedexTech.includes('React'), 'Pokedex should NOT use React');
  assert.ok(!pokedexTech.includes('WebGPU'), 'Pokedex should NOT use WebGPU');
  assert.ok(!pokedexTech.includes('Node.js'), 'Pokedex should NOT use Node.js');
});

test('relationship graph maps technology to projects correctly', () => {
  const dynamoProjects = getTechProjects(testGraph, 'DynamoDB');
  assert.ok(dynamoProjects.some(p => p.includes('Metadata Extraction')), 'DynamoDB should be in AWS capstone');
  assert.ok(!dynamoProjects.some(p => p.includes('Pokedex')), 'DynamoDB should NOT be in Pokedex');
  assert.ok(!dynamoProjects.some(p => p.includes('ProjectHub')), 'DynamoDB should NOT be in ProjectHub');
});

test('checkRelationship rejects false project-tech association', () => {
  // "AWS capstone used React" — both entities exist, but the relationship is FALSE
  const result = checkRelationship(testGraph, 'AWS capstone', 'uses_tech', 'React');
  assert.equal(result.supported, false);
  assert.ok(result.reason.includes('NOT with'), `Reason should explain what IS supported: ${result.reason}`);
});

test('checkRelationship accepts true project-tech association', () => {
  // "AWS capstone used DynamoDB" — this IS supported
  const result = checkRelationship(testGraph, 'AWS capstone', 'uses_tech', 'DynamoDB');
  assert.equal(result.supported, true);
});

test('checkRelationship rejects false project-employment association', () => {
  // "ProjectHub was built at Amazon" — both exist, relationship is FALSE
  const result = checkRelationship(testGraph, 'ProjectHub', 'built_during', 'Amazon');
  assert.equal(result.supported, false);
});

test('checkRelationship accepts true employment association', () => {
  // "Bradley interned at AWS" — this IS supported
  const result = checkRelationship(testGraph, 'Bradley Matera', 'interned_at', 'Amazon Web Services (AWS)');
  assert.equal(result.supported, true);
});

test('claim extractor extracts uses_tech claims', () => {
  const claims = extractClaims('His AWS internship capstone used Node.js as part of a serverless backend.', testGraph);
  assert.ok(claims.length > 0, 'Should extract at least one claim');
  assert.ok(claims.some(c => c.relation === 'uses_tech'), 'Should extract uses_tech claim');
});

test('claim extractor handles periods in tech names (Node.js)', () => {
  const claims = extractClaims('His AWS internship capstone used Node.js as part of a serverless backend.', testGraph);
  assert.ok(claims.length > 0, 'Should extract claims despite Node.js period');
  const usesTechClaims = claims.filter(c => c.relation === 'uses_tech');
  assert.ok(usesTechClaims.some(c => c.object && c.object.includes('Node.js')), 'Should capture Node.js as object');
});

test('claim extractor marks interpretations correctly', () => {
  const claims = extractClaims('ProjectHub is probably his strongest AI project.', testGraph);
  assert.ok(claims.some(c => c.type === 'INTERPRETATION'), 'Should mark as interpretation');
});

test('claim extractor marks negations correctly', () => {
  const claims = extractClaims('No. He was an intern, not senior.', testGraph);
  assert.ok(claims.some(c => c.type === 'NEGATION'), 'Should mark as negation');
});

test('cleanEntityName strips leading pronouns and stop words', () => {
  assert.equal(cleanEntityName('His AWS internship capstone'), 'AWS internship capstone');
  assert.equal(cleanEntityName('Node.js as part of a serverless'), 'Node.js');
  assert.equal(cleanEntityName('React for a web application'), 'React');
  assert.equal(cleanEntityName('Amazon.'), 'Amazon');
});

test('validateRelationships rejects false project-tech claim', () => {
  const result = validateRelationships(
    'His AWS internship capstone used Node.js as part of a serverless backend.',
    testGraph
  );
  assert.equal(result.valid, false);
  assert.ok(result.unsupportedClaims.length > 0, 'Should flag unsupported relationship');
});

test('validateRelationships accepts true project-tech claim', () => {
  const result = validateRelationships(
    'His AWS internship capstone used DynamoDB as part of a serverless metadata workflow.',
    testGraph
  );
  assert.equal(result.valid, true);
  assert.equal(result.unsupportedClaims.length, 0);
});

test('validateRelationships flags overclaim expertise language', () => {
  const result = validateRelationships(
    'He has expertise in AWS services such as AWS Lambda and DynamoDB.',
    testGraph
  );
  assert.equal(result.valid, false);
  assert.ok(result.overclaimClaims.length > 0, 'Should flag expertise as overclaim');
});

test('validateRelationships flags extensive experience language', () => {
  const result = validateRelationships(
    'He has extensive experience in front-end web development.',
    testGraph
  );
  assert.equal(result.valid, false);
  assert.ok(result.overclaimClaims.length > 0, 'Should flag extensive experience as overclaim');
});

test('validateRelationships allows interpretations', () => {
  const result = validateRelationships(
    'ProjectHub is probably his strongest AI project.',
    testGraph
  );
  assert.equal(result.valid, true);
});

test('validateRelationships allows negations', () => {
  const result = validateRelationships(
    'No. He was an intern, not senior.',
    testGraph
  );
  assert.equal(result.valid, true);
});

test('detectExpandedOverclaim catches extensive experience', () => {
  const matches = detectExpandedOverclaim('He has extensive experience in web development.');
  assert.ok(matches.includes('extensive experience'));
});

test('detectExpandedOverclaim catches expertise in', () => {
  const matches = detectExpandedOverclaim('He has expertise in AWS services.');
  assert.ok(matches.some(m => m.includes('expertise')));
});

test('detectExpandedOverclaim catches specializing in', () => {
  const matches = detectExpandedOverclaim('He is specializing in front-end development.');
  assert.ok(matches.some(m => m.includes('specializing')));
});

test('detectFabricatedEntities catches Vue.js', () => {
  const fabricated = detectFabricatedEntities(
    'He would succeed using frameworks like React or Vue.js.',
    testGraph
  );
  assert.ok(fabricated.includes('Vue.js'), `Should detect Vue.js as fabricated, got: ${fabricated.join(', ')}`);
});

test('detectFabricatedEntities does not flag known entities', () => {
  const fabricated = detectFabricatedEntities(
    'He uses JavaScript, React, and AWS Lambda.',
    testGraph
  );
  // React, JavaScript, AWS Lambda are all in the knowledge base
  assert.ok(!fabricated.includes('React'), 'React should not be fabricated');
  assert.ok(!fabricated.includes('JavaScript'), 'JavaScript should not be fabricated');
});

test('validateAnswer with knowledge rejects false project-tech relationship', () => {
  const source = 'AWS capstone uses AWS Lambda, DynamoDB, S3, AWS Amplify. Node.js is in his skills.';
  const result = validateAnswer(
    'His AWS internship capstone used Node.js as part of a serverless backend.',
    source,
    'What about Node.js?',
    testKnowledge
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.startsWith('unsupported_relationship:')), `Should flag unsupported relationship, got: ${result.reasons.join(', ')}`);
});

test('validateAnswer with knowledge rejects expanded overclaim', () => {
  const source = 'Bradley has experience with AWS Lambda and DynamoDB from his internship.';
  const result = validateAnswer(
    'He has extensive experience in AWS services such as Lambda and DynamoDB.',
    source,
    'Does he know AWS?',
    testKnowledge
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.startsWith('expanded_overclaim:')), `Should flag expanded overclaim, got: ${result.reasons.join(', ')}`);
});

test('validateAnswer with knowledge accepts true grounded answer', () => {
  const source = 'AWS capstone uses AWS Lambda, DynamoDB, S3, AWS Amplify.';
  const result = validateAnswer(
    'His AWS internship capstone used DynamoDB as part of a serverless metadata workflow.',
    source,
    'Does he know DynamoDB?',
    testKnowledge
  );
  assert.equal(result.valid, true, `Should accept true answer, got reasons: ${result.reasons.join(', ')}`);
});

test('validateAnswer with knowledge rejects fabricated entity', () => {
  const source = 'Bradley uses JavaScript, React, and AWS Lambda.';
  const result = validateAnswer(
    'He would succeed using frameworks like React or Vue.js in front-end development.',
    source,
    'What role fits him?',
    testKnowledge
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.startsWith('fabricated_entity:')), `Should flag fabricated entity, got: ${result.reasons.join(', ')}`);
});

// === Synthetic domain tests (productization) ===

test('relationship graph works for tire shop domain', () => {
  const tireShopKnowledge = {
    identity: { name: 'Tire Shop Assistant' },
    projects: [
      { name: 'Michelin Defender', tech: ['rubber compound', 'tread pattern'], category: 'tire', aliases: ['Michelin Defender T+H'] },
      { name: 'Goodyear Assurance', tech: ['rubber compound', 'water channel'], category: 'tire', aliases: ['Goodyear Assurance WeatherReady'] }
    ],
    experience: [],
    skills: { tires: ['Michelin Defender', 'Goodyear Assurance'] },
    certifications: []
  };
  const graph = buildRelationshipGraph(tireShopKnowledge);
  // Michelin Defender uses rubber compound — supported
  assert.equal(checkRelationship(graph, 'Michelin Defender', 'uses_tech', 'rubber compound').supported, true);
  // Goodyear Assurance uses water channel — supported
  assert.equal(checkRelationship(graph, 'Goodyear Assurance', 'uses_tech', 'water channel').supported, true);
  // Michelin Defender uses water channel — NOT supported (belongs to Goodyear)
  const crossResult = checkRelationship(graph, 'Michelin Defender', 'uses_tech', 'water channel');
  assert.equal(crossResult.supported, false, 'Should NOT transfer Goodyear tech to Michelin');
});

test('relationship graph works for SaaS plan domain', () => {
  const saasKnowledge = {
    identity: { name: 'SaaS Assistant' },
    projects: [
      { name: 'Basic Plan', tech: ['5 users max', 'email support'], category: 'subscription plan' },
      { name: 'Pro Plan', tech: ['50 users max', 'priority support'], category: 'subscription plan' }
    ],
    experience: [],
    skills: {},
    certifications: []
  };
  const graph = buildRelationshipGraph(saasKnowledge);
  // Basic Plan has 5 users max — supported
  assert.equal(checkRelationship(graph, 'Basic Plan', 'uses_tech', '5 users max').supported, true);
  // Pro Plan has 50 users max — supported
  assert.equal(checkRelationship(graph, 'Pro Plan', 'uses_tech', '50 users max').supported, true);
  // Basic Plan has 50 users max — NOT supported (belongs to Pro Plan)
  const crossResult = checkRelationship(graph, 'Basic Plan', 'uses_tech', '50 users max');
  assert.equal(crossResult.supported, false, 'Should NOT transfer Pro Plan limit to Basic Plan');
});

test('relationship graph works for restaurant allergen domain', () => {
  const restaurantKnowledge = {
    identity: { name: 'Restaurant Assistant' },
    projects: [
      { name: 'Burger A', tech: ['beef', 'bun', 'no peanuts'], category: 'food item' },
      { name: 'Dessert B', tech: ['chocolate', 'peanuts'], category: 'food item' }
    ],
    experience: [],
    skills: {},
    certifications: []
  };
  const graph = buildRelationshipGraph(restaurantKnowledge);
  // Burger A has no peanuts — supported
  assert.equal(checkRelationship(graph, 'Burger A', 'uses_tech', 'no peanuts').supported, true);
  // Dessert B has peanuts — supported
  assert.equal(checkRelationship(graph, 'Dessert B', 'uses_tech', 'peanuts').supported, true);
  // Burger A has peanuts — NOT supported (allergen belongs to Dessert B)
  const crossResult = checkRelationship(graph, 'Burger A', 'uses_tech', 'peanuts');
  assert.equal(crossResult.supported, false, 'Should NOT transfer peanut allergen from Dessert B to Burger A');
});

// === Regression tests for false positive fixes ===

test('extractCompleteSentences does not truncate at Node.js period', () => {
  const input = 'No, he is not an expert in React. His skills include JavaScript, Node.js, and Express, but React is listed as part of his skill set.';
  const result = extractCompleteSentences(input, 2);
  // The bug was: "His skills include JavaScript, Node." became "js, and Express..."
  // The fix: sentence splitter only splits on . ! ? followed by space + capital letter
  assert.ok(result.includes('Node.js'), 'Should preserve Node.js in output');
  assert.ok(!result.startsWith('js,'), 'Should NOT start with "js," (truncation bug)');
  assert.ok(result.includes('His skills include'), 'Should preserve second sentence');
});

test('extractCompleteSentences preserves multi-sentence answers with tech names', () => {
  const input = 'ProjectHub uses JavaScript, Node.js, and Express for its backend. It also uses GitHub Pages for hosting.';
  const result = extractCompleteSentences(input, 2);
  assert.ok(result.includes('Node.js'), 'Should preserve Node.js');
  assert.ok(result.includes('Express'), 'Should preserve Express');
  assert.ok(result.includes('GitHub Pages'), 'Should preserve second sentence');
});

test('cleanEntityName strips possessive and rejects non-entity phrases', () => {
  const { cleanEntityName } = require('../lib/claim-extractor');
  // Possessive stripping
  assert.equal(cleanEntityName("ProjectHub's"), 'ProjectHub');
  assert.equal(cleanEntityName("Scout's"), 'Scout');
  // Non-entity rejection
  assert.equal(cleanEntityName('that focused'), null);
  assert.equal(cleanEntityName('tech stack'), null);
  assert.equal(cleanEntityName('backend'), null);
  assert.equal(cleanEntityName('project'), null);
});

test('claim extractor does not false-positive on education context', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const knowledge = require('../data/recruiter-knowledge.json');
  const graph = buildRelationshipGraph(knowledge);

  // "Scout's education includes a Bachelor of Science..." should NOT produce a uses_tech claim
  const claims = extractClaims(
    "Scout's education includes a Bachelor of Science in Web Development from Full Sail University, with a GPA of 3.64.",
    graph,
    "What is his education?"
  );
  const usesTechClaims = claims.filter(c => c.relation === 'uses_tech');
  assert.equal(usesTechClaims.length, 0, 'Education context should NOT produce uses_tech claims');
});

test('claim extractor does not false-positive on "that focused" pattern', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const knowledge = require('../data/recruiter-knowledge.json');
  const graph = buildRelationshipGraph(knowledge);

  const claims = extractClaims(
    'Bradley Matera was involved in an AWS internship capstone project that focused on extracting metadata using a serverless pipeline.',
    graph,
    'What did Bradley actually do at AWS?'
  );
  // "that focused" should NOT be extracted as a subject
  const badClaims = claims.filter(c => c.subject && /that focused/i.test(c.subject));
  assert.equal(badClaims.length, 0, '"that focused" should NOT be extracted as entity');
});

test('claim extractor does not false-positive on "tech stack includes" pattern', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const knowledge = require('../data/recruiter-knowledge.json');
  const graph = buildRelationshipGraph(knowledge);

  const claims = extractClaims(
    'CIRIS Ethical AI has a tech stack that includes JavaScript, Docker Compose, GitHub, and JWT.',
    graph,
    'Tell me about CIRIS Ethical AI.'
  );
  // "tech stack" should NOT be extracted as a subject
  const badClaims = claims.filter(c => c.subject && /tech stack/i.test(c.subject));
  assert.equal(badClaims.length, 0, '"tech stack" should NOT be extracted as entity');
});

test('validator accepts short adversarial refutation with negation', () => {
  const { validateAnswer } = require('../lib/grounding-validator');
  const knowledge = require('../data/recruiter-knowledge.json');
  const source = 'Bradley was a Cloud Support Engineer Intern at AWS. He was an intern, not a senior engineer. He did not handle production incidents.';
  // "No. He was an intern, not senior." was being rejected for insufficient_content_overlap
  const result = validateAnswer(
    'No. He was an intern, not senior.',
    source,
    'He handled production AWS incidents, correct?',
    knowledge
  );
  assert.equal(result.valid, true, 'Short negation refutation should be accepted');
});

test('validator does not flag GPA as fabricated entity', () => {
  const { validateAnswer } = require('../lib/grounding-validator');
  const knowledge = require('../data/recruiter-knowledge.json');
  const source = 'Bradley has a Bachelor of Science in Web Development from Full Sail University. GPA 3.64. Graduated October 2025.';
  const result = validateAnswer(
    "Bradley's education includes a Bachelor of Science in Web Development from Full Sail University, with a GPA of 3.64.",
    source,
    'What is his education?',
    knowledge
  );
  assert.ok(!result.reasons.some(r => r.includes('GPA')), 'GPA should NOT be flagged as fabricated');
});

test('relationship graph indexes education properties (GPA, location)', () => {
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const knowledge = require('../data/recruiter-knowledge.json');
  const graph = buildRelationshipGraph(knowledge);
  // GPA should now be in the entity index
  const hasGpa = graph.entityIndex.has('gpa') ||
    Array.from(graph.entityIndex.keys()).some(k => k.includes('gpa'));
  assert.ok(hasGpa, 'GPA should be in entity index');
});

// === Overclaim negation regression tests ===

test('overclaim in "No, he has extensive experience" is REJECTED', () => {
  const { validateAnswer } = require('../lib/grounding-validator');
  const knowledge = require('../data/recruiter-knowledge.json');
  const source = 'Bradley worked on AWS projects. He was an intern.';
  const result = validateAnswer(
    'No, he has extensive experience with AWS projects.',
    source,
    'He architected the AWS infrastructure, correct?',
    knowledge
  );
  assert.equal(result.valid, false, 'Should reject "extensive experience" even after "No"');
  assert.ok(result.reasons.some(r => r.startsWith('expanded_overclaim:')), 'Should flag overclaim');
});

test('overclaim in "not an expert in" is ACCEPTED (negation)', () => {
  const { validateAnswer } = require('../lib/grounding-validator');
  const knowledge = require('../data/recruiter-knowledge.json');
  const source = 'Bradley has skills in JavaScript, React, Node.js. He is entry-level.';
  const result = validateAnswer(
    'No, he is not an expert in React.',
    source,
    'He is a React expert, right?',
    knowledge
  );
  assert.equal(result.valid, true, 'Negated overclaim "not an expert" should be accepted');
});

test('overclaim in positive context is REJECTED', () => {
  const { validateAnswer } = require('../lib/grounding-validator');
  const knowledge = require('../data/recruiter-knowledge.json');
  const source = 'Bradley has skills in JavaScript, React, Node.js. He is entry-level.';
  const result = validateAnswer(
    'He has extensive experience with JavaScript and React.',
    source,
    'What are his skills?',
    knowledge
  );
  assert.equal(result.valid, false, 'Positive "extensive experience" should be rejected');
  assert.ok(result.reasons.some(r => r.startsWith('expanded_overclaim:')), 'Should flag overclaim');
});

test('has_experience maps to worked_at for valid experience claims', () => {
  const { validateAnswer } = require('../lib/grounding-validator');
  const knowledge = require('../data/recruiter-knowledge.json');
  const source = 'Bradley was a Cloud Support Engineer Intern at Amazon Web Services (AWS). He worked on serverless projects.';
  const result = validateAnswer(
    'Bradley Matera has experience in cloud support engineering at Amazon Web Services (AWS) as a Cloud Support Engineer Intern.',
    source,
    'Give me the quick recruiter version.',
    knowledge
  );
  // has_experience in "cloud support engineering" should map to worked_at/interned_at
  assert.ok(!result.reasons.some(r => r.startsWith('unsupported_relationship:')), 'has_experience should map to worked_at');
});

// === Negated invented entity regression tests ===

test('negated invented entity "did not work at Microsoft" is ACCEPTED', () => {
  const { validateAnswer } = require('../lib/grounding-validator');
  const knowledge = require('../data/recruiter-knowledge.json');
  const source = 'Bradley worked at Amazon Web Services (AWS), CIRIS Ethical AI, and the United States Army.';
  const result = validateAnswer(
    'No, he did not work at Microsoft.',
    source,
    'Tell me about his time at Microsoft.',
    knowledge
  );
  assert.equal(result.valid, true, 'Negated invented entity should be accepted as a valid refutation');
  assert.ok(!result.reasons.some(r => r.startsWith('entity_not_grounded:')), 'Should not flag negated entity as ungrounded');
  assert.ok(!result.reasons.some(r => r.startsWith('fabricated_entity:')), 'Should not flag negated entity as fabricated');
});

test('affirmative invented entity "he worked at Google" is REJECTED', () => {
  const { validateAnswer } = require('../lib/grounding-validator');
  const knowledge = require('../data/recruiter-knowledge.json');
  const source = 'Bradley worked at Amazon Web Services (AWS), CIRIS Ethical AI, and the United States Army.';
  const result = validateAnswer(
    'Yes, he worked at Google.',
    source,
    'He worked at Google, right?',
    knowledge
  );
  assert.equal(result.valid, false, 'Affirmative invented entity should be rejected');
});

test('claim extractor does not parse "is an AI assistant that" as subject', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const knowledge = require('../data/recruiter-knowledge.json');
  const graph = buildRelationshipGraph(knowledge);
  const claims = extractClaims(
    'ProjectHub is an AI recruiter assistant that uses JavaScript, Node.js, and Express.',
    graph,
    'Tell me about ProjectHub.'
  );
  const badSubject = claims.find(c => c.subject && /is an AI/i.test(c.subject));
  assert.ok(!badSubject, 'Should not extract "is an AI recruiter assistant that" as subject');
});

test('claim extractor does not parse "includes working" as subject', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const knowledge = require('../data/recruiter-knowledge.json');
  const graph = buildRelationshipGraph(knowledge);
  const claims = extractClaims(
    'His experience includes working on projects that use React and JavaScript.',
    graph,
    'What does he actually do?'
  );
  const badSubject = claims.find(c => c.subject && /includes working/i.test(c.subject));
  assert.ok(!badSubject, 'Should not extract "includes working" as subject');
});

// === Completeness check tests ===

test('completeness check classifies yes/no intent correctly', () => {
  const { classifyIntent } = require('../lib/completeness-check');
  assert.equal(classifyIntent('Does he know React?'), 'SKILL');
  assert.equal(classifyIntent('Is he a senior engineer?'), 'YES_NO');
  assert.equal(classifyIntent('Compare ProjectHub and Voice Ops.'), 'COMPARISON');
  assert.equal(classifyIntent('How does he fit a junior developer role?'), 'JOB_FIT');
  assert.equal(classifyIntent('Give me the quick recruiter version.'), 'RECRUITER');
  assert.equal(classifyIntent('He was a senior AWS engineer, right?'), 'ADVERSARIAL');
  assert.equal(classifyIntent('Tell me about ProjectHub.'), 'PROJECT');
  assert.equal(classifyIntent('What about the backend?'), 'FOLLOW_UP');
});

test('completeness check detects terse yes/no answer', () => {
  const { evaluateCompleteness } = require('../lib/completeness-check');
  const result = evaluateCompleteness('Yes.', 'Does he know React?', []);
  assert.equal(result.complete, false);
  // "Yes." is < 3 words so it hits the generic TOO_SHORT check
  assert.ok(result.reason === 'TOO_SHORT' || result.reason === 'YES_NO_TOO_TERSE');
});

test('completeness check accepts good yes/no answer', () => {
  const { evaluateCompleteness } = require('../lib/completeness-check');
  const result = evaluateCompleteness(
    'Yes. React is part of his verified skill set and appears in his web development work.',
    'Does he know React?',
    [{ description: 'React is in his skills alongside JavaScript and TypeScript' }]
  );
  assert.equal(result.complete, true);
});

test('completeness check detects generic filler', () => {
  const { evaluateCompleteness } = require('../lib/completeness-check');
  const result = evaluateCompleteness(
    'Based on the information provided, I would need more context to answer.',
    'Tell me about ProjectHub.',
    []
  );
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'GENERIC_FILLER');
});

test('completeness check detects question repetition', () => {
  const { evaluateCompleteness } = require('../lib/completeness-check');
  const result = evaluateCompleteness(
    'ProjectHub is a project.',
    'Tell me about ProjectHub.',
    []
  );
  assert.equal(result.complete, false);
});

test('completeness check detects adversarial without refutation', () => {
  const { evaluateCompleteness } = require('../lib/completeness-check');
  const result = evaluateCompleteness(
    'Yes, he has 10 years of React experience.',
    'He has 10 years of React experience, right?',
    []
  );
  assert.equal(result.complete, false);
  // May be caught by question repetition or adversarial no refutation
  assert.ok(result.reason === 'ADVERSARIAL_NO_REFUTATION' || result.reason === 'QUESTION_REPETITION');
});

// === Response planner tests ===

test('response planner produces a plan for skill questions', () => {
  const { planResponse } = require('../lib/response-planner');
  const knowledge = require('../data/recruiter-knowledge.json');
  const plan = planResponse('Does he know DynamoDB?', knowledge, [
    { name: 'AWS Capstone', description: 'Serverless metadata extraction using Lambda, DynamoDB, and S3.' }
  ], { subjectName: 'Bradley Matera' });
  assert.equal(plan.intent, 'SKILL');
  assert.equal(plan.directAnswer, 'yes');
  assert.ok(plan.entities.includes('DynamoDB'));
  assert.ok(plan.evidenceStrength['DynamoDB']);
  assert.ok(plan.evidenceStrength['DynamoDB'] === 'DIRECT' || plan.evidenceStrength['DynamoDB'] === 'PROJECT_AND_SKILL');
});

test('response planner produces a plan for adversarial questions', () => {
  const { planResponse } = require('../lib/response-planner');
  const knowledge = require('../data/recruiter-knowledge.json');
  const plan = planResponse('He worked at Google, right?', knowledge, [], { subjectName: 'Bradley Matera' });
  assert.equal(plan.intent, 'ADVERSARIAL');
  assert.equal(plan.directAnswer, 'no');
  assert.ok(plan.caveats.some(c => c.includes('claim')));
});

test('response planner produces a plan for job-fit questions', () => {
  const { planResponse } = require('../lib/response-planner');
  const knowledge = require('../data/recruiter-knowledge.json');
  const plan = planResponse('How does he fit a junior frontend developer role requiring React and TypeScript?', knowledge, [], { subjectName: 'Bradley Matera' });
  assert.equal(plan.intent, 'JOB_FIT');
  assert.ok(plan.jobFit);
  assert.ok(plan.jobFit.fitLevel);
  assert.ok(plan.jobFit.strong.length > 0 || plan.jobFit.adjacent.length > 0);
});

test('response planner produces a plan for comparison questions', () => {
  const { planResponse } = require('../lib/response-planner');
  const knowledge = require('../data/recruiter-knowledge.json');
  const plan = planResponse('Compare ProjectHub and Voice Ops.', knowledge, [
    { name: 'ProjectHub', description: 'ProjectHub uses JavaScript, Node.js, Express.' },
    { name: 'Voice Ops', description: 'Voice Ops uses JavaScript, Node.js, Express.' }
  ], { subjectName: 'Bradley Matera' });
  assert.equal(plan.intent, 'COMPARISON');
  assert.ok(plan.comparisonDimensions.length > 0);
});

test('response planner formatPlanForPrompt produces compact text', () => {
  const { planResponse, formatPlanForPrompt } = require('../lib/response-planner');
  const knowledge = require('../data/recruiter-knowledge.json');
  const plan = planResponse('Does he know DynamoDB?', knowledge, [], { subjectName: 'Bradley Matera' });
  const text = formatPlanForPrompt(plan);
  assert.ok(text.includes('INTENT:'));
  assert.ok(text.includes('DIRECT_ANSWER:'));
  assert.ok(text.includes('ALLOWED_ENTITIES:'));
});

test('response planner is domain-neutral (no hardcoded entity names)', () => {
  // The planner should not contain hardcoded entity names like "Bradley", "ProjectHub", etc.
  const fs = require('fs');
  const source = fs.readFileSync(require('path').join(__dirname, '..', 'lib', 'response-planner.js'), 'utf8');
  // Check that no hardcoded entity names appear in the planner logic
  // (they may appear in comments/docs but not in actual string literals used for matching)
  assert.ok(!/['"]Bradley['"]/.test(source), 'Should not hardcode "Bradley"');
  assert.ok(!/['"]ProjectHub['"]/.test(source), 'Should not hardcode "ProjectHub"');
  assert.ok(!/['"]DynamoDB['"]/.test(source), 'Should not hardcode "DynamoDB"');
  assert.ok(!/['"]AWS['"]/.test(source), 'Should not hardcode "AWS"');
});

test('adversarial confirmation "Yes, he handled production..." is blocked', () => {
  // The FORBIDDEN_CLAIM_PATTERNS should catch "production" in a confirming answer
  const FORBIDDEN_CLAIM_PATTERNS = [
    { re: /\bproduction\b/i, except: /\b(not|never|no|wasn't|was not|internship|capstone|training)\b/i },
  ];
  const answer = 'Yes, he was responsible for handling and resolving production AWS incidents.';
  let caught = false;
  for (const p of FORBIDDEN_CLAIM_PATTERNS) {
    if (p.re.test(answer) && !p.except.test(answer)) {
      caught = true;
      break;
    }
  }
  assert.ok(caught, 'Should detect "production" as forbidden claim in confirming answer');
});

test('adversarial confirmation detection catches "Yes" without negation', () => {
  // Simulate the adversarial confirmation check
  const answer1 = 'Yes, he was responsible for handling and resolving production AWS incidents.';
  const answer2 = 'No, he was an intern, not senior.';
  const answer3 = 'Yes, that is correct, he was an intern.';
  const answer4 = 'Correct, he was an intern, not senior.';

  const checkConfirm = (a) => /^(?:yes|correct|right|true|absolutely|indeed)\b/i.test(a) &&
    !/\b(?:no|not|never|incorrect|wrong|false|didn't|did not|wasn't|was not|isn't|is not)\b/i.test(a);

  assert.ok(checkConfirm(answer1), 'Should catch "Yes" confirmation without negation');
  assert.ok(!checkConfirm(answer2), 'Should not catch "No" answer');
  assert.ok(checkConfirm(answer3), 'Should catch "Yes, that is correct" without negation');
  assert.ok(!checkConfirm(answer4), 'Should not catch "Correct, he was an intern, not senior"');
});

// === Truth Audit Generic Regression Tests ===

test('regression: persona validation rejects assistant owning subject education', () => {
  const answer = "Scout's education includes a Computer Science degree.";
  const result = validateAnswer(answer, 'Bradley Matera holds a CS degree.', 'What is his degree?', testKnowledge);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.includes('persona_confusion') || r.includes('assistant_persona') || r.includes('fabricated') || r.includes('unsupported')), `Expected persona rejection, got: ${result.reasons.join(', ')}`);
});

test('regression: persona validation rejects assistant owning subject employment', () => {
  const answer = 'Scout completed an internship at Amazon Web Services as a Cloud Engineer.';
  const result = validateAnswer(answer, 'Bradley completed an AWS internship.', 'Tell me about AWS.', testKnowledge);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.length > 0, `Expected rejection, got: ${result.reasons.join(', ')}`);
});

test('regression: relationship validation rejects ProjectHub associated with AWS internship', () => {
  const answer = 'ProjectHub was created by Bradley during his AWS internship capstone project.';
  const result = validateAnswer(answer, 'ProjectHub is a personal portfolio widget. AWS capstone is serverless metadata.', 'Was ProjectHub an AWS capstone?', testKnowledge);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.includes('unsupported_relationship') || r.includes('not_relevant_to_question')), `Expected relationship rejection, got: ${result.reasons.join(', ')}`);
});

test('regression: relationship validation rejects AWS capstone associated with Scout', () => {
  const answer = 'Scout designed the AWS Serverless Metadata Extraction Workflow.';
  const result = validateAnswer(answer, 'Bradley designed the AWS Serverless Metadata Extraction Workflow.', 'Who built the AWS capstone?', testKnowledge);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.includes('unsupported_relationship') || r.includes('persona_confusion') || r.includes('not_relevant_to_question')), `Expected rejection, got: ${result.reasons.join(', ')}`);
});

test('regression: follow-up "there" resolves to primary entity in history', () => {
  const history = [
    { role: 'user', text: 'What did he do at his AWS internship?' },
    { role: 'assistant', text: 'He built a serverless metadata extraction pipeline using Lambda and DynamoDB.' }
  ];
  const answer = 'There he built Vue.js single page applications.';
  const result = validateAnswer(answer, 'AWS internship used Lambda and DynamoDB.', 'What did he do there?', testKnowledge, history);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.includes('fabricated_entity') || r.includes('unsupported_relationship')), `Expected follow-up rejection, got: ${result.reasons.join(', ')}`);
});

test('regression: follow-up "it" resolves to primary entity in history', () => {
  const history = [
    { role: 'user', text: 'Tell me about ProjectHub.' },
    { role: 'assistant', text: 'ProjectHub is a recruiter-facing AI chat widget.' }
  ];
  const answer = 'It uses PyTorch and CUDA for real-time model inference.';
  const result = validateAnswer(answer, 'ProjectHub uses vanilla JavaScript and Node.js.', 'How does it work?', testKnowledge, history);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.includes('fabricated_entity') || r.includes('unsupported_relationship')), `Expected follow-up rejection, got: ${result.reasons.join(', ')}`);
});

test('regression: comparison entity swap is rejected', () => {
  const answer = 'Comparing ProjectHub to Voice Ops Platform: ProjectHub uses Voice Ops technology.';
  const result = validateAnswer(answer, 'ProjectHub uses vanilla JS. Voice Ops uses Web Audio API.', 'Compare ProjectHub to Voice Ops Platform.', testKnowledge);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.includes('unsupported_relationship') || r.includes('not_relevant_to_question')), `Expected comparison rejection, got: ${result.reasons.join(', ')}`);
});

test('regression: negated user-provided false entity is accepted', () => {
  const answer = 'No, Bradley did not work at Microsoft. He completed an AWS internship.';
  const result = validateAnswer(answer, 'Bradley completed an AWS internship.', 'Did he work at Microsoft?', testKnowledge);
  assert.equal(result.valid, true, `Should accept negated false entity refutation, got: ${result.reasons.join(', ')}`);
});

test('regression: overclaim of professional employment for project-only skill is rejected', () => {
  const answer = 'He has 5 years of professional production experience working as a React tech lead.';
  const result = validateAnswer(answer, 'React is used in personal portfolio projects.', 'Is he a React lead?', testKnowledge);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.includes('expanded_overclaim') || r.includes('unsupported_relationship') || r.includes('number_not_grounded')), `Expected overclaim rejection, got: ${result.reasons.join(', ')}`);
});

test('regression: incorrect technology relationship across projects is rejected', () => {
  const answer = 'ProjectHub relies on WebGPU for rendering 3D graphics in the browser.';
  const result = validateAnswer(answer, 'ProjectHub uses vanilla JS and Node.js. Triangle Shader Lab uses WebGPU.', 'Does ProjectHub use WebGPU?', testKnowledge);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.includes('unsupported_relationship') || r.includes('not_relevant_to_question')), `Expected tech relationship rejection, got: ${result.reasons.join(', ')}`);
});

test('regression: relationship-validator handles graph entityIndex returning array of triples', () => {
  const { validateRelationships } = require('../lib/relationship-validator');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const graph = buildRelationshipGraph(testKnowledge);
  const history = [{ role: 'user', text: 'Tell me about the AWS internship.' }];
  const res = validateRelationships('He learned WebGPU during the AWS capstone.', graph, 'What did he learn there?', history);
  assert.equal(res.valid, false, 'Should reject WebGPU under AWS capstone even when entityIndex returns array');
  assert.ok(res.unsupportedClaims.length > 0, 'Should contain unsupported relationship claims');
});

test('regression: validateAnswer preserves and passes history through to relationship validation', () => {
  const history = [{ role: 'user', text: 'What did he do at AWS?' }];
  const result = validateAnswer(
    'He built WebGPU applications there.',
    'AWS capstone uses Lambda. WebGPU is separate.',
    'What did he build there?',
    testKnowledge,
    history
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(r => r.includes('unsupported_relationship')), `History context should trigger relationship rejection, got: ${result.reasons.join(', ')}`);
});
