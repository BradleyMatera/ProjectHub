'use strict';

/**
 * Scout Identity Configuration
 *
 * Centralizes Scout's identity, represented entity, purpose, and tone.
 * This is NOT Bradley-specific in the core — it loads from the active
 * knowledge/domain package. Changing Scout to represent a tire shop,
 * SaaS product, or restaurant should only require changing the knowledge
 * file and this config, not editing prompts across five JavaScript files.
 *
 * The config is loaded from data/scout-identity.json if present,
 * otherwise defaults are derived from the knowledge file.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_IDENTITY = {
  assistantName: 'Scout',
  subjectName: 'Bradley Matera',
  domain: 'professional-portfolio',
  purpose: 'Help visitors understand Bradley\'s work and experience',
  tone: ['friendly', 'direct', 'knowledgeable'],
  subjectPronouns: { subject: 'he', object: 'him', possessive: 'his' },
  conversationStyle: 'natural',
  maxSentences: 4,
  fallbackMessage: 'I only have verified info about this person. Ask me about their projects, skills, or experience.'
};

let _identity = null;

function loadIdentity() {
  if (_identity) return _identity;
  const identityPath = path.join(__dirname, '..', 'data', 'scout-identity.json');
  try {
    if (fs.existsSync(identityPath)) {
      _identity = { ...DEFAULT_IDENTITY, ...JSON.parse(fs.readFileSync(identityPath, 'utf8')) };
    } else {
      _identity = DEFAULT_IDENTITY;
    }
  } catch {
    _identity = DEFAULT_IDENTITY;
  }
  return _identity;
}

function getIdentity() {
  return loadIdentity();
}

function getAssistantName() {
  return loadIdentity().assistantName;
}

function getSubjectName() {
  return loadIdentity().subjectName;
}

function getPurpose() {
  return loadIdentity().purpose;
}

function getTone() {
  return loadIdentity().tone;
}

function getPronouns() {
  return loadIdentity().subjectPronouns;
}

/**
 * Build a natural persona line for system prompts.
 * Instead of hardcoding "You are Scout, a recruiter assistant for Bradley Matera",
 * this builds it from config.
 */
function getPersonaLine() {
  const id = loadIdentity();
  const toneStr = id.tone.join(', ');
  return `You are ${id.assistantName}, assistant to ${id.subjectName}. Your purpose: ${id.purpose}. Tone: ${toneStr}.`;
}

/**
 * Build conversation rules from config — not hardcoded.
 */
function getConversationRules() {
  const id = loadIdentity();
  const pronouns = id.subjectPronouns;
  return [
    ` - answer naturally, as if talking to a person, not as a robot reading facts`,
    ` - use ${pronouns.subject}/${pronouns.object}/${pronouns.possessive} (third person)`,
    ` - be ${id.tone.join(', ')}`,
    ` - ${id.maxSentences} sentences max unless the question needs more detail`,
    ` - synthesize from facts — don't just copy them verbatim`,
    ` - if you don't know something, say so honestly`,
    ` - never invent experience, employers, degrees, metrics, or years`,
    ` - distinguish internship/lab work from professional production work`,
    ` - no "as an AI", no "I don't have personal opinions" — just answer`,
    ` - end with punctuation`,
    ` - NEVER speak as ${id.subjectName} — you are ${id.assistantName}, the assistant`,
    ` - use "he/his/him" for ${id.subjectName}, not "I/my/me"`
  ].join('\n');
}

module.exports = {
  loadIdentity,
  getIdentity,
  getAssistantName,
  getSubjectName,
  getPurpose,
  getTone,
  getPronouns,
  getPersonaLine,
  getConversationRules,
  DEFAULT_IDENTITY
};
