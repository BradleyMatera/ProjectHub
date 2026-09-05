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
const { evidenceSupportsTechnologyRelation, phraseAppears } = require('./evidence-relations');
const { canonicalize: canonicalizeTech, resolveAlias: resolveTechAlias } = require('./tech-claim-validator');
const { isTokenNegated } = require('./negation-scope');

const NEGATIVE_TRAIT_RE = /\b(?:bad\s+at|poor\s+at|weak\s+at|weak\s+in|not\s+good\s+at|not\s+strong\s+at|struggles?\s+(?:with|in)|struggling\s+(?:with|in)|terrible\s+at|awful\s+at|inconsistent(?:ly)?|unreliable|lazy|unmotivated|slow|careless|disorganized|poor\s+communicator|difficult\s+to\s+work\s+with|doesn't\s+ship|does not\s+ship|(?:a|his|the|key|main|primary|greatest|worst)\s+(?:key\s+)?weakness(?:es)?|lacks?\s+(?:the\s+)?experience\s+(?:with|in|of)|lacks?\s+(?:the\s+)?(?:skill|skills|ability)\s+(?:to|for|with))\b/i;

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

function normalizeText(text) { return String(text || '').toLowerCase().trim(); }

function getKnownEmployers(knowledge) {
  return new Set((knowledge?.experience || []).map(e => normalizeText(e.company)).filter(Boolean));
}

function getKnownRoles(knowledge) {
  return new Set((knowledge?.experience || []).map(e => normalizeText(e.role)).filter(Boolean));
}

function getKnownProjects(knowledge) {
  const set = new Set();
  for (const p of (knowledge?.projects || [])) {
    set.add(normalizeText(p.name));
    for (const a of (p.aliases || [])) set.add(normalizeText(a));
  }
  return set;
}

function getKnownSkills(knowledge) {
  const set = new Set();
  for (const s of Object.values(knowledge?.skills || {}).flat()) set.add(normalizeText(s));
  for (const p of (knowledge?.projects || [])) for (const t of (p.tech || [])) set.add(normalizeText(t));
  return set;
}

function getKnownCerts(knowledge) {
  return new Set((knowledge?.certifications || []).map(c => normalizeText(c.name)).filter(Boolean));
}

function isKnownOfType(text, set) {
  const lower = normalizeText(text);
  if (set.has(lower)) return true;
  for (const e of set) if (lower.includes(e) || e.includes(lower)) return true;
  return false;
}

function isKnownEmployer(text, knowledge) { return isKnownOfType(text, getKnownEmployers(knowledge)); }
function isKnownRole(text, knowledge) { return isKnownOfType(text, getKnownRoles(knowledge)); }
function isKnownProject(text, knowledge) { return isKnownOfType(text, getKnownProjects(knowledge)); }
function isKnownSkill(text, knowledge) { return isKnownOfType(text, getKnownSkills(knowledge)); }
function isKnownCert(text, knowledge) { return isKnownOfType(text, getKnownCerts(knowledge)); }

// Detect candidate-subject factual assertions, even when the object is not already known.
const CANDIDATE_FACTUAL_VERBS = /\b(?:worked(?:\s+(?:at|for|with))?|was\s+(?:a|an)|is\s+(?:a|an)|has\s+(?:worked|experience|been)|did|built|created|directed|led|managed|served\s+as|employed\s+as|acted\s+as|knows?|proficient(?:\s+in)?|skilled(?:\s+in)?|expert(?:\s+in)?|good\s+at|strong\s+in|uses?(?:\s+professionally)?)\b/i;
const CANDIDATE_EMPLOYER_PATTERN = /\b(?:worked\s+(?:at|for|with)|was\s+(?:employed|hired)\s+(?:at|by)|has\s+worked\s+(?:at|for)|joined)\s+([A-Z][A-Za-z0-9\s&]+)/i;
const CANDIDATE_ROLE_PATTERN = /\b(?:worked\s+as|was\s+a|is\s+a|has\s+experience\s+as|served\s+as|employed\s+as|acted\s+as)\s+(?:a\s+)?([A-Z][A-Za-z\s]+?)(?:\s+(?:at|for|with|in|and)\b|$|[,.!?;])/i;

function containsCandidateAssertion(text) {
  return CANDIDATE_FACTUAL_VERBS.test(text) || CANDIDATE_EMPLOYER_PATTERN.test(text) || CANDIDATE_ROLE_PATTERN.test(text);
}

function hasEvidenceForSkill(skill, evidenceText) {
  if (!skill || !evidenceText) return false;
  // Require whole-token/phrase presence to avoid substring false positives
  // like "vibe" matching the word "vibes" in a blog chunk.
  return phraseAppears(evidenceText, skill, t => t.toLowerCase());
}

// Claim ceiling: stronger language is forbidden for weaker evidence.
const CEILING_DISALLOWED = {
  'no verified evidence for': /\b(?:proficient|expert|mastery|master(?:ed|y)?|deep\s+knowledge|highly\s+skilled|very\s+experienced|seasoned|veteran|experienced\s+engineer|professional\s+experience|good\s+at|strong\s+in|knows?|skilled)\b/i,
  'is the candidate with the following verified profile': /\b(?:proficient|expert|mastery|master(?:ed|y)?|deep\s+knowledge|highly\s+skilled|very\s+experienced|seasoned|veteran|experienced\s+engineer|professional\s+experience|good\s+at|strong\s+in)\b/i,
  'has project experience with': /\b(?:proficient|expert|mastery|master(?:ed|y)?|deep\s+knowledge|highly\s+skilled|very\s+experienced|seasoned|veteran|professional\s+experience|experienced\s+engineer|good\s+at|strong\s+in)\b/i,
  'has internship or training experience with': /\b(?:expert|mastery|master(?:ed|y)?|deep\s+knowledge|highly\s+skilled|very\s+experienced|seasoned|veteran|professional\s+experience|experienced\s+engineer)\b/i,
  'has a verified certification in': /\b(?:expert|mastery|master(?:ed|y)?|deep\s+knowledge|years\s+of\s+experience|seasoned|veteran)\b/i,
  'learned through coursework or training in': /\b(?:expert|mastery|master(?:ed|y)?|deep\s+knowledge|highly\s+skilled|very\s+experienced|seasoned|veteran|professional\s+experience|experienced\s+engineer)\b/i,
  'has mixed evidence for': /\b(?:expert|mastery|master(?:ed|y)?|deep\s+knowledge|seasoned|veteran|professional\s+engineer)\b/i,
};

function exceedsClaimCeiling(text, claimCeiling) {
  const disallowed = CEILING_DISALLOWED[claimCeiling];
  if (!disallowed) return false;
  return disallowed.test(text);
}

function phraseAppearsInSentence(sentence, phrase) {
  const tokenNormalizer = (token) => resolveTechAlias(canonicalizeTech(token));
  const raw = String(sentence).toLowerCase().match(/[a-z0-9+#.\-/]+/g) || [];
  const sentenceTokens = raw.map(tokenNormalizer).filter(Boolean);
  const phraseTokens = (String(phrase).toLowerCase().match(/[a-z0-9+#.\-/]+/g) || [])
    .map(tokenNormalizer).filter(Boolean);
  if (phraseTokens.length === 0) return false;
  for (let i = 0; i <= sentenceTokens.length - phraseTokens.length; i++) {
    let match = true;
    for (let j = 0; j < phraseTokens.length; j++) {
      if (sentenceTokens[i + j] !== phraseTokens[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

function validateProjectTechnologyRelationships(text, contract, knowledge, evidenceText = '') {
  const invalid = [];
  if (!knowledge || !text) return invalid;

  const requestedTopic = normalizeText(contract?.requestedTopic || '');
  const globalTech = new Set([...getKnownTechnologies(knowledge)].map(normalizeText).filter(Boolean));
  if (requestedTopic) globalTech.add(requestedTopic);

  const relationVerb = /\b(?:uses?|used|using|built\s+with|built\s+using|developed\s+with|developed\s+using|implemented\s+with|implemented\s+using|written\s+in|powered\s+by|tech(?:nology)?\s+stack)\b/i;
  const negativeRelation = /\b(?:does\s+not|doesn't|did\s+not|didn't|not\s+built|not\s+using|no\s+verified)\b/i;

  // Sentences that describe a personal skill usage inside a project are not
  // the same as claiming the project uses that technology. E.g. "He has used
  // React in ProjectHub" is about the subject, not a project tech stack.
  function buildCandidateSubjectRe(k) {
    const names = new Set(['he', 'she', 'they']);
    for (const field of ['name', 'preferredName']) {
      const value = k?.identity?.[field];
      if (value) {
        names.add(value);
        for (const part of value.split(/\s+/)) {
          if (part.length >= 2) names.add(part);
        }
      }
    }
    const escaped = [...names].filter(Boolean).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    return new RegExp(`^(?:${escaped})\\b`, 'i');
  }
  const candidateSubjectRe = buildCandidateSubjectRe(knowledge);

  const sentences = String(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  const techNormalizer = (token) => resolveTechAlias(canonicalizeTech(token));
  for (const project of knowledge.projects || []) {
    const names = [project.name, ...(project.aliases || [])].filter(Boolean);
    const projectTech = new Set((project.tech || []).map(normalizeText).filter(Boolean));
    for (const sentence of sentences) {
      // URLs are availability evidence, not technology claims. Strip them so
      // "hosted at https://...github.io/..." does not register github as a
      // project technology.
      const sentenceForTech = sentence.replace(/https?:\/\/\S+|www\.\S+/g, ' ');
      const lower = normalizeText(sentenceForTech);
      if (!names.some(name => lower.includes(normalizeText(name)))) continue;
      if (!relationVerb.test(sentenceForTech) || negativeRelation.test(sentenceForTech)) continue;
      // Skip sentences where a personal subject used a technology in or on a project.
      // If the sentence starts with a personal subject and the project name is not
      // the grammatical subject of the tech relation (e.g. "He has used React in
      // ProjectHub" or "He built ProjectHub using React"), this is a personal-skill
      // claim, not an unsupported project tech-stack claim.
      const matchedName = names.find(name => lower.includes(normalizeText(name)));
      if (candidateSubjectRe.test(sentenceForTech) && matchedName) {
        const projectAsSubjectRe = new RegExp(matchedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(?:uses?|used|is|was|are|were|has|had|runs(?:\\s+on)?|powered\\s+by)\\b', 'i');
        if (!projectAsSubjectRe.test(sentenceForTech)) continue;
      }
      for (const tech of globalTech) {
        if (!tech || tech.length < 2) continue;
        if (!phraseAppearsInSentence(sentenceForTech, tech)) continue;
        if (projectTech.has(tech)) continue;
        if (evidenceText && evidenceSupportsTechnologyRelation(names, tech, evidenceText, { normalizeToken: techNormalizer })) continue;
        invalid.push({ type: 'PROJECT_RELATIONSHIP_CLAIM', detail: `${project.name} is linked to unverified technology ${tech}` });
      }
    }
  }
  return invalid;
}

// Skill-claim verbs by evidence strength.
const SKILL_VERB_PROFICIENT = /\b(?:proficient|expert|mastery|master|deep\s+knowledge|highly\s+skilled|very\s+experienced|seasoned|veteran|good\s+at|strong\s+in)\b/i;
const SKILL_VERB_GENERAL = /\b(?:has\s+experience|knows?|skilled|uses?\s+professionally|good\s+at|strong\s+in)\b/i;
const SKILL_VERB_PROJECT_USE = /\b(?:used|uses|used\s+in|used\s+for|uses\s+in|uses\s+for|project\s+uses|built\s+with|implemented\s+with)\b/i;

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
  const factState = contract?.factState || null;
  const claimCeiling = contract?.claimCeiling || null;
  const subIntent = contract?.subIntent || null;

  // 1. Assistant identity / META claims
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
    if (subIntent === 'META_CAPABILITIES' && !/capability|able to|can help|answer questions/i.test(text)) {
      invalid.push({ type: 'ASSISTANT_IDENTITY_CLAIM', detail: 'META capabilities answer does not state configured capabilities' });
    }
  }

  // 2. Negative personal/professional trait claims
  if (NEGATIVE_TRAIT_RE.test(text)) {
    // Only allowed when the contract explicitly supports a negative fact
    // (factState TRUE/PARTIAL) or the evidence contains the exact trait.
    const sentence = text.split(/[.!?]+/).find(s => NEGATIVE_TRAIT_RE.test(s)) || text;
    const matches = sentence.match(NEGATIVE_TRAIT_RE) || [];
    for (const m of matches) {
      const trait = m.toLowerCase().replace(/\s+/g, ' ').trim();
      // Negative traits are only permissible when the contract explicitly says
      // there is authoritative evidence (factState TRUE/PARTIAL). For
      // factState UNKNOWN the model must use neutral/UNKNOWN language, not a
      // specific negative trait.
      if (factState !== 'TRUE' && factState !== 'PARTIAL') {
        invalid.push({ type: 'NEGATIVE_PERSONAL_CLAIM', detail: `Unsupported negative trait: ${m}` });
      }
    }
  }

  // 3. Role/title claims (typed: a known role is not a project or skill)
  const roleMatch = text.match(CANDIDATE_ROLE_PATTERN) || text.match(ROLE_TITLE_RE);
  if (roleMatch) {
    const claimedRole = roleMatch[1].trim();
    const requestedRole = contract?.requestedRole;
    const isFitQuestion = /\b(?:fit|would\s+he|could\s+he|should\s+he)\b/i.test(q);
    const isHistoricalClaim = /\b(?:worked\s+as|was\s+a|has\s+experience\s+as|served\s+as|employed\s+as)\b/i.test(text);
    if (isHistoricalClaim) {
      if (!isKnownRole(claimedRole, knowledge) && !isEntityInEvidence(claimedRole, evidenceText)) {
        invalid.push({ type: 'ROLE_TITLE_CLAIM', detail: `Historical role/title not in evidence: ${claimedRole}` });
      }
      if (isFitQuestion) {
        invalid.push({ type: 'ROLE_TITLE_CLAIM', detail: `Fit answer fabricated historical employment as ${claimedRole}` });
      }
    }
    // Requested role must not be treated as held.
    if (requestedRole && isKnownRole(requestedRole, knowledge) === false && /\b(?:was|is|has\s+been|worked\s+as)\b/i.test(text)) {
      invalid.push({ type: 'ROLE_TITLE_CLAIM', detail: `Requested role ${requestedRole} treated as historical employment` });
    }
  }

  // 4. Employment claims (typed: only employers from experience, not projects)
  const empMatch = text.match(CANDIDATE_EMPLOYER_PATTERN) || text.match(EMPLOYMENT_RE);
  if (empMatch) {
    const company = empMatch[1].trim();
    if (!isKnownEmployer(company, knowledge) && !isEntityInEvidence(company, evidenceText)) {
      invalid.push({ type: 'EMPLOYMENT_CLAIM', detail: `Unsupported employer claim: ${company}` });
    }
  }

  // 5. Current/temporal claims
  if (CURRENT_EMPLOYMENT_RE.test(text) && !isEntityInEvidence('current', evidenceText)) {
    invalid.push({ type: 'CURRENT_TEMPORAL_CLAIM', detail: 'Unsupported current employment claim' });
  }

  // 6. Claim-ceiling enforcement
  if (claimCeiling && exceedsClaimCeiling(text, claimCeiling)) {
    invalid.push({ type: 'OVERCLAIM', detail: `Answer exceeds claim ceiling "${claimCeiling}"` });
  }

  // 7. Proficiency/expertise claims from weak evidence
  if (SKILL_VERB_PROFICIENT.test(text) && (evidenceStrength === 'PROJECT' || evidenceStrength === 'INTERNSHIP' || evidenceStrength === 'EDUCATION' || evidenceStrength === 'UNKNOWN')) {
    const m = text.match(SKILL_VERB_PROFICIENT);
    invalid.push({ type: 'PROFICIENCY_CLAIM', detail: `Proficiency/expertise claim with evidence strength ${evidenceStrength}: ${m[0]}` });
  }

  // 8. Skill claims for unknown or project-only technologies
  const requestedTopic = contract?.requestedTopic;
  const skillIsVerified = requestedTopic && hasEvidenceForSkill(requestedTopic, evidenceText);
  const knownSkill = requestedTopic && isKnownSkill(requestedTopic, knowledge);
  const topicIsNegated = requestedTopic && isTokenNegated(text, requestedTopic);
  if (requestedTopic && !skillIsVerified && !topicIsNegated) {
    // Unknown technology: any current-skill claim is forbidden.
    if (SKILL_VERB_GENERAL.test(text)) {
      invalid.push({ type: 'SKILL_CLAIM', detail: `Skill/proficiency claim for unverified topic: ${requestedTopic}` });
    }
    // Project-only evidence: only "used in project" is allowed, not general skill/proficiency.
    if (evidenceStrength === 'PROJECT' && SKILL_VERB_PROFICIENT.test(text)) {
      invalid.push({ type: 'SKILL_CLAIM', detail: `Project-only evidence treated as general skill for ${requestedTopic}` });
    }
  }

  // 8b. A technology can be globally known without belonging to the project
  // named in this answer. Enforce the typed project -> technology relationship.
  invalid.push(...validateProjectTechnologyRelationships(text, contract, knowledge, evidenceText));

  // 9. OUT_OF_SCOPE / REFUSAL answers must not fabricate candidate biography.
  if (policyMode === 'OUT_OF_SCOPE' || policyMode === 'REFUSAL') {
    if (containsCandidateAssertion(text) && text.length > 15) {
      invalid.push({ type: 'OUT_OF_SCOPE_CLAIM', detail: 'OUT_OF_SCOPE/refusal answer contains unsupported candidate factual assertion' });
    }
  }

  // 10. Unknown technology must not be treated as evidence.
  if (requestedTopic && !knownSkill && !skillIsVerified && !topicIsNegated) {
    // The question entity (e.g. COBOL) is not evidence.
    // Any claim "Bradley knows X" is unsupported unless X appears in the evidence.
    if (/\b(?:is\s+skilled|is\s+proficient|is\s+experienced|knows?|has\s+experience)\b/i.test(text)) {
      invalid.push({ type: 'SKILL_CLAIM', detail: `Unknown technology ${requestedTopic} treated as documented skill` });
    }
  }

  return invalid;
}

module.exports = {
  validateClaims,
  validateProjectTechnologyRelationships,
};
