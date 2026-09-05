'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildConversationState, resolveReferent } = require('../lib/conversation-resolver');

const roleFixture = {
  identity: { name: 'Morgan Vale' },
  projects: [],
  skills: [],
  experience: []
};

const fixture = {
  identity: { name: 'Jane Smith' },
  projects: [
    { name: 'ChurnPredictor', tech: ['Python', 'scikit-learn'], description: 'ML model predicting customer churn' },
    { name: 'SalesDashboard', tech: ['R', 'Shiny'], description: 'Interactive sales analytics dashboard' }
  ],
  skills: {
    languagesAndFrameworks: ['Python', 'R', 'SQL'],
    toolsAndWorkflows: ['Git', 'Docker']
  },
  experience: [
    { company: 'TechCorp' }
  ]
};

describe('Conversation resolver active-entity selection', () => {
  it('keeps a user-mentioned project as the active referent even when the assistant lists skills later', () => {
    const history = [
      { role: 'user', text: 'Tell me about ChurnPredictor' },
      { role: 'assistant', text: 'ChurnPredictor is a machine learning project. It uses Python, scikit-learn, Git, and Docker.' }
    ];
    const state = buildConversationState(history, fixture);
    assert.equal(state.activeEntity?.name, 'ChurnPredictor', 'Active entity should remain the user-mentioned project');

    const resolved = resolveReferent('What tech does it use?', state, fixture);
    assert.equal(resolved.entity, 'ChurnPredictor');
    assert.ok(resolved.rewrittenQuery.includes('ChurnPredictor'));
  });

  it('resolves "the other one" to a different project from the user mention', () => {
    const history = [
      { role: 'user', text: 'Tell me about ChurnPredictor' },
      { role: 'assistant', text: 'ChurnPredictor is an ML project.' },
      { role: 'user', text: 'What about the other one?' }
    ];
    const state = buildConversationState(history, fixture);
    const resolved = resolveReferent('What about the other one?', state, fixture);
    assert.equal(resolved.entity, 'SalesDashboard');
  });

  it('preserves assistant attribution in paired history so an aside cannot steal a user project', () => {
    const history = [{
      user: 'Tell me about ChurnPredictor',
      assistant: 'SalesDashboard uses R. Its strengths are clear visualizations.'
    }];
    const state = buildConversationState(history, fixture);
    assert.equal(state.activeEntity.name, 'ChurnPredictor');
    assert.equal(state.discourseObjects.find(object => object.name === 'strengths').source, 'assistant');
  });
});

describe('Conversation resolver explicit role comparisons', () => {
  const cases = [
    ['junior accounting specialist', 'customer support', 'payroll'],
    ['museum archivist', 'visitor services', 'collections management'],
    ['junior frontend developer', 'DevOps', 'QA']
  ];

  for (const titles of cases) {
    for (const format of ['paired', 'role']) {
      it(`keeps explicit ${titles.join('/')} targets in ${format} history`, () => {
        const pairs = [
          { user: `I am hiring for a ${titles[0]}. Is he a fit?`, assistant: 'Morgan has relevant project experience.' },
          { user: `What about a ${titles[1]} role?`, assistant: 'Please try again or rephrase your question.' },
          {
            user: `And a ${titles[2]} role?`,
            assistant: 'There are gaps in his documented skills for this role, as the evidence does not provide clear information on his proficiency in this area.'
          }
        ];
        const question = 'Which of those is the strongest fit?';
        const history = format === 'paired' ? pairs : [
          ...pairs.flatMap(pair => [{ role: 'user', text: pair.user }, { role: 'assistant', text: pair.assistant }]),
          { role: 'user', text: question }
        ];
        const before = JSON.stringify(history);
        const state = buildConversationState(history, roleFixture);
        assert.deepEqual(state.roleTargets.map(target => target.name), titles);
        const resolved = resolveReferent(question, state, roleFixture);
        assert.equal(resolved.rewrittenQuery, `Which of those roles (${titles.join(' and ')}) is the strongest fit?`);
        assert.equal(resolved.referentContext, titles.join(' and '));
        assert.doesNotMatch(resolved.rewrittenQuery, /evidence|proficiency|gaps/);
        assert.equal(JSON.stringify(history), before);
      });
    }
  }

  it('does not turn assistant role suggestions or assessment clauses into targets', () => {
    const state = buildConversationState([
      { user: 'What are his skills?', assistant: 'Consider hiring for a compliance auditor. This role, because there is no evidence, may be a fit.' },
      { user: 'Which of those is the best fit?', assistant: 'The role is unclear.' }
    ], roleFixture);
    assert.deepEqual(state.roleTargets, []);
    assert.equal(state.discourseObjects.some(object => object.type === 'role-set'), false);
    const result = resolveReferent('Which of those is the best fit?', state, roleFixture);
    assert.equal(result.resolved, false);
    assert.equal(result.referentType, 'unresolved');
    assert.equal(result.rewrittenQuery, 'Which of those is the best fit?');
  });

  it('leaves a plural comparison unresolved with no targets or only one explicit target', () => {
    for (const history of [[], [{ user: 'What about an accounting role?', assistant: 'This role has gaps in his skills.' }]]) {
      const result = resolveReferent('Which of them is a better fit?', buildConversationState(history, roleFixture), roleFixture);
      assert.equal(result.resolved, false);
      assert.equal(result.referentType, 'unresolved');
      assert.equal(result.rewrittenQuery, 'Which of them is a better fit?');
    }
  });

  it('extracts bounded titles and deduplicates them without capturing qualifications or prose', () => {
    const state = buildConversationState([
      { user: 'We are recruiting for a financial analyst with budgeting experience. Is he qualified?', assistant: 'There is limited evidence.' },
      { user: 'Is he suited for a customer support position?', assistant: 'Unknown.' },
      { user: 'What about a Financial Analyst role?', assistant: 'Unknown.' },
      { user: 'What is your role? Is that a good fit for him?', assistant: 'I am the assistant.' }
    ], roleFixture);
    assert.deepEqual(state.roleTargets.map(target => target.name), ['financial analyst', 'customer support']);
  });

  it('extracts explicit role lists without a tenant-specific role vocabulary', () => {
    const state = buildConversationState([
      { role: 'user', text: 'Compare accounting, customer support, and payroll roles.' }
    ], roleFixture);
    assert.deepEqual(state.roleTargets.map(target => target.name), ['accounting', 'customer support', 'payroll']);
    const result = resolveReferent('Which of these would be the best fit?', state, roleFixture);
    assert.equal(result.referentContext, 'accounting and customer support and payroll');
  });

  it('prefers requested roles over incidental project comparisons while preserving subject and agent roles', () => {
    const history = [
      { user: 'I am hiring for an accounting specialist.', assistant: 'ChurnPredictor and SalesDashboard show relevant skills.' },
      { user: 'How about a customer support role?', assistant: 'Both projects may help.' }
    ];
    const knowledge = { ...fixture, identity: roleFixture.identity };
    const state = buildConversationState(history, knowledge);
    const subject = resolveReferent('Which of those is the best fit for him?', state, knowledge);
    assert.equal(subject.rewrittenQuery, 'Which of those roles (accounting specialist and customer support) is the best fit for Morgan?');
    const agent = resolveReferent('Which of those do you think is the best fit?', state, knowledge);
    assert.equal(agent.rewrittenQuery, 'Which of those roles (accounting specialist and customer support) do you think is the best fit?');
    assert.equal(state.comparisonEntities.length, 2);
    assert.equal(state.activeEntity.name, 'ChurnPredictor');
  });
});
