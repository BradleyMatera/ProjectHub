'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyResponsePolicy, parseClaim } = require('../lib/response-policy-classifier');
const { buildResponseContract, classifySubIntent, determineEvidenceBoundary } = require('../lib/response-contract');
const { classifyIntent } = require('../lib/completeness-check');
const { buildConversationState, resolveReferent } = require('../lib/conversation-resolver');

const bradleyKnowledge = require('../data/recruiter-knowledge.json');

const fixture = {
  identity: { name: 'Alice Chen' },
  projects: [
    { name: 'Sunrise Bakery', tech: ['Python', 'React'], aliases: [] },
    { name: 'CodePenPortfolio', tech: ['JavaScript', 'Three.js'], aliases: [] }
  ],
  skills: ['Python', 'React', 'JavaScript'],
  experience: [{ company: 'Local Co', role: 'Junior Developer' }],
  certifications: [],
  education: []
};

// Helpers
function contract(question, knowledge = bradleyKnowledge, history = []) {
  const evidence = '';
  return buildResponseContract(question, evidence, knowledge, history);
}

describe('Last-four + residual semantics regression', () => {
  it('unknown skill directAnswer is UNKNOWN, not NO', () => {
    const c = contract('Does Bradley know COBOL?', bradleyKnowledge);
    assert.equal(c.directAnswer, 'UNKNOWN', 'unknown skill must be UNKNOWN in open-world');
    assert.equal(c.factState, 'UNKNOWN');
  });

  it('future-capability question is not parsed as an adversarial claim', () => {
    const claim = parseClaim('Could Bradley learn COBOL?', 'Bradley Matera');
    assert.equal(claim, null, 'future-capability questions are not claims about current state');
  });

  it('future-capability question uses FUTURE_CAPABILITY intent/sub-intent', () => {
    const q = 'Could Bradley become a senior frontend engineer?';
    const names = ['Bradley', 'Matera'];
    const intent = classifyIntent(q, names);
    assert.equal(intent, 'FUTURE_CAPABILITY');
    const sub = classifySubIntent(q, intent, bradleyKnowledge, names);
    assert.equal(sub, 'FUTURE_CAPABILITY');
    const c = contract(q, bradleyKnowledge);
    assert.equal(c.factState, 'UNKNOWN', 'future capability has UNKNOWN factState');
    assert.ok(c.requestedRole, 'future target role/skill should be extracted');
  });

  it('resolved-name future-capability detected by classifyIntent', () => {
    const intent = classifyIntent('Could Bradley learn COBOL?', ['Bradley', 'Matera']);
    assert.equal(intent, 'FUTURE_CAPABILITY');
  });

  it('open-world false employer is not denied as FALSE_CLAIM_DENIAL', () => {
    const result = classifyResponsePolicy('Bradley worked at Google, right?', [], bradleyKnowledge);
    assert.notEqual(result.mode, 'FALSE_CLAIM_DENIAL', 'open-world unsupported employer must not be denied');
    const c = contract('Bradley worked at Google, right?', bradleyKnowledge);
    assert.equal(c.directAnswer, 'UNKNOWN', 'open-world unsupported employer must answer UNKNOWN');
  });

  it('META questions resolve to distinct sub-intents', () => {
    const identity = contract('What is your name?', bradleyKnowledge);
    assert.equal(identity.subIntent, 'META_IDENTITY');
    const capabilities = contract('What can you do?', bradleyKnowledge);
    assert.equal(capabilities.subIntent, 'META_CAPABILITIES');
    const infra = contract('What model are you?', bradleyKnowledge);
    assert.equal(infra.subIntent, 'META_INFRASTRUCTURE');
    const privacy = contract('Is my chat private?', bradleyKnowledge);
    assert.equal(privacy.subIntent, 'META_PRIVACY');
    const limits = contract('What can you not do?', bradleyKnowledge);
    assert.equal(limits.subIntent, 'META_LIMITS');
  });

  it('plural referent "them" resolves to discourse objects, not active entity', () => {
    const history = [
      { role: 'user', text: 'What are his weaknesses?' },
      { role: 'assistant', text: 'No public weaknesses are documented. The only gaps are limited professional experience and a few tech areas still being learned.' },
      { role: 'user', text: 'How can he improve them?' }
    ];
    const state = buildConversationState(history, bradleyKnowledge);
    assert.ok(state.discourseObjects.length > 0, 'discourse objects should be extracted');
    const resolved = resolveReferent('How can he improve them?', state, bradleyKnowledge);
    assert.equal(resolved.resolved, true);
    assert.ok(/\b(weaknesses|gaps|areas\s+to\s+improve)\b/.test(resolved.rewrittenQuery),
      `plural "them" should resolve to a discourse object, got: ${resolved.rewrittenQuery}`);
    assert.ok(resolved.referentContext, 'referent should preserve specific claim context');
    assert.ok(resolved.referentContext.includes('limited professional'), `expected claim context, got: ${resolved.referentContext}`);
  });

  it('public phone is CONTACT, not REFUSAL, when identity.phone is present', () => {
    const result = classifyResponsePolicy('What is his phone number?', [], bradleyKnowledge);
    assert.notEqual(result.mode, 'REFUSAL', 'public business phone must not be REFUSAL');
    const c = contract('What is his phone number?', bradleyKnowledge);
    assert.equal(c.intent, 'CONTACT', 'public business phone should be CONTACT');
  });

  it('private/home phone is still REFUSAL', () => {
    const result = classifyResponsePolicy('What is his home phone number?', [], bradleyKnowledge);
    assert.equal(result.mode, 'REFUSAL', 'private/home phone must be REFUSAL');
    const c = contract('What is his home phone number?', bradleyKnowledge);
    assert.equal(c.intent, 'REFUSAL', 'private/home phone contract should remain REFUSAL');
  });

  it('profile/recruiter boundary does not pressure career stage', () => {
    const result = classifyResponsePolicy('Summary for a recruiter', [], bradleyKnowledge);
    assert.ok(!result.boundary.includes('career level'), `boundary should not mention career level: ${result.boundary}`);
    assert.ok(!result.boundary.includes('seniority'), `boundary should not pressure seniority: ${result.boundary}`);
  });

  it('future-capability in recovery-contract is not treated as adversarial', () => {
    const { detectAdversarialContract } = require('../lib/recovery-contract');
    const result = detectAdversarialContract('Could Bradley learn COBOL?', bradleyKnowledge, '');
    assert.equal(result, null, 'future-capability question must not produce an adversarial denial contract');
  });

  it('evidence-strength boundary depends on evidence, not career stage', () => {
    const senior = { identity: { name: 'Senior Dev' }, summary: { whoIAm: 'Senior software engineer with 10 years of production experience.' }, projects: [] };
    const mid = { identity: { name: 'Mid Dev' }, summary: { whoIAm: 'Mid-level full-stack developer.' }, projects: [] };
    const entry = { identity: { name: 'Entry Dev' }, summary: { whoIAm: 'Entry-level software engineer focused on JavaScript.' }, projects: [] };
    assert.ok(determineEvidenceBoundary('PROJECT', senior), 'PROJECT boundary must apply to senior tenant');
    assert.ok(determineEvidenceBoundary('INTERNSHIP', mid), 'INTERNSHIP boundary must apply to mid tenant');
    assert.ok(determineEvidenceBoundary('PROJECT', entry), 'PROJECT boundary must apply to entry tenant');
    assert.equal(determineEvidenceBoundary('PROFESSIONAL', senior), null, 'PROFESSIONAL evidence has no boundary');
    assert.equal(determineEvidenceBoundary('PROFESSIONAL', entry), null, 'PROFESSIONAL evidence has no boundary for entry tenant either');
  });

  it('plural referent "them" resolves to skill-set with specific skills', () => {
    const history = [
      { role: 'user', text: 'What are his strongest skills?' },
      { role: 'assistant', text: 'His strongest skills are JavaScript, React, and Node.js.' },
      { role: 'user', text: 'Which of them came from projects?' }
    ];
    const state = buildConversationState(history, bradleyKnowledge);
    const resolved = resolveReferent('Which of them came from projects?', state, bradleyKnowledge);
    assert.equal(resolved.resolved, true, 'should resolve plural referent');
    assert.ok(/\bskills\b/.test(resolved.rewrittenQuery), `should resolve to skills, got: ${resolved.rewrittenQuery}`);
    assert.ok(resolved.rewrittenQuery.includes('JavaScript'), 'should preserve which skills');
    assert.ok(resolved.rewrittenQuery.includes('React'), 'should preserve which skills');
  });

  it('plural referent "them" resolves to project-set with named projects', () => {
    const history = [
      { role: 'user', text: 'Tell me about ProjectHub and CIRIS.' },
      { role: 'assistant', text: 'ProjectHub is a vanilla JavaScript widget and CIRIS is an ethical AI project.' },
      { role: 'user', text: 'Which of them used TypeScript?' }
    ];
    const state = buildConversationState(history, bradleyKnowledge);
    const resolved = resolveReferent('Which of them used TypeScript?', state, bradleyKnowledge);
    assert.equal(resolved.resolved, true, 'should resolve plural referent');
    assert.ok(/\bprojects\b/.test(resolved.rewrittenQuery), `should resolve to project set, got: ${resolved.rewrittenQuery}`);
    assert.ok(resolved.rewrittenQuery.includes('ProjectHub'), 'should preserve ProjectHub');
    assert.ok(resolved.rewrittenQuery.includes('CIRIS'), 'should preserve CIRIS');
  });
});
