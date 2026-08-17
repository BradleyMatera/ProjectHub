'use strict';

/**
 * Response Validator
 *
 * Generic response quality and safety validation.
 * No user-facing prose is authored here — only validation of generated text
 * and structured contract state.
 *
 * This module is separate from server-gemini.js so the server remains
 * transport/orchestration only.
 */

const { getBoundaries, getClaimCorrections } = require('./knowledge-access');

const GEN_SLOP = /\b(great question|as an ai|i'?m glad you asked|numerous candidates|excellent opportunity|showcase their|enthusiasm for the field|passion(ate)?|robust|synergy|leverage|dynamic individual|world-class|game.?changer)\b/i;
const GEN_OVERCLAIM = /\b(long history|years of experience|many years|several years|seasoned|expert(ise)? |well.?versed|veteran of|deep experience|extensive|highly experienced|accomplished|proven track record|at the company|this year|last year|currently employed|notable projects across|exceptional|scalable software solutions|highly skilled|mastery|advanced knowledge)\b/i;

// Common capitalized words that don't need to exist in the source facts
const GEN_ENTITY_ALLOWLIST = new Set(['He', 'His', 'Him', 'The', 'A', 'An', 'In', 'On', 'At', 'As', 'With', 'When', 'If', 'For', 'And', 'But', 'Or', 'So', 'To', 'Of', 'By', 'From', 'This', 'That', 'These', 'Those', 'It', 'Its', 'They', 'While', 'Although', 'Because', 'Overall', 'Currently', 'Recently', 'B.S', 'B', 'S', 'U']);

function buildFalseClaimsRegex(knowledge) {
  const patterns = [];
  const boundaries = getBoundaries(knowledge);
  for (const b of boundaries) {
    if (b.triggerPattern) patterns.push(b.triggerPattern.source || b.triggerPattern);
  }
  const corrections = getClaimCorrections(knowledge);
  for (const c of corrections) {
    if (c.triggerPattern) patterns.push(c.triggerPattern.source || c.triggerPattern);
  }
  if (patterns.length === 0) return null;
  try { return new RegExp(patterns.join('|'), 'i'); } catch { return null; }
}

function buildAbortPatterns(subjectNameAlt, assistantName) {
  return [
    /\b(I\b|I'm|I've|my\b|we\b|our\b)/i,
    /\b(great question|as an ai|i'?m glad|excellent opportunity|showcase|enthusiasm|passionate|robust|synergy|leverage|dynamic|world-class|game.?changer)\b/i,
    new RegExp(`"|\\*|pause|${assistantName.toLowerCase()} here|as ${assistantName.toLowerCase()}|hi,|hello,`, 'i'),
    /\b\d{4,}\b/
  ];
}

function shouldAbortGeneration(text, knowledge, subjectNameAlt, assistantName) {
  const GEN_ABORT_PATTERNS = buildAbortPatterns(subjectNameAlt, assistantName);
  if (GEN_ABORT_PATTERNS.some(p => p.test(text))) return true;
  const falseClaimsRe = buildFalseClaimsRegex(knowledge);
  if (falseClaimsRe && falseClaimsRe.test(text)) return true;
  return false;
}

function validateFallbackReply(text, knowledge, subjectNameAlt, assistantName) {
  const t = String(text || '').trim();
  if (t.length < 20 || t.length > 600) return false;
  const falseClaimsRe = buildFalseClaimsRegex(knowledge);
  if (falseClaimsRe && falseClaimsRe.test(t)) return false;
  if (GEN_SLOP.test(t)) return false;
  if (GEN_OVERCLAIM.test(t)) return false;
  if (!new RegExp(`\\b(${subjectNameAlt}|he|his|she|her|they|their)\\b`, 'i').test(t)) return false;
  if (/\b(I|I'm|I've|my|we|our)\b/.test(t)) return false;
  if (new RegExp(`"|\\*|pause|${assistantName.toLowerCase()} here|as ${assistantName.toLowerCase()}|hi,|hello,`, 'i').test(t)) return false;
  if (/^(facts:|q:|question:|answer:|rephrase|text:)/i.test(t)) return false;
  return true;
}

function validateThinkReply(text, source, knowledge, subjectNameAlt, assistantName) {
  const t = String(text || '').trim();
  if (t.length < 25 || t.length > 1200) return { valid: false, reason: 'length' };
  const falseClaimsRe = buildFalseClaimsRegex(knowledge);
  if (falseClaimsRe && falseClaimsRe.test(t)) return { valid: false, reason: 'false-claims' };
  if (GEN_SLOP.test(t)) return { valid: false, reason: 'slop' };
  if (GEN_OVERCLAIM.test(t)) return { valid: false, reason: 'overclaim' };
  if (!new RegExp(`\\b(${subjectNameAlt}|he|his|she|her|they|their)\\b`, 'i').test(t)) return { valid: false, reason: 'no-subject' };
  const sourceText = String(source || '').toLowerCase();
  const genNumbers = t.match(/\d[\d.,]*/g) || [];
  if (genNumbers.some(n => !sourceText.includes(n.toLowerCase()))) return { valid: false, reason: 'hallucinated-number' };
  if (/^(facts:|q:|question:|answer:|rephrase|text:)/i.test(t)) return { valid: false, reason: 'prefix' };
  if (/\?(\s*)$/i.test(t) && /(what would you like|what do you want|what are you interested|what do you mean|could you clarify|tell me more about|let me know)/i.test(t)) return { valid: false, reason: 'evasive' };

  // Data-driven entity check from KB
  const kbEntities = [];
  const k = knowledge || {};
  if (Array.isArray(k.projects)) k.projects.forEach(p => { if (p.name) kbEntities.push(p.name); });
  if (Array.isArray(k.experience)) k.experience.forEach(e => { if (e.company) kbEntities.push(e.company); if (e.role) kbEntities.push(e.role); });
  if (k.skills && typeof k.skills === 'object') {
    for (const vals of Object.values(k.skills)) { if (Array.isArray(vals)) kbEntities.push(...vals); }
  }
  if (Array.isArray(k.certifications)) k.certifications.forEach(c => { if (c.name) kbEntities.push(c.name); });
  const genericTerms = ['project', 'cloud', 'web', 'support', 'debug', 'document', 'customer', 'service', 'team', 'communicat', 'reliab', 'honest', 'gap', 'weakness', 'strength', 'feedback', 'management', 'learn', 'career', 'role', 'skill', 'work', 'experience', 'prefer', 'style', 'adapt', 'collaborat', 'contribut', 'grow', 'mentor', 'intern', 'certif', 'junior'];
  const allTerms = [...kbEntities, ...genericTerms];
  const entityHits = allTerms.filter(e => new RegExp(`\\b${String(e).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t));
  const uniqueHits = new Set(entityHits.map(e => e.toLowerCase()));
  if (uniqueHits.size < 1 && t.length < 100) return { valid: false, reason: 'no-entities' };
  if (/\b(and|or|but)\s+(way|the|a)\b/i.test(t)) return { valid: false, reason: 'garbled' };
  if (/\s{2,}/.test(t)) return { valid: false, reason: 'double-space' };
  if (/\b\w+\s+and\s*$/i.test(t)) return { valid: false, reason: 'trailing-and' };
  return { valid: true, reason: 'ok', entityCount: uniqueHits.size };
}

module.exports = {
  buildFalseClaimsRegex,
  shouldAbortGeneration,
  validateFallbackReply,
  validateThinkReply,
  GEN_SLOP,
  GEN_OVERCLAIM,
  GEN_ENTITY_ALLOWLIST
};
