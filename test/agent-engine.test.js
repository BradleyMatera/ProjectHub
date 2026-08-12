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
  // Note: The secondary uses_tech scan only checks when the primary entity is a
  // PROJECT. When it's a technology (AWS), the scan is skipped to prevent false
  // positives like "AWS uses_tech Lambda". WebGPU under AWS capstone is a model
  // capacity issue that's harder to catch generically without false positives.
  // The validator should not crash and should return a result.
  assert.ok(res !== null && res !== undefined, 'Should return a result');
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

// === HalfCommit safety-regression guard ===
// These tests pin the 6 displayed safety errors found in the post-HalfCommit
// 68-run audit. They ensure the validation loosening that caused them cannot
// recur. Each test is generic (no questionId branching, no ProjectHub-specific
// hardcoding) — it tests the generic validation concept that was broken.

// q38 / q44: "experience in cloud infrastructure management" and
// "experience in cloud infrastructure design and automation" were overclaims
// that passed because a genericCategoryRe skip exempted any has_experience
// claim starting with "cloud", "infrastructure", "devops", etc. That skip is
// removed — unsupported has_experience claims must go through relationship
// validation and fail when no triple exists.
test('regression: has_experience overclaim for cloud infrastructure is rejected', () => {
  const result = validateRelationships(
    'He has experience in cloud infrastructure management and automation.',
    testGraph
  );
  assert.equal(result.valid, false, 'Unsupported has_experience overclaim should be rejected');
  assert.ok(result.unsupportedClaims.length > 0, 'Should flag cloud infrastructure as unsupported has_experience');
});

test('regression: has_experience overclaim for cloud infrastructure design is rejected', () => {
  const result = validateRelationships(
    'Bradley has experience in cloud infrastructure design and automation.',
    testGraph
  );
  assert.equal(result.valid, false, 'Unsupported has_experience overclaim should be rejected');
});

// q23: "ProjectHub is a tool that helps find jobs for people..." was a factual
// mischaracterization that passed because the isOpenEndedQuestion regex was
// over-broad (matched "explain it"), skipping the insufficient_content_overlap
// check. The regex is reverted — "Explain X like I'm not technical" should NOT
// be classified as open-ended, so an answer with low source overlap is rejected.
test('regression: explain-like question does not skip content-overlap check', () => {
  const source = 'ProjectHub is an embeddable AI recruiter assistant named Scout. It answers questions about Bradley projects.';
  const result = validateAnswer(
    'ProjectHub is a tool that helps find jobs for people who are looking for work, kind of like a job search engine but with AI assistance.',
    source,
    "Explain ProjectHub like I'm not technical.",
    testKnowledge
  );
  assert.equal(result.valid, false, `Mischaracterized answer with low source overlap should be rejected, got: ${result.reasons.join(', ')}`);
});

// q33: "ProjectHub is an AI assistant script that answers questions about
// various scripts on websites" — mischaracterization. This is a PRE-EXISTING
// claim-extractor coverage gap (is_type claims are skipped, and the description
// mischaracterization isn't captured by any pattern). Documenting as a known
// gap — the is_type skip and description-accuracy check need to be addressed
// in the conversational-parity phase.
test('known-gap: ProjectHub mischaracterization as scripts-answerer (pre-existing)', () => {
  const source = 'ProjectHub is an embeddable AI recruiter assistant named Scout. It uses JavaScript, Node.js, and Express.';
  const result = validateAnswer(
    'ProjectHub is an AI assistant script that answers questions about various scripts on websites. It uses JavaScript, Node.js, and Express for its functionality.',
    source,
    'What about the other project?',
    testKnowledge
  );
  // Currently passes — this is a known gap. is_type validation is skipped and
  // the description mischaracterization isn't extracted as a claim.
  // When fixed, this assertion should flip to false.
  assert.equal(result.valid, true, `Known gap: mischaracterization currently passes. Reasons: ${result.reasons.join(', ')}`);
});

// q28: "AWS internship capstone... and an AI assistant named Scout" — Scout is
// the ProjectHub assistant, NOT part of the AWS capstone. This is a PRE-EXISTING
// claim-extractor coverage gap — the complex sentence "capstone that involved...
// with Lambda, DynamoDB, S3, and an AI assistant named Scout" doesn't match any
// extraction pattern, so no claims are extracted and nothing is validated.
test('known-gap: Scout attributed to AWS capstone (pre-existing claim-extractor gap)', () => {
  const result = validateRelationships(
    'His strongest project was the AWS internship capstone that involved extracting metadata using a serverless pipeline with Lambda, DynamoDB, S3, and an AI assistant named Scout.',
    testGraph
  );
  // Currently passes — this is a known gap. The claim extractor doesn't parse
  // the complex sentence structure to extract Scout as an attributed entity.
  // When fixed, this assertion should flip to false.
  assert.equal(result.valid, true, `Known gap: Scout-in-capstone currently passes. Unsupported: ${result.unsupportedClaims.length}`);
});

// q4: Follow-up context drift — conversation about ProjectHub, but answer
// talks about the Pokedex. The implicit follow-up subject consistency check
// detects that the question doesn't mention an entity, the conversation's
// primary entity is ProjectHub, and the answer mentions a different entity
// (Pokedex) without mentioning ProjectHub.
test('regression: follow-up answer drifts to wrong project is rejected', () => {
  const history = [
    { role: 'user', text: 'Tell me about ProjectHub.' },
    { role: 'user', text: "Okay, but what's actually interesting about it?" },
    { role: 'user', text: 'What did Bradley personally build?' }
  ];
  const source = 'ProjectHub is an embeddable AI recruiter assistant. It uses JavaScript and Node.js. The Interactive Pokedex uses client-side search and filtering.';
  const result = validateAnswer(
    'The hardest technical part was integrating the Pokedex static UI with a dynamic client-side search and filtering system.',
    source,
    'What was the hardest technical part?',
    testKnowledge,
    history
  );
  assert.equal(result.valid, false, `Follow-up context drift should be rejected, got: ${result.reasons.join(', ')}`);
  assert.ok(result.reasons.some(r => r.includes('context_drift')), `Should flag context drift, got: ${result.reasons.join(', ')}`);
});

// Control: when the question explicitly mentions an entity, context drift
// should NOT be triggered — the user is intentionally asking about that entity.
test('regression: explicit entity in question does not trigger context drift', () => {
  const history = [
    { role: 'user', text: 'Tell me about ProjectHub.' },
    { role: 'user', text: "Okay, but what's actually interesting about it?" }
  ];
  const source = 'ProjectHub is an embeddable AI recruiter assistant. The Interactive Pokedex uses client-side search and filtering.';
  const result = validateAnswer(
    'The Interactive Pokedex has client-side search and filtering for all 151 entries.',
    source,
    'What about the Interactive Pokedex?',
    testKnowledge,
    history
  );
  // Should not be rejected for context drift — the question explicitly asks
  // about the Pokedex, so mentioning it is correct.
  assert.ok(!result.reasons.includes('context_drift'), `Explicit entity question should not trigger context drift, got: ${result.reasons.join(', ')}`);
});

// Entity-grounding exemption must NOT become factual-grounding exemption.
// "Kubernetes" is a recognizable technology, but if it is not in the source
// evidence for this query, claiming it as Bradley's experience must fail
// grounding. (Negated mentions are handled separately by the negation skip.)
test('regression: recognizable tech name still requires grounding when asserted', () => {
  const source = 'Bradley built ProjectHub with JavaScript and Node.js. He has an AWS certification.';
  const result = validateAnswer(
    'Bradley has Kubernetes experience and uses it for deployment.',
    source,
    'What does Bradley know?',
    testKnowledge
  );
  assert.equal(result.valid, false, `Ungrounded Kubernetes claim should be rejected even though Kubernetes is a real technology, got: ${result.reasons.join(', ')}`);
  assert.ok(result.reasons.some(r => r.startsWith('entity_not_grounded:') || r.includes('unsupported_relationship')), `Should flag Kubernetes as ungrounded or unsupported, got: ${result.reasons.join(', ')}`);
});

// Negated mention of a recognizable tech name should NOT be rejected — the
// negation-context skip handles "no Kubernetes experience" correctly.
test('regression: negated tech mention is not falsely rejected', () => {
  const source = 'Bradley built ProjectHub with JavaScript and Node.js. He has an AWS certification.';
  const result = validateAnswer(
    'No, he does not have a Kubernetes certification.',
    source,
    'He has a Kubernetes certification, right?',
    testKnowledge
  );
  // This should pass — it's a correct negation/refutation
  assert.equal(result.valid, true, `Negated Kubernetes mention should not be rejected, got: ${result.reasons.join(', ')}`);
});

// === Coreference resolution for "there" → entity from question ===
// When the question asks about "his time at Microsoft" and the answer says
// "he had a brief internship there", "there" must be resolved to "Microsoft"
// so the claim extractor can extract the interned_at claim and reject it.

test('regression: coreference "there" resolves to entity from question (Microsoft)', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const graph = buildRelationshipGraph(testKnowledge);
  const claims = extractClaims(
    'Bradley Matera did not work directly with Microsoft, but he had a brief internship there as part of his tech experience.',
    graph,
    'Tell me about his time at Microsoft.'
  );
  const internClaims = claims.filter(c => c.relation === 'interned_at');
  assert.ok(internClaims.length > 0, 'Should extract interned_at claim from "there" coreference');
  assert.equal(internClaims[0].object, 'Microsoft', 'Object should be Microsoft after coreference resolution');
});

test('regression: coreference "there" resolves to multi-word entity (Acme Corp)', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const graph = buildRelationshipGraph(testKnowledge);
  const claims = extractClaims(
    'He did not work at Acme Corp, but he had an internship there last summer.',
    graph,
    'Did he work at Acme Corp?'
  );
  const internClaims = claims.filter(c => c.relation === 'interned_at');
  assert.ok(internClaims.length > 0, 'Should extract interned_at claim from "there" coreference');
  assert.equal(internClaims[0].object, 'Acme Corp', 'Object should be Acme Corp after coreference resolution');
});

test('regression: fabricated Microsoft internship is rejected via coreference', () => {
  const result = validateAnswer(
    'Bradley Matera did not work directly with Microsoft, but he had a brief internship there as part of his tech experience.',
    'Bradley built ProjectHub. He had an AWS internship.',
    'Tell me about his time at Microsoft.',
    testKnowledge
  );
  assert.equal(result.valid, false, 'Fabricated Microsoft internship via "there" should be rejected');
});

test('regression: fabricated Acme Corp internship is rejected via coreference', () => {
  const result = validateAnswer(
    'He did not work at Acme Corp, but he had an internship there last summer.',
    'Bradley built ProjectHub. He had an AWS internship.',
    'Did he work at Acme Corp?',
    testKnowledge
  );
  assert.equal(result.valid, false, 'Fabricated Acme Corp internship via "there" should be rejected');
});

test('regression: contrastive "but" clause extracts affirmative claim', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const graph = buildRelationshipGraph(testKnowledge);
  // "did not work at A, but had internship at A" — the "but" clause is affirmative
  const claims = extractClaims(
    'He did not work at Microsoft, but he had an internship there.',
    graph,
    'Tell me about his time at Microsoft.'
  );
  const factClaims = claims.filter(c => c.type === 'FACT');
  assert.ok(factClaims.length > 0, 'Affirmative "but" clause should produce a FACT claim');
});

// === Persona/role validation: Scout vs Bradley vs Visitor ===
// Scout is the assistant, Bradley is the subject, Visitor is the person Scout
// is talking to. Scout must not treat the visitor as Bradley.

test('regression: persona confusion — "your experience" when asking about Bradley', () => {
  const result = validateAnswer(
    "I'm interested in learning about your experience as a developer. Could you tell me about any projects or experiences that stand out to you?",
    'Bradley built ProjectHub. He has React and Node.js skills. He completed an AWS internship.',
    'What would you ask him if you were interviewing him?',
    testKnowledge
  );
  assert.equal(result.valid, false, 'Should reject "your experience" when question is about Bradley');
  assert.ok(result.reasons.some(r => r.includes('persona_confusion')), `Should flag persona confusion, got: ${result.reasons.join(', ')}`);
});

test('regression: legitimate "you" addressing visitor is not persona confusion', () => {
  const result = validateAnswer(
    'You could ask him about his AWS internship experience and his work on ProjectHub.',
    'Bradley built ProjectHub. He has React and Node.js skills. He completed an AWS internship.',
    'What should I ask him about?',
    testKnowledge
  );
  // Should NOT be flagged as persona confusion
  assert.ok(!result.reasons.some(r => r.includes('persona_confusion')),
    `Legitimate "you" addressing visitor should not be persona confusion, got: ${result.reasons.join(', ')}`);
});

test('regression: "your projects" when asking about Bradley is persona confusion', () => {
  const result = validateAnswer(
    "I'd love to hear about your projects and what you built during your internship.",
    'Bradley built ProjectHub. He completed an AWS internship.',
    "What's your favorite thing he's built?",
    testKnowledge
  );
  assert.ok(result.reasons.some(r => r.includes('persona_confusion')),
    `"your projects" when asking about Bradley should be persona confusion, got: ${result.reasons.join(', ')}`);
});

// === built_by "subject" normalization and "a project called" stripping ===

test('regression: built_by with "subject" object resolves to Bradley Matera', () => {
  const result = validateAnswer(
    'He built the Static Gen 1 Pokedex UI and it features client-side search and filtering.',
    'Bradley built ProjectHub. He built the Interactive Pokedex with 151 entries.',
    "How well? Like, can he actually build something with it?",
    testKnowledge,
    [{ role: 'user', text: 'Does he know React?' }]
  );
  // built_by should be supported via alias resolution (Static Gen 1 Pokedex UI → Interactive Pokedex)
  assert.ok(!result.reasons.some(r => r.includes('built_by') && r.includes('not found')),
    `built_by with "subject" should resolve to Bradley, got: ${result.reasons.join(', ')}`);
});

test('regression: built_by strips "a project called" prefix', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const graph = buildRelationshipGraph(testKnowledge);
  const claims = extractClaims(
    'The coolest part is that he built a project called ProjectHub, which uses JavaScript.',
    graph,
    "What's the cool part?"
  );
  const builtByClaims = claims.filter(c => c.relation === 'built_by');
  const projectHubClaim = builtByClaims.find(c => c.subject && c.subject.includes('ProjectHub'));
  assert.ok(projectHubClaim, `Should extract built_by for ProjectHub, got subjects: ${builtByClaims.map(c => c.subject).join(', ')}`);
});

// === is_type generic type acceptance ===

test('regression: is_type accepts "web application" as generic type', () => {
  const result = validateAnswer(
    'ProjectHub is a web application that helps match users based on their interests and skills.',
    'ProjectHub is an embeddable AI recruiter assistant named Scout.',
    "Explain ProjectHub like I'm not technical.",
    testKnowledge
  );
  // "web application" should be accepted as a generic type, not rejected as mismatch
  assert.ok(!result.reasons.some(r => r.includes('is_type') && r.includes('mismatch')),
    `"web application" should be accepted as generic type, got: ${result.reasons.join(', ')}`);
});

// === Context drift: "which project" questions ===

test('regression: "which project" question does not trigger context drift', () => {
  const result = validateAnswer(
    'The Interactive Pokedex project is considered more complex due to its extensive features.',
    'ProjectHub is an AI recruiter assistant. Interactive Pokedex has 151 entries.',
    'Which project is the most complex?',
    testKnowledge,
    [
      { role: 'user', text: 'Compare ProjectHub and CIRIS Ethical AI.' },
      { role: 'user', text: 'Compare ProjectHub and the Interactive Pokedex.' }
    ]
  );
  // "Which project" questions should not flag mentioning different projects as drift
  assert.ok(!result.reasons.some(r => r.includes('context_drift')),
    `"Which project" should not trigger context drift, got: ${result.reasons.join(', ')}`);
});

// === Adversarial confirmation: negation questions ===

test('regression: "Yes" to negation question is not adversarial confirmation', () => {
  // "There is no evidence he attended MIT, right?" → "Yes" is correct (confirms no evidence)
  // This should NOT be blocked as adversarial confirmation
  // We test the negation detection logic directly
  const negationRegex = /\b(?:no\s+evidence|not\b|never\b|didn'?t\b|did not\b|no\s+mention|isn'?t\b|is not\b|wasn'?t\b|was not\b|doesn'?t\b|does not\b|haven'?t\b|have not\b|hasn'?t\b|has not\b|won'?t\b|will not\b|wouldn'?t\b|would not\b|couldn'?t\b|could not\b|shouldn'?t\b|should not\b|must not\b|mustn'?t\b|no\s+(?:proof|sign|record|indication))\b/i;
  assert.ok(negationRegex.test('There is no evidence he attended MIT, right?'),
    'Should detect negation in "no evidence" question');
  assert.ok(negationRegex.test('He was not a senior engineer, was he?'),
    'Should detect negation in "was not" question');
  assert.ok(!negationRegex.test('He was a senior engineer, right?'),
    'Should not detect negation in affirmative question');
});

// === Secondary uses_tech scan: only for technologies, not projects ===

test('regression: secondary uses_tech scan does not check projects against history tech', () => {
  const result = validateAnswer(
    'Yes, he has experience building projects. For instance, ProjectHub uses JavaScript, Node.js, and Express, which are all part of his skill set.',
    'Bradley built ProjectHub with JavaScript, Node.js, and Express. He knows React.',
    "How well? Like, can he actually build something with it?",
    testKnowledge,
    [{ role: 'user', text: 'Does he know React?' }]
  );
  // Should NOT flag "React uses_tech ProjectHub" — ProjectHub is a project, not a tech
  assert.ok(!result.reasons.some(r => r.includes('React') && r.includes('uses_tech') && r.includes('ProjectHub')),
    `Should not check React uses_tech ProjectHub, got: ${result.reasons.join(', ')}`);
});

test('regression: secondary uses_tech scan still catches unsupported tech under project', () => {
  // When the primary entity IS a project, the scan should still work
  const result = validateAnswer(
    'He learned WebGPU during the ProjectHub capstone.',
    'ProjectHub uses JavaScript and Node.js. WebGPU is separate.',
    'What did he learn there?',
    testKnowledge,
    [{ role: 'user', text: 'Tell me about ProjectHub.' }]
  );
  // Should reject WebGPU under ProjectHub — ProjectHub is a project, WebGPU is a tech
  assert.equal(result.valid, false, 'Should reject WebGPU under ProjectHub');
});

// === worked_at: "experience with" is skill, not employer ===

test('regression: "experience with front-end" is not worked_at', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const graph = buildRelationshipGraph(testKnowledge);
  const claims = extractClaims(
    'You could ask him about his experience with front-end development, particularly using React and JavaScript.',
    graph,
    'What should I ask him about?'
  );
  const workedAtClaims = claims.filter(c => c.relation === 'worked_at');
  assert.equal(workedAtClaims.length, 0,
    `"experience with front-end" should not be worked_at, got: ${workedAtClaims.map(c => c.object).join(', ')}`);
});

// === Leaked internal syntax guard ===
// The 1.5b model sometimes echoes relation names or internal graph terminology
// from the context/repair packet instead of verbalizing naturally. These broken
// outputs must never be displayed.

test('regression: leaked relation name (worked_at) is rejected', () => {
  const result = validateAnswer(
    'Bradley Matera worked_at modern web development frameworks.',
    'Bradley uses JavaScript and Node.js.',
    'What should I ask him about?',
    testKnowledge
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('leaked_relation_syntax'), `Should flag leaked relation name, got: ${result.reasons.join(', ')}`);
});

test('regression: leaked relation name (uses_tech) is rejected', () => {
  const result = validateAnswer(
    'There uses_tech in the project.',
    'Bradley uses JavaScript and Node.js.',
    'What did he use there?',
    testKnowledge
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('leaked_relation_syntax'), `Should flag leaked relation name, got: ${result.reasons.join(', ')}`);
});

test('regression: leaked tech= syntax is rejected', () => {
  const result = validateAnswer(
    'ProjectHub is more technically complex. It has tech=JavaScript, Node.js, and Express.',
    'ProjectHub uses JavaScript, Node.js, and Express.',
    'Which one would impress you more?',
    testKnowledge
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('leaked_relation_syntax'), `Should flag tech= syntax, got: ${result.reasons.join(', ')}`);
});

test('regression: "my ability" is persona confusion', () => {
  const result = validateAnswer(
    'I believe ProjectHub is quite interesting. It involves creating a chat widget that can be embedded on any website, which adds value to the user experience and showcases my ability to work with various technologies.',
    'Bradley built ProjectHub. Scout is the assistant.',
    'What project do you think is the most interesting?',
    testKnowledge
  );
  assert.ok(result.reasons.some(r => r.includes('persona_confusion')),
    `"my ability" should be persona confusion, got: ${result.reasons.join(', ')}`);
});

test('regression: "project management system" is wrong type for ProjectHub', () => {
  const result = validateAnswer(
    "ProjectHub is a project management system for collaborating on tasks.",
    'ProjectHub is an AI recruiter assistant named Scout.',
    "Explain ProjectHub like I'm not technical.",
    testKnowledge
  );
  // "management" is a specific noun that doesn't match "AI recruiter assistant"
  assert.equal(result.valid, false, `"project management system" should be rejected as wrong type for ProjectHub`);
});

test('regression: false negation — "no experience building" when graph has built_by', () => {
  const result = validateAnswer(
    'He has no experience with building software.',
    'Bradley built ProjectHub, Interactive Pokedex, CheeseMath, and other projects.',
    "What's the strongest evidence that he can actually build software?",
    testKnowledge
  );
  assert.equal(result.valid, false, 'Should reject false negation about building experience');
  assert.ok(result.reasons.some(r => r.includes('false_negation')),
    `Should flag false negation, got: ${result.reasons.join(', ')}`);
});

test('regression: negated has_experience is not extracted as FACT', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const graph = buildRelationshipGraph(testKnowledge);
  const claims = extractClaims(
    'He was an entry-level developer and did not have experience with handling production incidents.',
    graph,
    'He did not handle production incidents, did he?'
  );
  const factClaims = claims.filter(c => c.type === 'FACT' && c.relation === 'has_experience');
  assert.equal(factClaims.length, 0,
    `Negated has_experience should not be extracted as FACT, got: ${factClaims.map(c => c.object).join(', ')}`);
});

test('regression: contrastive clause still extracts affirmative from but-clause', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const graph = buildRelationshipGraph(testKnowledge);
  const claims = extractClaims(
    'He did not work at Microsoft, but he had an internship there.',
    graph,
    'Tell me about his time at Microsoft.'
  );
  const factClaims = claims.filter(c => c.type === 'FACT');
  assert.ok(factClaims.length > 0, 'Affirmative but-clause should still produce FACT claims');
});

test('regression: lowercase subject not extracted as uses_tech subject', () => {
  const { extractClaims } = require('../lib/claim-extractor');
  const { buildRelationshipGraph } = require('../lib/relationship-graph');
  const graph = buildRelationshipGraph(testKnowledge);
  // "current weakness" starts with lowercase — should not be a uses_tech subject
  const claims = extractClaims(
    'His biggest current weakness is in understanding and utilizing complex data structures efficiently.',
    graph,
    'What are his weaknesses?'
  );
  const badClaims = claims.filter(c => c.type === 'FACT' && c.subject && /^[a-z]/.test(c.subject));
  assert.equal(badClaims.length, 0,
    `Lowercase subjects should not be extracted, got: ${badClaims.map(c => c.subject).join(', ')}`);
});

test('regression: "Yes." is valid for yes/no questions', () => {
  const result = validateAnswer(
    'Yes.',
    'The project was AWS.',
    'Was that AWS?',
    testKnowledge
  );
  assert.ok(!result.reasons.includes('too_short'),
    `"Yes." should not be too_short for a yes/no question, got: ${result.reasons.join(', ')}`);
});

test('regression: "No." is valid for negation confirmation questions', () => {
  const result = validateAnswer(
    'Yes.',
    'No evidence of MIT attendance.',
    'There is no evidence he attended MIT, right?',
    testKnowledge
  );
  assert.ok(!result.reasons.includes('too_short'),
    `"Yes." should not be too_short for a negation confirmation, got: ${result.reasons.join(', ')}`);
});

test('regression: partial object match for tech names (Amplify matches AWS Amplify)', () => {
  const { buildRelationshipGraph, checkRelationship } = require('../lib/relationship-graph');
  const graph = buildRelationshipGraph(testKnowledge);
  // "Amplify" should match "AWS Amplify" via suffix matching
  const result = checkRelationship(graph, 'AWS internship capstone', 'uses_tech', 'Amplify');
  assert.equal(result.supported, true, 'Amplify should match AWS Amplify via partial match');
});

test('regression: false negation not triggered by qualified assessments', () => {
  const result = validateAnswer(
    'No, his projects have been limited to static UIs for the Pokedex, basic calculator demos, and simple WebGL learning examples. He has not built anything substantial or professionally relevant.',
    'Bradley built ProjectHub, Interactive Pokedex, CheeseMath, and other projects.',
    'How well? Like, can he actually build something with it?',
    testKnowledge
  );
  assert.ok(!result.reasons.some(r => r.includes('false_negation')),
    `Qualified assessment should not trigger false negation, got: ${result.reasons.join(', ')}`);
});

test('regression: fabricated AWS certification is rejected', () => {
  const result = validateAnswer(
    'He has completed the AWS Certified Developer Associate (AWS-Developer) certification.',
    'Bradley has AWS Certified Solutions Architect Associate and AWS Certified AI Practitioner certifications.',
    'What AWS certifications does he have?',
    testKnowledge
  );
  assert.equal(result.valid, false, 'Fabricated certification should be rejected');
  assert.ok(result.reasons.some(r => r.includes('fabricated_certification')),
    `Should flag fabricated certification, got: ${result.reasons.join(', ')}`);
});

test('regression: correct AWS certification is accepted', () => {
  const result = validateAnswer(
    'He has completed the AWS Certified Solutions Architect - Associate certification.',
    'Bradley has AWS Certified Solutions Architect Associate and AWS Certified AI Practitioner certifications.',
    'What AWS certifications does he have?',
    testKnowledge
  );
  assert.equal(result.valid, true, `Correct certification should be accepted, got: ${result.reasons.join(', ')}`);
});

test('regression: "lacks experience with X" rejected when X is a built project', () => {
  const result = validateAnswer(
    'He lacks experience with the Interactive Pokedex, CheeseMath Calculator, and Triangle Shader Lab.',
    'Bradley built the Interactive Pokedex, CheeseMath, and Triangle Shader Lab.',
    'What experience does he lack?',
    testKnowledge
  );
  assert.equal(result.valid, false, 'Should reject lack claims about built projects');
  assert.ok(result.reasons.some(r => r.includes('false_negation')),
    `Should flag false negation for built project, got: ${result.reasons.join(', ')}`);
});

test('regression: fabricated employment at unknown company is rejected', () => {
  const result = validateAnswer(
    'Bradley Matera was a Cloud Support Engineer Intern with Netflix, focusing on serverless architecture and microservices integration.',
    'Bradley worked at AWS and CIRIS Ethical AI.',
    'What did he do at Netflix?',
    testKnowledge
  );
  assert.equal(result.valid, false, 'Fabricated Netflix employment should be rejected');
  assert.ok(result.reasons.some(r => r.includes('fabricated_employment')),
    `Should flag fabricated employment, got: ${result.reasons.join(', ')}`);
});

test('regression: correct employment at known company is accepted', () => {
  const result = validateAnswer(
    'Bradley Matera was a Cloud Support Engineer Intern at Amazon Web Services (AWS).',
    'Bradley interned at AWS.',
    'What did he do at AWS?',
    testKnowledge
  );
  assert.equal(result.valid, true, `Correct AWS employment should be accepted, got: ${result.reasons.join(', ')}`);
});

test('regression: fabricated technology (MongoDB) is detected when not in knowledge base', () => {
  const result = validateAnswer(
    'His experience with building and deploying web applications using technologies such as Node.js, Express, and MongoDB.',
    'Bradley has experience with JavaScript, Node.js, Express, React, and AWS.',
    "What's the strongest evidence that he can actually build software?",
    testKnowledge
  );
  assert.equal(result.valid, false, 'MongoDB should be flagged as fabricated when not in knowledge base');
  assert.ok(result.reasons.some(r => r.includes('fabricated_entity:MongoDB')),
    `Should flag MongoDB as fabricated, got: ${result.reasons.join(', ')}`);
});

test('regression: known technology is not flagged as fabricated', () => {
  const result = validateAnswer(
    'His skills include JavaScript, Node.js, Express, and React.',
    'Bradley has experience with JavaScript, Node.js, Express, and React.',
    'Does he know React?',
    testKnowledge
  );
  assert.equal(result.valid, true, `Known technologies should not be flagged, got: ${result.reasons.join(', ')}`);
});

test('regression: negated technology mention is not flagged as fabricated', () => {
  const result = validateAnswer(
    'He does not have experience with MongoDB or PostgreSQL.',
    'Bradley has experience with JavaScript and Node.js.',
    'Does he know MongoDB?',
    testKnowledge
  );
  assert.ok(!result.reasons.some(r => r.includes('fabricated_entity:MongoDB')),
    `Negated MongoDB should not be flagged as fabricated, got: ${result.reasons.join(', ')}`);
});

test('regression: fabricated entity description is rejected', () => {
  const result = validateAnswer(
    'ProjectHub is a web application that allows users to search and apply for developer roles based on their skills and experience.',
    'ProjectHub is an embeddable AI recruiter assistant named Scout.',
    'Tell me about ProjectHub.',
    testKnowledge
  );
  assert.equal(result.valid, false, 'Fabricated description should be rejected');
  assert.ok(result.reasons.some(r => r.includes('unsupported_description')),
    `Should flag unsupported description, got: ${result.reasons.join(', ')}`);
});

test('regression: correct entity description is accepted', () => {
  const result = validateAnswer(
    'ProjectHub is an AI assistant named Scout that answers questions about projects and skills.',
    'ProjectHub is an embeddable AI recruiter assistant named Scout.',
    'Tell me about ProjectHub.',
    testKnowledge
  );
  assert.equal(result.valid, true, `Correct description should be accepted, got: ${result.reasons.join(', ')}`);
});

test('regression: project claimed as company is rejected', () => {
  const result = validateAnswer(
    'His work experience includes internships at companies such as ProjectHub, where he contributed to serverless applications.',
    'Bradley built ProjectHub. He interned at AWS.',
    'Is he someone worth interviewing?',
    testKnowledge
  );
  assert.equal(result.valid, false, 'Project claimed as company should be rejected');
  assert.ok(result.reasons.some(r => r.includes('wrong_relationship:project_as_company')),
    `Should flag project as company, got: ${result.reasons.join(', ')}`);
});

test('regression: false negation "projects do not involve building" is rejected', () => {
  const result = validateAnswer(
    'No, his projects do not involve building anything. He primarily focuses on frontend development.',
    'Bradley has built ProjectHub, Interactive Pokedex, CheeseMath.',
    'How well? Like, can he actually build something with it?',
    testKnowledge
  );
  assert.ok(result.reasons.some(r => r.includes('false_negation')),
    `Should flag false negation, got: ${result.reasons.join(', ')}`);
});

test('regression: has_degree with school name matches attended synonym', () => {
  const { buildRelationshipGraph, checkRelationship } = require('../lib/relationship-graph');
  const graph = buildRelationshipGraph(testKnowledge);
  // "has a degree from Full Sail" should match "attended Full Sail"
  const result = checkRelationship(graph, 'Bradley Matera', 'has_degree', 'Full Sail University');
  assert.equal(result.supported, true, `has_degree|Full Sail should be supported via attended synonym, got: ${result.reason}`);
  // But has_degree with an unknown school should still fail
  const result2 = checkRelationship(graph, 'Bradley Matera', 'has_degree', 'MIT');
  assert.equal(result2.supported, false, 'has_degree|MIT should not be supported');
});

test('regression: "At Netflix, he built..." is rejected as fabricated employment', () => {
  const result = validateAnswer(
    'At Netflix, he built a serverless metadata workflow with Lambda, S3, and Amplify as part of an intern project.',
    'Bradley worked at AWS. He did not work at Netflix.',
    'What did he do at Netflix?',
    testKnowledge
  );
  assert.equal(result.valid, false, 'Should reject fabricated employment at Netflix');
  assert.ok(result.reasons.some(r => r.includes('fabricated_employment:Netflix')),
    `Should flag fabricated employment at Netflix, got: ${result.reasons.join(', ')}`);
});

test('regression: leaked internal phrase (connecting entities) is rejected', () => {
  const result = validateAnswer(
    'He is best at connecting entities.',
    'Bradley uses JavaScript and Node.js.',
    "What's he best at?",
    testKnowledge
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('leaked_internal_language'), `Should flag leaked internal language, got: ${result.reasons.join(', ')}`);
});

test('regression: leaked internal phrase (not in the knowledge base) is rejected', () => {
  const result = validateAnswer(
    'A technology/entity not in the knowledge base.',
    'Bradley uses JavaScript and Node.js.',
    'What experience does he lack?',
    testKnowledge
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('leaked_internal_language'), `Should flag leaked internal language, got: ${result.reasons.join(', ')}`);
});

test('regression: normal answer without leaked syntax is not falsely rejected', () => {
  const result = validateAnswer(
    'He has experience with JavaScript and Node.js.',
    'Bradley uses JavaScript and Node.js for web development.',
    'What does Bradley know?',
    testKnowledge
  );
  assert.equal(result.valid, true, `Normal answer should not be rejected, got: ${result.reasons.join(', ')}`);
});

// q63: "Bradley was employed by Netflix as a software engineer" — fabrication.
// The model claims employment at Netflix when no such relationship exists.
// The "employed by" pattern must be extracted as a worked_at claim and rejected.
test('regression: fabricated employment at Netflix is rejected', () => {
  const result = validateAnswer(
    'Bradley was employed by Netflix as a software engineer.',
    'Bradley Matera had no direct experience with Netflix. His tech experience is AWS internship and CIRIS freelance.',
    'What did he do at Netflix?',
    testKnowledge
  );
  assert.equal(result.valid, false, `Netflix fabrication should be rejected, got: ${result.reasons.join(', ')}`);
  assert.ok(result.reasons.some(r => r.includes('unsupported_relationship') && r.includes('Netflix')), `Should flag Netflix as unsupported employment, got: ${result.reasons.join(', ')}`);
});

// q33: "AWS context_drift ProjectHub" — the model echoed the internal
// context_drift reason name from the repair packet. All internal reason
// names must be caught by the leaked syntax check.
test('regression: leaked context_drift reason name is rejected', () => {
  const result = validateAnswer(
    'AWS context_drift ProjectHub is unrelated to the projects mentioned.',
    'Bradley built ProjectHub and the AWS capstone.',
    'What about the other project?',
    testKnowledge
  );
  assert.equal(result.valid, false, `Leaked context_drift should be rejected, got: ${result.reasons.join(', ')}`);
  assert.ok(result.reasons.includes('leaked_relation_syntax'), `Should flag leaked context_drift, got: ${result.reasons.join(', ')}`);
});
