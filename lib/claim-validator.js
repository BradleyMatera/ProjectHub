'use strict';

// Structured claim-type validator.
//
// Detects and validates claim classes in generated answers against the
// response contract, the question, the evidence, and the knowledge graph.
//
// This module is intentionally generic and tenant-agnostic. It does not contain
// Bradley-specific strings. Tenant-specific names come from the knowledge object.

const { getKnownTechnologies } = require('./knowledge-access');
const scoutIdentity = require('./scout-identity');

const NEGATIVE_TRAIT_RE = /\b(?:bad\s+at|poor\s+at|weak\s+at|weak\s+in|not\s+good\s+at|not\s+strong\s+at|struggles?\s+(?:with|in)|struggling\s+(?:with|in)|terrible\s+at|awful\s+at|inconsistent(?:ly)?|unreliable|lazy|unmotivated|slow|careless|disorganized|poor\s+communicator|difficult\s+to\s+work\s+with|doesn't\s+ship|does not\s+ship)\b/i;

const SELF_LEARNING_RE = /\b(?:learn(?:s|ed|ing)?(?:\s+and\s+improve(?:s|d)?)?\s+from\s+(?:my\s+|our\s+|your\s+|these\s+)?(?:you|users|conversations|interactions|questions|chats)|improves?\s+(?:itself|myself|over\s+time|with\s+each\s+conversation)|gets\s+better\s+over\s+time|trains?\s+(?:itself|myself)|self[- ]?learning|autonomous\s+learning|background\s+learning|learns\s+and\s+grows|constantly\s+learning|learns\s+from\s+feedback)\b/i;

const GENERIC_ASSISTANT_RE = /\bI\s+am\s+(?:an?\s+)?(?:AI\s+)?(?:virtual\s+)?(?:assistant|AI)\b/i;
const OTHER_ASSISTANT_RE = /\b(?:chatgpt|gpt[- ]?4|openai|claude|gemini|copilot)\b/i;

const PROFICIENCY_RE = /\b(?:expert|mastery|master(?:ed|y)|deep\s+knowledge|deep\s+expertise|proficient|highly\s+skilled|very\s+experienced|seasoned|veteran|professional(?:-level)?\s+(?:experience|mastery)|years\s+of\s+experience)\b/i;

const ROLE_TITLE_RE = /\b(?:worked\s+as|was\s+a|is\s+a|has\s+experience\s+as|served\s+as|employed\s+as|acted\s+as)\s+(?:a\s+)?([A-Z][A-Za-z\s]+?)(?:\s+(?:at|for|with|in|and)\b|$|[,.!?;])/i;

const EMPLOYMENT_RE = /\b(?:worked\s+(?:at|for|with)|was\s+(?:employed|hired)\s+(?:at|by)|has\s+worked\s+(?:at|for)|joined)\s+([A-Z][A-Za-z0-9\s&]+)/i;

const CURRENT_EMPLOYMENT_RE = /\b(?:is\s+(?:currently\s+)?(?:a\s+)?(?:\w+\s+)?(?:at|with|for)\s+|works\s+(?:currently\s+)?(?:at|with|for)\s+|is\s+now\s+(?:a\s+)?\w+\s+at|currently\s+works\s+(?:at|for|with))\b/i;

const PROJECT_RELATIONSHIP_RE = /\b(?:uses?|used|uses?\s+for\s+charts|uses?\s+for\s+visualization|uses?\s+for\s+graphs|built\s+with|built\s+using|implemented\s+with|uses?\s+the\s+)?([A-Z][A-Za-z0-9\s]+?)\s+(?:for\s+(?:charts|graphs|visualization)|with\s+(?:charts|graphs|visualization))/i;

function getKnownEntitiesSet(knowledge) {
  const set = new Set();
  if (!knowledge) return set;
  for (const p of (knowledge.projects || [])) {
    set.add(String(p.name || '').toLowerCase());
    for (const a of (p.aliases || [])) set.add(String(a).toLowerCase());
    for (const t of (p.tech || [])) set.add(String(t).toLowerCase());
  }
  for (const e of (knowledge.experience || [])) {
    set.add(String(e.company || '').toLowerCase());
    set.add(String(e.role || '').toLowerCase());
  }
  for (const c of (knowledge.certifications || [])) set.add(String(c.name || '').toLowerCase());
  for (const s of Object.values(knowledge.skills || {}).flat()) set.add(String(s).toLowerCase());
  return set;
}

function containsKnownEntity(text, knowledge) {
  const set = getKnownEntitiesSet(knowledge);
  const tokens = text.toLowerCase().split(/[^a-z0-9+#.]+/);
  for (const t of tokens) if (set.has(t)) return true;
  // multi-word match
  const lowered = text.toLowerCase();
  for (const e of set) if (e.includes(' ') && lowered.includes(e)) return true;
  return false;
}

function isEntityInEvidence(entity, evidenceText) {
  if (!entity || !evidenceText) return false;
  const e = entity.toLowerCase().trim();
  const ev = evidenceText.toLowerCase();
  if (ev.includes(e)) return true;
  const parts = e.split(/[^a-z0-9]+/).filter(Boolean);
  return parts.length > 0 && parts.every(p => ev.includes(p));
}

function hasVerifiedSkill(skill, knowledge, evidenceText) {
  if (!skill) return false;
  const lowerSkill = skill.toLowerCase();
  const known = new Set([...getKnownTechnologies(knowledge)].map(t => t.toLowerCase()));
  if (known.has(lowerSkill) && evidenceText && evidenceText.toLowerCase().includes(lowerSkill)) return true;
  return false;
}

/**
 * Validate a generated answer against claim classes.
 * @param {string} answer
 * @param {string} question
 * @param {object} contract - response contract from buildResponseContract
 * @param {string} evidenceText - concatenated source evidence
 * @param {object} knowledge
 * @returns {Array<{type:string, detail:string}>} invalid claims; empty if clean
 */
function validateClaims(answer, question, contract, evidenceText, knowledge) {
  const text = String(answer || '');
  const q = String(question || '').toLowerCase();
  const invalid = [];
  const policyMode = contract?.policyMode || contract?.mode || null;
  const evidenceStrength = contract?.evidenceStrength || null;

  // 1. Assistant identity claims
  const IDENTITY_QUESTION_RE = /\b(?:your\s+name|who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do|are\s+you\s+(?:an?\s+)?(?:ai|assistant)|which\s+assistant\s+are\s+you)\b/i;
  if (policyMode === 'META' || policyMode === 'META_IDENTITY' || IDENTITY_QUESTION_RE.test(q)) {
    const name = scoutIdentity.getAssistantName() || knowledge?.agent?.name || 'Scout';
    const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (!nameRe.test(text)) {
      invalid.push({ type: 'ASSISTANT_IDENTITY_CLAIM', detail: `Answer must identify assistant as ${name}` });
    }
    if (SELF_LEARNING_RE.test(text)) {
      invalid.push({ type: 'ASSISTANT_IDENTITY_CLAIM', detail: 'Answer claims unsupported self-learning/improvement' });
    }
    if (OTHER_ASSISTANT_RE.test(text)) {
      invalid.push({ type: 'ASSISTANT_IDENTITY_CLAIM', detail: 'Answer uses another assistant identity' });
    }
    if (GENERIC_ASSISTANT_RE.test(text)) {
      invalid.push({ type: 'ASSISTANT_IDENTITY_CLAIM', detail: 'Answer uses generic "I am an assistant" identity instead of the configured name' });
    }
  }

  // 2. Negative personal/professional trait claims
  if (NEGATIVE_TRAIT_RE.test(text)) {
    // Only allowed if the question explicitly asks for a negative assessment AND
    // the contract's factState is not UNKNOWN and the evidence supports the named trait.
    const isNegativeQuestion = /\b(?:bad\s+at|weak(?:ness)?|gaps?|what\s+is\s+he\s+bad\s+at|negative|struggles?\s+with)\b/i.test(q);
    const sentence = text.split(/[.!?]+/).find(s => NEGATIVE_TRAIT_RE.test(s)) || text;
    const matches = sentence.match(NEGATIVE_TRAIT_RE) || [];
    for (const m of matches) {
      const trait = m.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!isNegativeQuestion || !isEntityInEvidence(trait, evidenceText)) {
        invalid.push({ type: 'NEGATIVE_PERSONAL_CLAIM', detail: `Unsupported negative trait: ${m}` });
      }
    }
  }

  // 3. Role/title claims
  const roleMatch = text.match(ROLE_TITLE_RE);
  if (roleMatch) {
    const claimedRole = roleMatch[1].trim();
    const requestedRole = contract?.requestedRole;
    // If the question is about fit/could he do X, the claimed role may be the requested target,
    // not a historical fact. A historical "has experience as X" claim is only allowed if
    // evidence documents that exact role.
    const isFitQuestion = /\b(?:fit|would\s+he|could\s+he|should\s+he)\b/i.test(q);
    const isHistoricalClaim = /\b(?:worked\s+as|was\s+a|has\s+experience\s+as|served\s+as|employed\s+as)\b/i.test(text);
    if (isHistoricalClaim) {
      if (!isEntityInEvidence(claimedRole, evidenceText)) {
        invalid.push({ type: 'ROLE_TITLE_CLAIM', detail: `Historical role/title not in evidence: ${claimedRole}` });
      }
      // Even if requested, a fit answer must not imply he held the role.
      if (isFitQuestion) {
        invalid.push({ type: 'ROLE_TITLE_CLAIM', detail: `Fit answer fabricated historical employment as ${claimedRole}` });
      }
    }
  }

  // 4. Employment claims
  const empMatch = text.match(EMPLOYMENT_RE);
  if (empMatch) {
    const company = empMatch[1].trim();
    if (!containsKnownEntity(company, knowledge)) {
      invalid.push({ type: 'EMPLOYMENT_CLAIM', detail: `Unsupported employer claim: ${company}` });
    }
  }

  // 5. Current/temporal claims
  if (CURRENT_EMPLOYMENT_RE.test(text) && !isEntityInEvidence('current', evidenceText)) {
    invalid.push({ type: 'CURRENT_TEMPORAL_CLAIM', detail: 'Unsupported current employment claim' });
  }

  // 6. Proficiency claims from weak evidence
  const profMatch = text.match(PROFICIENCY_RE);
  if (profMatch) {
    if (evidenceStrength === 'PROJECT' || evidenceStrength === 'INTERNSHIP' || evidenceStrength === 'EDUCATION' || evidenceStrength === 'UNKNOWN') {
      invalid.push({ type: 'PROFICIENCY_CLAIM', detail: `Proficiency/expertise claim with evidence strength ${evidenceStrength}: ${profMatch[0]}` });
    }
  }

  // 7. Skill claims for unknown technologies
  const requestedTopic = contract?.requestedTopic;
  if (requestedTopic && !hasVerifiedSkill(requestedTopic, knowledge, evidenceText)) {
    // If the answer affirms skill/proficiency but no verified evidence, flag.
    if (/\b(?:has\s+experience|knows?|proficient|skilled|good\s+at|strong\s+in|uses?\s+professionally)\b/i.test(text)) {
      invalid.push({ type: 'SKILL_CLAIM', detail: `Skill/proficiency claim for unverified topic: ${requestedTopic}` });
    }
  }

  // 8. OUT_OF_SCOPE material claims
  if (policyMode === 'OUT_OF_SCOPE' || policyMode === 'REFUSAL') {
    if (containsKnownEntity(text, knowledge) || hasVerifiedSkill(text, knowledge, evidenceText)) {
      // Out-of-scope/refusal answers should not make candidate-biography assertions.
      // We only flag if the answer asserts a candidate fact, not a generic boundary.
      if (/\b(?:is\s+a|was\s+a|has\s+|does\s+|did\s+|worked\s+|built\s+|knows\s+|uses?\s+)\b/i.test(text) && text.length > 40) {
        invalid.push({ type: 'OUT_OF_SCOPE_CLAIM', detail: 'OUT_OF_SCOPE/refusal answer contains candidate factual assertions' });
      }
    }
  }

  return invalid;
}

module.exports = {
  validateClaims,
};
