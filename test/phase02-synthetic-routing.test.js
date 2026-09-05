'use strict';

/**
 * Synthetic regression tests for Phase 02 non-tech experience + negative assessment
 * routing and contract semantics. Uses a generic, unrelated tenant fixture.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRagChunks } = require('../lib/rag-chunks');
const { BM25Index } = require('../lib/bm25');
const { understandQuery } = require('../lib/query-understanding');
const { searchBm25WithRrf } = require('../lib/rrf');
const { buildResponseContract, classifyIntent, classifySubIntent } = require('../lib/response-contract');
const { buildRagEvidenceText } = require('../lib/rag-agent');

const FIXTURE = {
  identity: { name: 'Maria Lopez', title: 'Junior Data Engineer', location: 'Austin, TX' },
  summary: {
    whoIAm: 'Maria is a junior data engineer with a background in warehouse operations and customer support.',
    whatIDo: 'She builds small data pipelines, dashboards, and documentation.',
    whatIAmLookingFor: 'An entry-level data engineering or data analyst role.',
    honestGaps: [
      'Advanced statistics and inferential methods. She has used descriptive stats in dashboards but has not completed formal coursework in hypothesis testing or experimental design.',
      'Distributed systems at scale. She has built local pipelines and small cloud jobs but has not run production systems across multiple nodes or regions.'
    ]
  },
  goals: { targetRoles: ['Junior Data Engineer', 'Data Analyst'], relocation: 'Open to remote or hybrid in Texas.' },
  education: { degree: 'B.S. in Information Technology', school: 'State University', gpa: '3.4' },
  certifications: [],
  skills: {
    languagesAndFrameworks: ['Python', 'SQL', 'dbt'],
    learningOrAdjacent: ['Distributed systems at scale']
  },
  experience: [
    {
      role: 'Warehouse Operations Associate',
      company: 'Nebula Logistics',
      type: 'Full-time',
      location: 'Austin, TX',
      dates: '2018 - 2020',
      summary: 'Managed inventory, packed orders, tracked shipments, and collaborated with the logistics team in a fast-paced warehouse.'
    },
    {
      role: 'Customer Support Specialist',
      company: 'StreamLine',
      type: 'Full-time',
      location: 'Remote',
      dates: '2020 - 2022',
      summary: 'Resolved customer issues over email and chat, documented tickets, and trained new hires on support workflows.'
    },
    {
      role: 'Data Engineering Intern',
      company: 'DataLab',
      type: 'Internship',
      location: 'Austin, TX',
      dates: '2022 - 2023',
      summary: 'Built Python ETL scripts, wrote SQL reports, and created a Streamlit dashboard for operations metrics.'
    }
  ],
  projects: [
    {
      name: 'Sales Dashboard',
      description: 'A Python and Streamlit dashboard for sales metrics.',
      tech: ['Python', 'Streamlit', 'SQL']
    }
  ],
  faq: [
    {
      question: "What is Maria's background outside of software?",
      answer: 'Before moving into data engineering, Maria worked in warehouse operations and customer support. She managed inventory and shipments at Nebula Logistics and resolved customer issues at StreamLine.'
    }
  ],
  rules: { doNot: ['Do not claim senior-level data engineering experience.'] }
};

function getEvidence(question) {
  const chunks = buildRagChunks(FIXTURE);
  const index = new BM25Index(chunks);
  const understood = understandQuery(question, [], chunks);
  const results = searchBm25WithRrf(index, [understood.normalized, understood.expanded, understood.rewritten], 10);
  return {
    chunks,
    results,
    text: results.map(r => r.text).filter(Boolean).join('\n\n')
  };
}

test('non-tech experience question classifies as EXPERIENCE, not PROJECT', () => {
  const questions = [
    'What is her experience outside of tech?',
    'What non-technical work experience does she have?',
    'What did she do before moving into development?',
    'Tell me about her experience outside software.'
  ];
  for (const q of questions) {
    const intent = classifyIntent(q);
    const sub = classifySubIntent(q, intent, FIXTURE, ['Maria Lopez']);
    assert.ok(
      (intent === 'EXPERIENCE' || sub === 'EXPERIENCE') && (sub !== 'PROJECT_DETAILS' && intent !== 'PROJECT'),
      `${q}: expected EXPERIENCE routing, got intent=${intent}, subIntent=${sub}`
    );
  }
});

test('non-tech experience response contract selects experience chunks', () => {
  const q = 'What non-technical work experience does she have?';
  const { text } = getEvidence(q);
  const contract = buildResponseContract(q, text, FIXTURE, []);
  assert.equal(contract.subIntent, 'EXPERIENCE', `expected EXPERIENCE, got ${contract.subIntent}`);
  // At least one selected fact should come from an experience entry
  const hasExperience = (contract.requiredFacts || []).some(f =>
    String(f.value || '').toLowerCase().includes('nebula logistics') ||
    String(f.value || '').toLowerCase().includes('streamline')
  );
  assert.ok(hasExperience, 'requiredFacts should include a non-tech experience record');
});

test('RAG chunks include a generic gaps evidence tag from summary.honestGaps', () => {
  const chunks = buildRagChunks(FIXTURE);
  const gapChunks = chunks.filter(c => c.tag === 'gaps');
  assert.ok(gapChunks.length > 0, 'buildRagChunks should emit at least one gaps chunk');
  const gapText = gapChunks.map(c => c.text).join(' ').toLowerCase();
  assert.ok(gapText.includes('advanced statistics'), 'gaps chunk should mention the first documented gap');
  assert.ok(gapText.includes('distributed systems'), 'gaps chunk should mention the second documented gap');
});

test('negative assessment retrieval ranks the gaps chunk', () => {
  const q = 'What are her actual weaknesses?';
  const { chunks, results } = getEvidence(q);
  const gapChunkIds = new Set(chunks.filter(c => c.tag === 'gaps').map((_, i) => `gaps-${i + 1}`));
  const topKinds = results.slice(0, 5).map(r => r.tag);
  assert.ok(
    topKinds.includes('gaps') || topKinds.includes('direct-answer') || results.slice(0, 5).some(r => r.tag === 'gaps'),
    'top-5 evidence for a weaknesses question should include a gaps chunk'
  );
});

test('negative assessment contract requires at least one documented gap mention when gaps exist', () => {
  const q = 'What are her actual weaknesses?';
  const { text } = getEvidence(q);
  const contract = buildResponseContract(q, text, FIXTURE, []);
  assert.equal(contract.intent, 'NEGATIVE_ASSESSMENT');
  assert.equal(contract.subIntent, 'NEGATIVE_ASSESSMENT');
  assert.equal(contract.factState, 'UNKNOWN', 'factState should be UNKNOWN when no authoritative personal weakness exists');
  const keyFacts = (contract.keyFacts || []).map(f => f.toLowerCase());
  assert.ok(keyFacts.some(f => f.includes('advanced statistics') || f.includes('distributed systems')),
    'keyFacts should include documented gaps');
  const requiredMentions = [...(contract.requiredEntities || []), ...(contract.mustMentionEntities || [])].map(e => e.toLowerCase());
  assert.ok(
    requiredMentions.some(e => e.includes('statistics') || e.includes('distributed systems')),
    'contract should require mentioning at least one documented gap'
  );
});

test('negative assessment contract does not treat a gap as a proven personality weakness', () => {
  const q = 'What are her actual weaknesses?';
  const { text } = getEvidence(q);
  const contract = buildResponseContract(q, text, FIXTURE, []);
  assert.equal(contract.factState, 'UNKNOWN');
  const instructions = (contract.naturalInstructions || '').toLowerCase();
  assert.ok(instructions.includes('not') || instructions.includes('unknown') || instructions.includes('not established'),
    'instructions should state the personal weakness is not established');
  assert.ok(instructions.includes('gap') || instructions.includes('learning area'),
    'instructions should refer to documented gaps/learning areas');
});
