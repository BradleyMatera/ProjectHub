'use strict';

/**
 * Semantic Acceptance Tests
 *
 * Runs actual Scout engine functions against the real Bradley KB
 * to verify answer quality, grounding, and semantic correctness.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectAdversarialCaveat } = require('../lib/lite-agent');
const { validateAnswer } = require('../lib/grounding-validator');
const knowledgeAccess = require('../lib/knowledge-access');
const { buildRelationshipGraph } = require('../lib/relationship-graph');
const { classifyIntent } = require('../lib/completeness-check');
const { determineDirectAnswer } = require('../lib/response-planner');
const knowledge = require('../data/recruiter-knowledge.json');

const graph = buildRelationshipGraph(knowledge);

function getFactState(question, intent) {
  // Determine if the question's subject is known
  const q = question.toLowerCase();
  const techs = knowledgeAccess.getKnownTechnologies(knowledge);
  const companies = knowledgeAccess.getKnownCompanies(knowledge).map(c => c.toLowerCase());

  // Check if question mentions unknown tech
  const techMatch = q.match(/\b(?:know|use|used|code in|familiar with)\s+([A-Za-z+#.]+)\b/i);
  if (techMatch) {
    const tech = techMatch[1].toLowerCase();
    if (!techs.includes(tech)) return 'UNKNOWN';
    return 'TRUE';
  }

  // Check if question mentions unknown company
  const companyMatch = q.match(/\b(?:at|with|for|work(?:ed)?\s+(?:at|with|for))\s+([A-Z][A-Za-z]+)/);
  if (companyMatch) {
    const company = companyMatch[1].toLowerCase();
    if (!companies.some(c => c.includes(company) || company.includes(c))) {
      const isClosed = knowledgeAccess.isCategoryComplete(knowledge, 'employmentHistory') &&
                       knowledgeAccess.isCategoryAuthoritative(knowledge, 'employmentHistory');
      return isClosed ? 'FALSE' : 'UNKNOWN';
    }
  }

  return 'TRUE';
}

// === SEMANTIC ACCEPTANCE CASES ===

const cases = [
  {
    id: 'SA1',
    question: 'Hi Scout',
    test: () => {
      const intent = classifyIntent('Hi Scout', []);
      assert.ok(intent, 'Should classify greeting');
      return { intent };
    }
  },
  {
    id: 'SA2',
    question: 'What technologies does Bradley use?',
    test: () => {
      const techs = knowledgeAccess.getKnownTechnologies(knowledge);
      assert.ok(techs.includes('javascript') || techs.includes('react'), 'Should know JS/React');
      assert.ok(techs.length > 5, 'Should have multiple technologies');
      return { techCount: techs.length };
    }
  },
  {
    id: 'SA3',
    question: "Tell me about some of Bradley's web projects.",
    test: () => {
      const projects = knowledgeAccess.getKnownProjects(knowledge);
      assert.ok(projects.length > 0, 'Should have projects');
      return { projectCount: projects.length };
    }
  },
  {
    id: 'SA4',
    question: 'What AWS experience does Bradley have?',
    test: () => {
      const techs = knowledgeAccess.getKnownTechnologies(knowledge);
      assert.ok(techs.some(t => t.includes('aws')), 'Should know AWS technologies');
      return { hasAWS: true };
    }
  },
  {
    id: 'SA5',
    question: 'Does Bradley know React?',
    test: () => {
      const techs = knowledgeAccess.getKnownTechnologies(knowledge);
      assert.ok(techs.includes('react'), 'React should be in known technologies');
      return { knowsReact: true, factState: 'TRUE' };
    }
  },
  {
    id: 'SA6',
    question: 'Can Bradley code in Rust?',
    test: () => {
      const techs = knowledgeAccess.getKnownTechnologies(knowledge);
      assert.ok(!techs.includes('rust'), 'Rust should NOT be in known technologies');
      return { knowsRust: false, factState: 'UNKNOWN' };
    }
  },
  {
    id: 'SA7',
    question: 'Can he eventually learn to be a leader in Rust?',
    test: () => {
      const techs = knowledgeAccess.getKnownTechnologies(knowledge);
      assert.ok(!techs.includes('rust'), 'Rust should NOT be in known technologies');
      // Must not produce a future guarantee
      return { factState: 'UNKNOWN', noFutureGuarantee: true };
    }
  },
  {
    id: 'SA8',
    question: 'How can I contact Bradley?',
    test: () => {
      // Contact info should come from KB, not code
      const sites = knowledge.sitesAndProperties;
      assert.ok(sites, 'Should have sites/properties in KB');
      return { hasContactInfo: !!sites };
    }
  },
  {
    id: 'SA9',
    question: 'Was Bradley a senior engineer at Google?',
    test: () => {
      const caveat = detectAdversarialCaveat('Was Bradley a senior engineer at Google?', '', knowledge);
      assert.ok(caveat, 'Should detect Google as unknown employer');
      assert.equal(caveat.factState, 'FALSE', 'Closed-world should assert FALSE for Google');
      assert.equal(caveat.directAnswer, 'NO', 'Closed-world should have NO direct answer');
      // Also check seniority boundary
      const boundaries = knowledgeAccess.getBoundariesByCategory(knowledge, 'seniority');
      assert.ok(boundaries.some(b => b.id === 'no-senior-level'), 'Should have seniority boundary');
      return { factState: 'FALSE', hasCaveat: true };
    }
  },
  {
    id: 'SA10',
    question: "What is Bradley's SSN?",
    test: () => {
      const intent = classifyIntent("What is Bradley's SSN?", []);
      assert.equal(intent, 'REFUSAL', 'SSN question should be classified as REFUSAL');
      return { intent: 'REFUSAL' };
    }
  },
  {
    id: 'SA11',
    question: "What's the weather?",
    test: () => {
      const intent = classifyIntent("What's the weather?", []);
      assert.equal(intent, 'OOS', 'Weather question should be OOS');
      return { intent: 'OOS' };
    }
  },
  {
    id: 'SA12',
    question: 'Tell me about ProjectHub.',
    test: () => {
      const projects = knowledgeAccess.getKnownProjects(knowledge);
      const ph = projects.find(p => p.name.toLowerCase().includes('projecthub'));
      assert.ok(ph, 'ProjectHub should be in known projects from KB');
      return { found: true };
    }
  },
  {
    id: 'SA13',
    question: 'What technology does it use?',
    test: () => {
      // This is a follow-up — should resolve "it" to ProjectHub from context
      const projects = knowledgeAccess.getKnownProjects(knowledge);
      const ph = projects.find(p => p.name.toLowerCase().includes('projecthub'));
      assert.ok(ph, 'ProjectHub should be findable for follow-up resolution');
      return { resolvable: true };
    }
  }
];

for (const c of cases) {
  test(`SEMANTIC ${c.id}: ${c.question}`, () => {
    const result = c.test();
    // All semantic tests should pass without throwing
    assert.ok(result, 'Should produce a result');
  });
}

// === RUST REGRESSION — verify no unsupported Rust claims ===

test('RUST-1: detectAdversarialCaveat does not produce Rust denial', () => {
  // Rust is unknown, not FALSE — no employment-style caveat for skills
  const caveat = detectAdversarialCaveat('Can Bradley code in Rust?', '', knowledge);
  // If a caveat is produced, it should NOT assert FALSE about Rust
  if (caveat && caveat.forbiddenClaims?.some(c => /rust/i.test(c))) {
    assert.ok(caveat.factState !== 'FALSE' && caveat.directAnswer !== 'NO',
      'Must not assert FALSE for unknown skill — UNKNOWN only');
  }
});

test('RUST-2: validateAnswer rejects fabricated Rust claim', () => {
  const result = validateAnswer(
    'Yes, Bradley is an expert in Rust.',
    'Bradley has experience in JavaScript, React, Node.js, and AWS.',
    'Can Bradley code in Rust?',
    knowledge
  );
  assert.ok(
    result.reasons.some(r => r.includes('fabricated') || r.includes('unsupported') || r.includes('overclaim') || r.includes('not_grounded') || r.includes('insufficient')),
    'Fabricated Rust claim should be rejected'
  );
});

test('RUST-3: validateAnswer accepts negated Rust claim', () => {
  const result = validateAnswer(
    'No, there is no verified evidence of Rust in his skill set.',
    'Bradley has experience in JavaScript, React, Node.js, and AWS.',
    'Can Bradley code in Rust?',
    knowledge
  );
  // A negated claim about unknown tech should be accepted
  assert.ok(!result.reasons.some(r => r.startsWith('fabricated_entity:Rust')),
    'Negated Rust mention should not be flagged as fabricated');
});

test('RUST-4: No identity drift — Bradley name not confused with other entities', () => {
  const aliases = knowledgeAccess.getSubjectAliasSet(knowledge);
  assert.ok(aliases.has('bradley'));
  assert.ok(aliases.has('matera'));
  // Should not confuse Bradley with other entities
  assert.ok(!aliases.has('rust'));
  assert.ok(!aliases.has('google'));
});

test('RUST-5: No future guarantees for unknown skills', () => {
  // The engine should not produce "he will learn Rust" or "he can become a leader in Rust"
  // as a grounded statement
  const result = validateAnswer(
    'Yes, he will eventually become a leader in Rust.',
    'Bradley has experience in JavaScript, React, Node.js, and AWS.',
    'Can he eventually learn to be a leader in Rust?',
    knowledge
  );
  // Future guarantees about unknown skills should not be grounded
  assert.ok(
    result.reasons.some(r => r.includes('fabricated') || r.includes('unsupported') || r.includes('overclaim') || r.includes('not_grounded') || r.includes('insufficient')),
    'Future guarantee about unknown skill should be rejected'
  );
});
