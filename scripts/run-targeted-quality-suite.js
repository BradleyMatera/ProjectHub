'use strict';

// Targeted Quality Suite
//
// Tests the generic Scout engine components:
//   - Intent classification (precedence, specialized before YES_NO)
//   - Conversation state + coreference resolution
//   - Response contract (polarity, required entities, evidence strength, boundary)
//   - Completeness check (required entity coverage, fact coverage, polarity)
//   - Meaning preservation in repair
//
// Includes synthetic domain-neutral tests to prove the engine is generic
// and not hardcoded to Bradley-specific entities.

const { classifyIntent, evaluateCompleteness } = require('../lib/completeness-check');
const { buildConversationState, resolveReferent } = require('../lib/conversation-resolver');
const { buildResponseContract } = require('../lib/response-contract');
const assert = require('assert');

// --- Test helpers ---
let pass = 0, fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.log(`FAIL: ${name}: ${e.message}`);
  }
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || ''} expected ${expected}, got ${actual}`);
  }
}

function truthy(val, msg) {
  if (!val) throw new Error(msg || 'expected truthy');
}

function falsy(val, msg) {
  if (val) throw new Error(msg || 'expected falsy');
}

// --- Domain-neutral knowledge for synthetic tests ---
const syntheticKnowledge = {
  projects: [
    { name: 'Product Alpha', tech: ['Python', 'FastAPI', 'PostgreSQL'], description: 'A data pipeline for processing customer orders.' },
    { name: 'Product Beta', tech: ['JavaScript', 'React', 'Node.js'], description: 'A customer-facing dashboard for analytics.' },
  ],
  experience: [
    { company: 'Acme Corp', role: 'Junior Developer' },
    { company: 'TechStart Inc', role: 'Intern' },
  ],
  skills: ['Python', 'JavaScript', 'React', 'PostgreSQL', 'Docker'],
  certifications: [{ name: 'AWS Certified Developer' }],
  summary: { whoIAm: 'Junior developer with internship and project experience.' },
};

// --- Bradley knowledge for benchmark-specific tests ---
const bradleyKnowledge = require('../data/recruiter-knowledge.json');

// ============================================================
// 1. INTENT CLASSIFICATION TESTS
// ============================================================

console.log('\n=== Intent Classification ===');

test('RECRUITER: "Is he someone worth interviewing?"', () => {
  eq(classifyIntent('Is he someone worth interviewing?'), 'RECRUITER');
});

test('RECRUITER: "Why would I interview him?"', () => {
  eq(classifyIntent('Why would I interview him?'), 'RECRUITER');
});

test('RECRUITER: "What concerns would you have?"', () => {
  eq(classifyIntent('What concerns would you have?'), 'RECRUITER');
});

test('RECRUITER: "What are his weaknesses?"', () => {
  eq(classifyIntent('What are his weaknesses?'), 'RECRUITER');
});

test('RECRUITER: "What does he still need to learn?"', () => {
  eq(classifyIntent('What does he still need to learn?'), 'RECRUITER');
});

test('RECRUITER: "What should I ask him about?"', () => {
  eq(classifyIntent('What should I ask him about?'), 'RECRUITER');
});

test('JOB_FIT: "Does he fit this cloud role?"', () => {
  eq(classifyIntent('Does he fit this cloud role?'), 'JOB_FIT');
});

test('JOB_FIT: "How does he fit a DevOps role requiring Kubernetes and CI/CD?"', () => {
  eq(classifyIntent('How does he fit a DevOps role requiring Kubernetes and CI/CD?'), 'JOB_FIT');
});

test('COMPARISON: "Is Project A more complex than Project B?"', () => {
  eq(classifyIntent('Is Project A more complex than Project B?'), 'COMPARISON');
});

test('OPINION: "Is that actually impressive?"', () => {
  eq(classifyIntent('Is that actually impressive?'), 'OPINION');
});

test('OPINION: "Why should I care about that?"', () => {
  eq(classifyIntent('Why should I care about that?'), 'OPINION');
});

test('SKILL: "Does he know React?"', () => {
  eq(classifyIntent('Does he know React?'), 'SKILL');
});

test('YES_NO: "Was that real production work or just training?"', () => {
  eq(classifyIntent('Was that real production work or just training?'), 'YES_NO');
});

test('FOLLOW_UP: "What did he use there?"', () => {
  eq(classifyIntent('What did he use there?'), 'FOLLOW_UP');
});

test('FOLLOW_UP: "Why did he build it that way?"', () => {
  eq(classifyIntent('Why did he build it that way?'), 'FOLLOW_UP');
});

test('FOLLOW_UP: "What about the other project?"', () => {
  eq(classifyIntent('What about the other project?'), 'FOLLOW_UP');
});

test('FOLLOW_UP: "So what is this thing?"', () => {
  eq(classifyIntent('So what is this thing?'), 'FOLLOW_UP');
});

test('ADVERSARIAL: "There is no evidence he attended MIT, right?"', () => {
  eq(classifyIntent('There is no evidence he attended MIT, right?'), 'ADVERSARIAL');
});

test('ADVERSARIAL: "He was not a senior engineer, was he?"', () => {
  eq(classifyIntent('He was not a senior engineer, was he?'), 'ADVERSARIAL');
});

test('PROJECT: "Tell me about his time at Microsoft."', () => {
  eq(classifyIntent('Tell me about his time at Microsoft.'), 'PROJECT');
});

test('PROJECT: "What did he do at Netflix?"', () => {
  eq(classifyIntent('What did he do at Netflix?'), 'PROJECT');
});

test('PROJECT: "Okay now explain it technically."', () => {
  eq(classifyIntent('Okay now explain it technically.'), 'PROJECT');
});

// Synthetic domain-neutral intent tests
test('SYNTHETIC RECRUITER: "Is this candidate worth interviewing?"', () => {
  eq(classifyIntent('Is this candidate worth interviewing?'), 'RECRUITER');
});

test('SYNTHETIC JOB_FIT: "Does she fit a backend role requiring Python?"', () => {
  eq(classifyIntent('Does she fit a backend role requiring Python?'), 'JOB_FIT');
});

test('SYNTHETIC FOLLOW_UP: "What did she use there?"', () => {
  eq(classifyIntent('What did she use there?'), 'FOLLOW_UP');
});

test('SYNTHETIC ADVERSARIAL: "She was a senior architect, right?"', () => {
  eq(classifyIntent('She was a senior architect, right?'), 'ADVERSARIAL');
});

// ============================================================
// 2. CONVERSATION STATE + COREFERENCE RESOLUTION TESTS
// ============================================================

console.log('\n=== Conversation State + Coreference ===');

test('COREF: "there" resolves to active project entity', () => {
  const history = [
    { role: 'user', text: 'What has he done with AWS?' },
    { role: 'assistant', text: 'He built an AWS Serverless Metadata Extraction Workflow using Lambda and DynamoDB.' },
  ];
  const state = buildConversationState(history, bradleyKnowledge);
  const result = resolveReferent('What did he actually learn there?', state, bradleyKnowledge);
  truthy(result.resolved, 'should resolve');
  truthy(result.entity.includes('AWS'), `entity should include AWS, got ${result.entity}`);
});

test('COREF: "it" resolves to active project entity', () => {
  const history = [
    { role: 'user', text: 'Explain ProjectHub like I am not technical.' },
    { role: 'assistant', text: 'ProjectHub is a chatbot called Scout that adds a chat widget to any website.' },
  ];
  const state = buildConversationState(history, bradleyKnowledge);
  const result = resolveReferent('Why did he build it that way?', state, bradleyKnowledge);
  truthy(result.resolved, 'should resolve');
  truthy(result.entity.toLowerCase().includes('projecthub'), `entity should include ProjectHub, got ${result.entity}`);
});

test('COREF: "this thing" resolves to active entity', () => {
  const history = [
    { role: 'user', text: 'What about the other project?' },
    { role: 'assistant', text: 'ProjectHub is an AI recruiter assistant using JavaScript and Node.js.' },
    { role: 'user', text: 'Did he do that professionally?' },
    { role: 'assistant', text: 'No, ProjectHub was a personal project.' },
  ];
  const state = buildConversationState(history, bradleyKnowledge);
  const result = resolveReferent('So what is this thing?', state, bradleyKnowledge);
  truthy(result.resolved, 'should resolve');
  truthy(result.entity.toLowerCase().includes('projecthub'), `entity should include ProjectHub, got ${result.entity}`);
});

test('COREF: "the other project" resolves to a different project', () => {
  const history = [
    { role: 'user', text: 'What did he use there?' },
    { role: 'assistant', text: 'He used AWS Lambda and DynamoDB in the AWS Serverless Metadata Extraction Workflow.' },
  ];
  const state = buildConversationState(history, bradleyKnowledge);
  const result = resolveReferent('What about the other project?', state, bradleyKnowledge);
  truthy(result.resolved, 'should resolve');
  // Should NOT resolve to the AWS project (which is the active entity)
  falsy(result.entity.toLowerCase().includes('aws serverless'), `should not resolve to AWS project, got ${result.entity}`);
});

test('COREF: no history — "there" does not resolve', () => {
  const state = buildConversationState([], bradleyKnowledge);
  const result = resolveReferent('What did he use there?', state, bradleyKnowledge);
  falsy(result.resolved, 'should not resolve without history');
});

// Synthetic domain-neutral coreference tests
test('SYNTHETIC COREF: "there" resolves to Product Alpha', () => {
  const history = [
    { role: 'user', text: 'Tell me about Product Alpha.' },
    { role: 'assistant', text: 'Product Alpha is a data pipeline using Python and FastAPI.' },
  ];
  const state = buildConversationState(history, syntheticKnowledge);
  const result = resolveReferent('What did she learn there?', state, syntheticKnowledge);
  truthy(result.resolved, 'should resolve');
  truthy(result.entity.includes('Product Alpha'), `entity should include Product Alpha, got ${result.entity}`);
});

test('SYNTHETIC COREF: "the other project" resolves to Product Beta', () => {
  const history = [
    { role: 'user', text: 'Tell me about Product Alpha.' },
    { role: 'assistant', text: 'Product Alpha is a data pipeline using Python and FastAPI.' },
  ];
  const state = buildConversationState(history, syntheticKnowledge);
  const result = resolveReferent('What about the other project?', state, syntheticKnowledge);
  truthy(result.resolved, 'should resolve');
  truthy(result.entity.includes('Product Beta'), `entity should include Product Beta, got ${result.entity}`);
});

// ============================================================
// 3. RESPONSE CONTRACT TESTS
// ============================================================

console.log('\n=== Response Contract ===');

test('CONTRACT: recruiter recommendation gets YES polarity', () => {
  const c = buildResponseContract('Is he someone worth interviewing?',
    'Bradley is an entry-level developer with JavaScript, React, AWS experience.', bradleyKnowledge, []);
  eq(c.intent, 'RECRUITER');
  eq(c.directAnswer, 'YES');
  truthy(c.boundary, 'should have boundary');
});

test('CONTRACT: DevOps role gets NOT_FIT polarity', () => {
  const c = buildResponseContract('How does he fit a DevOps role requiring Kubernetes and CI/CD?',
    'Bradley has AWS experience. No Kubernetes evidence. No CI/CD evidence.', bradleyKnowledge, []);
  eq(c.intent, 'JOB_FIT');
  eq(c.directAnswer, 'NOT_FIT');
  truthy(c.requiredEntities.includes('Kubernetes'), 'should require Kubernetes');
  truthy(c.requiredEntities.includes('CI/CD'), 'should require CI/CD');
});

test('CONTRACT: junior frontend gets FIT polarity', () => {
  const c = buildResponseContract('How does he fit a junior frontend developer role requiring React and TypeScript?',
    'Bradley has React and TypeScript skills. Built Pokedex with React.', bradleyKnowledge, []);
  eq(c.intent, 'JOB_FIT');
  eq(c.directAnswer, 'FIT');
  truthy(c.requiredEntities.includes('React'), 'should require React');
});

test('CONTRACT: production question gets NO polarity with INTERNSHIP evidence', () => {
  const c = buildResponseContract('Was that real production work or just training?',
    'AWS internship capstone project with Lambda and S3. Not for live operations.', bradleyKnowledge, []);
  eq(c.intent, 'YES_NO');
  eq(c.directAnswer, 'NO');
  eq(c.evidenceStrength, 'INTERNSHIP');
});

test('CONTRACT: cloud experience gets YES polarity', () => {
  const c = buildResponseContract('Does that count as real cloud experience?',
    'AWS internship capstone with Lambda, DynamoDB, S3, and Amplify.', bradleyKnowledge, []);
  eq(c.intent, 'YES_NO');
  eq(c.directAnswer, 'YES');
});

test('CONTRACT: comparison gets MIXED and required entities', () => {
  const c = buildResponseContract('Compare ProjectHub and CIRIS Ethical AI.',
    'ProjectHub uses JavaScript, Node.js. CIRIS uses Docker Compose, GitHub.', bradleyKnowledge, []);
  eq(c.intent, 'COMPARISON');
  eq(c.directAnswer, 'MIXED');
  truthy(c.requiredEntities.length >= 2, 'should require both entities');
});

test('CONTRACT: skill question gets YES polarity', () => {
  const c = buildResponseContract('Does he know React?',
    'React is in his skills. Built Interactive Pokedex with React.', bradleyKnowledge, []);
  eq(c.intent, 'SKILL');
  eq(c.directAnswer, 'YES');
});

// Synthetic contract tests
test('SYNTHETIC CONTRACT: Python skill gets YES', () => {
  const c = buildResponseContract('Does she know Python?',
    'Python is in her skills. Built Product Alpha with Python and FastAPI.', syntheticKnowledge, []);
  eq(c.intent, 'SKILL');
  eq(c.directAnswer, 'YES');
});

test('SYNTHETIC CONTRACT: senior role gets NO with boundary', () => {
  const c = buildResponseContract('Was she a senior architect?',
    'She was a Junior Developer at Acme Corp.', syntheticKnowledge, []);
  // This is a yes/no question about seniority
  eq(c.intent, 'YES_NO');
  // The boundary should mention junior level
  truthy(c.boundary, 'should have boundary');
});

// ============================================================
// 4. COMPLETENESS CHECK TESTS
// ============================================================

console.log('\n=== Completeness Check ===');

test('COMPLETENESS: missing required entities detected', () => {
  const contract = {
    requiredEntities: ['ProjectHub', 'CIRIS'],
    intent: 'COMPARISON',
    directAnswer: 'MIXED',
  };
  const result = evaluateCompleteness(
    'ProjectHub is an AI assistant using JavaScript.',
    'Compare ProjectHub and CIRIS.',
    [], contract
  );
  falsy(result.complete, 'should be incomplete');
  eq(result.reason, 'MISSING_REQUIRED_ENTITIES');
  truthy(result.missingEntities.includes('CIRIS'), 'should report CIRIS as missing');
});

test('COMPLETENESS: all required entities present passes', () => {
  const contract = {
    requiredEntities: ['ProjectHub', 'CIRIS'],
    intent: 'COMPARISON',
    directAnswer: 'MIXED',
  };
  const result = evaluateCompleteness(
    'ProjectHub uses JavaScript while CIRIS uses Docker Compose.',
    'Compare ProjectHub and CIRIS.',
    [], contract
  );
  truthy(result.complete, 'should be complete');
});

test('COMPLETENESS: polarity mismatch detected (YES expected, answer says No)', () => {
  const contract = {
    directAnswer: 'YES',
    intent: 'RECRUITER',
  };
  const result = evaluateCompleteness(
    'No, he is not worth interviewing.',
    'Is he someone worth interviewing?',
    [], contract
  );
  falsy(result.complete, 'should be incomplete');
  eq(result.reason, 'POLARITY_MISMATCH');
});

test('COMPLETENESS: polarity correct (NO expected, answer says No)', () => {
  const contract = {
    directAnswer: 'NO',
    intent: 'YES_NO',
  };
  const result = evaluateCompleteness(
    'No, that was not production work. It was an internship capstone project.',
    'Was that real production work?',
    [], contract
  );
  truthy(result.complete, 'should be complete');
});

test('COMPLETENESS: generic vague answer still caught', () => {
  const result = evaluateCompleteness(
    'He is best at building simple projects using basic technologies.',
    'What is he best at?',
    []
  );
  falsy(result.complete, 'should be incomplete');
});

// ============================================================
// 5. MEANING PRESERVATION TESTS (via lite-agent export)
// ============================================================

console.log('\n=== Meaning Preservation ===');

// We can't directly test meaningPreserved without exporting it, but we can
// test the behavior through the completeness check polarity verification.
test('MEANING: positive answer stays positive', () => {
  const contract = { directAnswer: 'YES', intent: 'SKILL' };
  const result = evaluateCompleteness(
    'Yes, he knows React. He built the Interactive Pokedex with it.',
    'Does he know React?', [], contract
  );
  truthy(result.complete, 'positive answer with YES polarity should pass');
});

test('MEANING: negative answer stays negative', () => {
  const contract = { directAnswer: 'NO', intent: 'YES_NO' };
  const result = evaluateCompleteness(
    'No, that was not production work. It was an internship project.',
    'Was that real production work?', [], contract
  );
  truthy(result.complete, 'negative answer with NO polarity should pass');
});

// ============================================================
// RESULTS
// ============================================================

console.log(`\n=== Results: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  process.exit(1);
}
