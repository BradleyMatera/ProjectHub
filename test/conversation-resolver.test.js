'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildConversationState, resolveReferent } = require('../lib/conversation-resolver');

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
});
