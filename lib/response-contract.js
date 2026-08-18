'use strict';

// Semantic Response Contract
//
// Before generation, produces a compact response contract that tells the
// model WHAT to include and HOW to shape its answer. This is generic and
// works for any bot — it uses the evidence and knowledge abstractly.
//
// The contract is NOT exposed to the user. It is translated into natural
// instructions for the model prompt.

// Configurable subject name alternation for regex patterns
let _subjectNameAlt = '';
function configureSubjectNames(names = []) {
  const valid = names.filter(Boolean).map(n => n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  _subjectNameAlt = valid.length > 0 ? '|' + valid.join('|') : '';
}

const { classifyIntent } = require('./completeness-check');

/**
 * Build a semantic response contract from the question, evidence, and knowledge.
 *
 * @param {string} question - The user's question
 * @param {string} evidence - Compressed evidence text
 * @param {object} knowledge - The knowledge base (optional)
 * @param {string[]} history - Recent conversation turns (optional)
 * @returns {object} Response contract
 */
function buildResponseContract(question, evidence, knowledge, history = []) {
  const intent = classifyIntent(question);
  const q = (question || '').trim();
  const subIntent = classifySubIntent(q, intent, knowledge);
  const activeEntities = extractActiveEntities(q, knowledge, history);
  const requestedTopic = ['SKILL', 'FOLLOW_UP', 'JOB_FIT'].includes(intent)
    ? extractRequestedTopic(q, knowledge)
    : null;
  const rankedFacts = rankCandidateFacts(evidence, {
    intent,
    subIntent,
    activeEntities,
    requestedTopic,
    knowledge
  });
  const subject = determineSubject(subIntent, activeEntities, rankedFacts, knowledge);
  const selectedFacts = selectContractFacts(rankedFacts, subIntent, subject, activeEntities);
  const keyFacts = selectedFacts.map(fact => fact.text);
  let directAnswer = determineDirectAnswer(q, intent, evidence, knowledge);
  const isNegationConfirmation = directAnswer === 'YES' && isNegatedPremiseQuestion(q);
  if (subIntent === 'RATIONALE' && !hasVerifiedRationale(selectedFacts)) directAnswer = 'UNKNOWN';
  if (subIntent === 'COMPARISON_DECISION' || subIntent === 'OPINION_DECISION') directAnswer = subject;
  const selectedStrengths = [...new Set(selectedFacts.map(fact => fact.evidenceStrength).filter(Boolean))];
  const evidenceStrength = selectedStrengths.length > 1 ? 'MIXED' :
    (selectedStrengths[0] || determineEvidenceStrength(intent, keyFacts.join('\n') || evidence, knowledge));
  const requiredEntities = determineRequiredEntities(q, intent, activeEntities, knowledge, {
    subIntent,
    subject,
    requestedTopic,
    rankedFacts,
    directAnswer,
    evidenceStrength
  });

  // Four-way entity semantics (see docs/contract-entity-semantics.md)
  // contextEntities: needed internally for retrieval/routing, NOT required in output
  // mustMentionEntities: MUST appear in visible prose (completeness-enforced)
  // evidenceEntities: expected in evidence/grounding, NOT required in output
  // forbiddenEntities: must NOT be asserted by the model (safety-enforced)
  const policyMode = determinePolicyMode(intent, subIntent);
  const mustMentionEntities = policyMode === 'REFUSAL' || policyMode === 'OUT_OF_SCOPE'
    ? [] // Refusals/OOS: no mustMention — answer should redirect, not enumerate
    : requiredEntities;
  const contextEntities = activeEntities.filter(e => !mustMentionEntities.includes(e));
  const evidenceEntities = [...new Set(selectedFacts.map(f => f.sourceEntity).filter(Boolean))];
  const forbiddenClaims = determineForbiddenClaims(intent, knowledge, evidenceStrength);
  const forbiddenEntities = forbiddenClaims.slice();

  const requiredFacts = buildRequiredFacts({
    subIntent,
    subject,
    requestedTopic,
    selectedFacts,
    directAnswer,
    evidenceStrength,
    requiredEntities
  });
  const optionalFacts = rankedFacts
    .filter(fact => !selectedFacts.includes(fact))
    .slice(0, 2);
  const requiredRelationships = buildRequiredRelationships({
    subIntent,
    subject,
    requestedTopic,
    requiredEntities,
    evidenceStrength
  });
  const boundary = determineBoundary(intent, q, evidence, knowledge) ||
    determineEvidenceBoundary(evidenceStrength, knowledge);
  const responseShape = getResponseShape(intent, subIntent);

  // Fact state and claim ceiling encode what the answer is allowed to assert.
  const factState = determineFactState(intent, subIntent, evidenceStrength, directAnswer, selectedFacts);
  const claimCeiling = determineClaimCeiling(evidenceStrength);
  const requestedRole = (subIntent === 'JOB_FIT' || intent === 'JOB_FIT') ?
    extractRequestedRole(q, knowledge) : null;

  // forbiddenClaims already computed above for forbiddenEntities
  const naturalInstructions = buildNaturalInstructions(
    intent, directAnswer, keyFacts, activeEntities, responseShape, q,
    requiredEntities, evidenceStrength, boundary, subIntent, subject,
    requestedTopic, requiredFacts, requiredRelationships, factState,
    claimCeiling, requestedRole
  );

  return {
    intent,
    subIntent,
    subject,
    activeEntities,
    requestedTopic,
    requestedRole,
    directAnswer,
    isNegationConfirmation,
    factState,
    claimCeiling,
    requiredFacts,
    optionalFacts,
    rankedFacts,
    keyFacts,
    evidenceStrength,
    boundary,
    requiredEntities: mustMentionEntities, // backward-compatible alias
    mustMentionEntities,
    contextEntities,
    evidenceEntities,
    forbiddenEntities,
    requiredRelationships,
    responseShape,
    forbiddenClaims,
    policyMode,
    naturalInstructions,
  };
}

/**
 * Detect whether a question has a negated premise — i.e., the question itself
 * asserts the absence of something and asks for confirmation.
 * "No evidence he attended MIT, right?" → true
 * "He was not a senior engineer, was he?" → true
 * "He was a senior engineer, right?" → false
 * This is generic and domain-neutral — it checks linguistic structure, not entities.
 */
function isNegatedPremiseQuestion(question) {
  const q = (question || '').toLowerCase();
  // Pattern 1: "no evidence X, right?" / "not X, right?" / "never X, correct?"
  if (/\b(?:no\s+evidence|not\b|never\b|didn'?t\b|did not\b|no\s+mention|isn'?t\b|is not\b|wasn'?t\b|was not\b|doesn'?t\b|does not\b|haven'?t\b|have not\b|hasn'?t\b|has not\b)\b/i.test(question) &&
      /\b(?:right|correct|true)\b/.test(q)) {
    return true;
  }
  // Pattern 2: "He was not X, was he?" / "He didn't X, did he?"
  if (/\b(?:was he|did he|is he|has he)\b/.test(q) &&
      /\b(?:not|no|never)\b/.test(q)) {
    return true;
  }
  return false;
}

function knowledgeSkillValues(knowledge) {
  if (!knowledge?.skills || typeof knowledge.skills !== 'object') return [];
  return Object.values(knowledge.skills).flatMap(value => Array.isArray(value) ? value : []);
}

function extractRequestedTopic(question, knowledge) {
  const lower = question.toLowerCase();
  const candidates = [...new Set([
    ...knowledgeSkillValues(knowledge),
    ...(knowledge?.projects || []).flatMap(project => project.tech || [])
  ])].filter(value => typeof value === 'string' && value.length >= 2)
    .sort((a, b) => b.length - a.length);
  return candidates.find(value => lower.includes(value.toLowerCase())) || null;
}

function classifySubIntent(question, intent, knowledge) {
  const lower = question.toLowerCase();
  if (/\bwhy\b.*\b(?:build|built|design|designed|architect|architecture|choose|chosen|way)\b/.test(lower)) return 'RATIONALE';
  if (intent === 'RECRUITER' && /\b(?:worth|recommend|interview|hire)\b/.test(lower)) return 'RECRUITER_RECOMMENDATION';
  if (intent === 'COMPARISON' && /\b(?:which|better|stronger|more complex|most complex|more relevant|most relevant|impress)\b/.test(lower)) return 'COMPARISON_DECISION';
  if (intent === 'COMPARISON') return 'COMPARISON_EXPLANATION';
  const requestedTopic = extractRequestedTopic(question, knowledge);
  if (requestedTopic && (intent === 'SKILL' || intent === 'FOLLOW_UP' || /\bwhat about\b/.test(lower))) return 'SKILL_EVIDENCE';
  if (intent === 'OPINION' && /\bbest at\b/.test(lower)) return 'STRENGTH_EVIDENCE';
  if (intent === 'OPINION' && /\b(?:favorite|most interesting|most impressive)\b/.test(lower)) return 'OPINION_DECISION';
  if (intent === 'RECRUITER' && /\b(?:weakness|gap|lack|concern|need.*learn)\b/.test(lower)) return 'GAP';
  if (intent === 'PROFILE' || /\bquick version\b/.test(lower)) return 'PROFILE_SUMMARY';
  if (intent === 'PROJECT') return 'PROJECT_DETAILS';
  if (intent === 'META') return 'META_IDENTITY';
  if (intent === 'FUTURE_CAPABILITY') return 'FUTURE_CAPABILITY';
  if (/\b(?:bad\s+at|weak\s+at|what\s+is\s+he\s+bad\s+at|negative\s+trait|worst\s+at|weakest\s+at)\b/.test(lower)) return 'NEGATIVE_ASSESSMENT';
  if (/\b(?:the\s+other\s+one|the\s+other\s+project|which\s+one|the\s+first\s+one|the\s+second\s+one)\b/.test(lower)) return 'CLARIFICATION_REQUIRED';
  return intent;
}

function factSourceEntity(line, knowledge) {
  const bracket = line.match(/^\s*\[([^\]]+)\]/);
  const colon = line.match(/^\s*([^:\n]{2,80}):/);
  const prefix = bracket?.[1] || colon?.[1] || '';
  const candidates = [
    ...(knowledge?.projects || []).flatMap(project => [project.name, ...(project.aliases || [])]),
    ...(knowledge?.experience || []).map(item => item.company)
  ].filter(Boolean).sort((a, b) => b.length - a.length);
  return candidates.find(entity => prefix.toLowerCase().includes(String(entity).toLowerCase())) ||
    candidates.find(entity => line.toLowerCase().includes(String(entity).toLowerCase())) || null;
}

function factEvidenceStrength(line) {
  const lower = line.toLowerCase();
  if (/\b(?:internship|intern|capstone)\b/.test(lower)) return 'INTERNSHIP';
  if (/\b(?:professional|production|employed|freelance|work experience)\b/.test(lower) && !/\b(?:not|no)\s+(?:professional|production)\b/.test(lower)) return 'PROFESSIONAL';
  if (/\b(?:certification|certified|certificate)\b/.test(lower)) return 'CERTIFICATION';
  if (/\b(?:project|built|portfolio|demo)\b/.test(lower) || /^\s*\[[^\]]+\]/.test(line)) return 'PROJECT';
  if (/\b(?:course|education|degree|school)\b/.test(lower)) return 'EDUCATION';
  return null;
}

function rankCandidateFacts(evidence, context) {
  const lines = String(evidence || '').split('\n').map(line => line.trim()).filter(line => line.length > 8);
  const requestedWords = String(context.requestedTopic || '').toLowerCase().split(/[^a-z0-9+#.-]+/).filter(Boolean);
  const questionEntities = context.activeEntities.map(entity => entity.toLowerCase());
  const relationshipTerms = {
    SKILL_EVIDENCE: ['skill', 'uses', 'used', 'project', 'experience', 'direct'],
    RATIONALE: ['because', 'purpose', 'reason', 'designed to', 'built to', 'so that', 'tradeoff'],
    COMPARISON_DECISION: ['tech', 'uses', 'purpose', 'project', 'evidence'],
    COMPARISON_EXPLANATION: ['tech', 'uses', 'purpose', 'project', 'difference'],
    RECRUITER_RECOMMENDATION: ['experience', 'project', 'skill', 'internship', 'entry'],
    GAP: ['gap', 'lack', 'learning', 'need', 'without'],
  }[context.subIntent] || getIntentKeywords(context.intent);
  return lines.map((line, index) => {
    const lower = line.toLowerCase();
    const sourceEntity = factSourceEntity(line, context.knowledge);
    let score = 0;
    if (sourceEntity && questionEntities.some(entity => sourceEntity.toLowerCase().includes(entity) || entity.includes(sourceEntity.toLowerCase()))) score += 10;
    if (requestedWords.length && requestedWords.every(word => lower.includes(word))) score += 8;
    score += relationshipTerms.filter(term => lower.includes(term)).length * 2;
    if (sourceEntity && context.activeEntities.some(entity => entity.toLowerCase() === sourceEntity.toLowerCase())) score += 4;
    let evidenceStrength = factEvidenceStrength(line);
    if (!evidenceStrength && sourceEntity) {
      const project = (context.knowledge?.projects || []).find(item => item.name === sourceEntity);
      if (project) {
        const corpus = JSON.stringify(project).toLowerCase();
        evidenceStrength = /\b(?:internship|intern|capstone)\b/.test(corpus) ? 'INTERNSHIP' :
          (/\b(?:freelance|professional|production)\b/.test(corpus) ? 'PROFESSIONAL' : 'PROJECT');
      }
    }
    if (evidenceStrength) score += 2;
    if (line.length > 320) score -= 2;
    return { text: line, sourceEntity, evidenceStrength, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
}

function determineSubject(subIntent, activeEntities, rankedFacts, knowledge) {
  if (subIntent === 'SKILL_EVIDENCE') return activeEntities.find(entity => knowledgeSkillValues(knowledge).includes(entity)) || activeEntities[0] || null;
  if (subIntent === 'RECRUITER_RECOMMENDATION' || subIntent === 'STRENGTH_EVIDENCE' || subIntent === 'PROFILE_SUMMARY') {
    return knowledge?.identity?.name || null;
  }
  const explicitProject = activeEntities.find(entity => (knowledge?.projects || []).some(project => project.name === entity));
  if (explicitProject) return explicitProject;
  return rankedFacts.find(fact => fact.sourceEntity)?.sourceEntity || knowledge?.identity?.name || null;
}

function selectContractFacts(rankedFacts, subIntent, subject, activeEntities) {
  if (subIntent === 'COMPARISON_DECISION' || subIntent === 'COMPARISON_EXPLANATION') {
    const sources = [];
    for (const fact of rankedFacts) {
      if (fact.sourceEntity && !sources.includes(fact.sourceEntity)) sources.push(fact.sourceEntity);
    }
    return sources.slice(0, 3).map(source => rankedFacts.find(fact => fact.sourceEntity === source)).filter(Boolean);
  }
  if (['SKILL_EVIDENCE', 'JOB_FIT', 'RECRUITER_RECOMMENDATION', 'STRENGTH_EVIDENCE', 'PROFILE_SUMMARY'].includes(subIntent)) {
    return rankedFacts.slice(0, 3);
  }
  if (subject) {
    const sameSource = rankedFacts.filter(fact => fact.sourceEntity === subject);
    if (sameSource.length) return sameSource.slice(0, 3);
  }
  return rankedFacts.slice(0, 3);
}

function hasVerifiedRationale(facts) {
  return facts.some(fact => /\b(?:because|purpose|reason|designed to|built to|so that|tradeoff|chose|decision)\b/i.test(fact.text));
}

function buildRequiredFacts({ subIntent, subject, requestedTopic, selectedFacts, directAnswer, evidenceStrength, requiredEntities }) {
  const facts = [];
  if (directAnswer) facts.push({ type: 'direct_answer', value: directAnswer });
  if (requestedTopic) facts.push({ type: 'requested_topic', value: requestedTopic });
  if (subIntent === 'RATIONALE') {
    facts.push({ type: 'rationale', value: directAnswer === 'UNKNOWN' ? 'No verified rationale is documented' : selectedFacts[0]?.text || null, sourceEntity: subject });
  }
  if (subIntent === 'COMPARISON_DECISION') facts.push({ type: 'comparison_entities', value: requiredEntities });
  const supportFacts = selectedFacts.slice(0, 2);
  const sourcedFact = selectedFacts.find(fact => fact.sourceEntity);
  if (sourcedFact && !supportFacts.includes(sourcedFact)) supportFacts.push(sourcedFact);
  for (const fact of supportFacts) {
    facts.push({ type: 'supporting_evidence', value: fact.text, sourceEntity: fact.sourceEntity, evidenceStrength: fact.evidenceStrength });
  }
  if (evidenceStrength) facts.push({ type: 'evidence_strength', value: evidenceStrength });
  return facts.filter(fact => fact.value !== null && fact.value !== undefined);
}

function buildRequiredRelationships({ subIntent, subject, requestedTopic, requiredEntities, evidenceStrength }) {
  if (subIntent === 'SKILL_EVIDENCE') return [{ subject, relation: 'has_evidence_for', object: requestedTopic, evidenceStrength }];
  if (subIntent === 'RATIONALE') return [{ subject, relation: 'has_verified_rationale', object: null }];
  if (subIntent === 'COMPARISON_DECISION' || subIntent === 'COMPARISON_EXPLANATION') {
    return [{ subject: requiredEntities[0] || null, relation: 'compared_with', object: requiredEntities[1] || null }];
  }
  if (subIntent === 'RECRUITER_RECOMMENDATION') return [{ subject, relation: 'recommended_for_interview', object: 'candidate' }];
  return [];
}

function determineEvidenceBoundary(evidenceStrength, knowledge) {
  if (!evidenceStrength || evidenceStrength === 'PROFESSIONAL') return null;
  const entryLevel = /\b(?:entry|junior|early)\b/i.test(knowledge?.summary?.whoIAm || '');
  if (!entryLevel) return null;
  return `${evidenceStrength.toLowerCase()} evidence only — do not describe it as professional production ownership`;
}

/**
 * Extract active entities from the question and conversation context.
 */
function extractActiveEntities(question, knowledge, history) {
  const entities = [];

  // Extract capitalized phrases from the question
  const capMatches = question.match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g) || [];
  for (const cap of capMatches) {
    // Skip common English words
    if (isCommonWord(cap)) continue;
    entities.push(cap);
  }

  // Extract entities from recent history (last 3 turns)
  for (let i = Math.max(0, history.length - 3); i < history.length; i++) {
    const turnText = String(history[i]?.text || `${history[i]?.user || ''} ${history[i]?.assistant || ''}`);
    const turnCaps = turnText.match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g) || [];
    for (const cap of turnCaps) {
      if (isCommonWord(cap)) continue;
      if (!entities.some(e => e.toLowerCase() === cap.toLowerCase())) {
        entities.push(cap);
      }
    }
  }

  // Match entities against known projects/skills/companies if knowledge available
  if (knowledge) {
    const matched = [];
    for (const entity of entities) {
      const matched_entity = matchToKnowledge(entity, knowledge);
      if (matched_entity) {
        matched.push(matched_entity);
      } else {
        matched.push(entity);
      }
    }
    return matched;
  }

  return entities;
}

/**
 * Match an entity string to a known project, skill, or company.
 */
function matchToKnowledge(entity, knowledge) {
  const norm = entity.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Check projects
  if (Array.isArray(knowledge.projects)) {
    for (const proj of knowledge.projects) {
      const pNorm = (proj.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (pNorm.includes(norm) || norm.includes(pNorm)) {
        return proj.name;
      }
      if (Array.isArray(proj.aliases)) {
        for (const alias of proj.aliases) {
          const aNorm = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (aNorm.includes(norm) || norm.includes(aNorm)) {
            return proj.name;
          }
        }
      }
    }
  }

  // Check experience/companies
  if (Array.isArray(knowledge.experience)) {
    for (const exp of knowledge.experience) {
      const cNorm = (exp.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cNorm.includes(norm) || norm.includes(cNorm)) {
        return exp.company;
      }
    }
  }

  for (const skill of knowledgeSkillValues(knowledge)) {
    const sNorm = String(skill).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (sNorm === norm) return skill;
  }

  return entity;
}

/**
 * Extract key facts from the evidence that should be in the answer.
 * This is the core of the contract — it tells the model WHAT to say.
 * Uses knowledge entities (not hardcoded tech names) for scoring.
 */
function extractKeyFacts(evidence, intent, activeEntities, knowledge) {
  const evText = evidence || '';
  if (!evText) return [];

  // Split evidence into lines/chunks
  const lines = evText.split('\n').filter(l => l.trim().length > 10);

  // Build a set of knowledge entities for fact-density scoring (generic, not hardcoded)
  const knowledgeEntities = new Set();
  if (knowledge) {
    if (Array.isArray(knowledge.projects)) {
      for (const p of knowledge.projects) {
        if (p.name) knowledgeEntities.add(p.name.toLowerCase());
        if (Array.isArray(p.tech)) p.tech.forEach(t => knowledgeEntities.add(t.toLowerCase()));
      }
    }
    if (Array.isArray(knowledge.skills)) {
      for (const s of knowledge.skills) {
        const name = typeof s === 'string' ? s : (s.name || '');
        if (name) knowledgeEntities.add(name.toLowerCase());
      }
    }
    if (Array.isArray(knowledge.experience)) {
      for (const e of knowledge.experience) {
        if (e.company) knowledgeEntities.add(e.company.toLowerCase());
        if (e.role) knowledgeEntities.add(e.role.toLowerCase());
      }
    }
  }

  // Score each line by relevance to the intent and active entities
  const scored = lines.map(line => {
    let score = 0;
    const lineLower = line.toLowerCase();

    // Score by active entity mentions
    for (const entity of activeEntities) {
      const eNorm = entity.toLowerCase().replace(/[^a-z0-9]/g, '');
      const lineNorm = lineLower.replace(/[^a-z0-9]/g, '');
      if (lineNorm.includes(eNorm)) {
        score += 3;
      }
    }

    // Score by intent-relevant keywords
    const intentKeywords = getIntentKeywords(intent);
    for (const kw of intentKeywords) {
      if (lineLower.includes(kw)) {
        score += 2;
      }
    }

    // Score by fact density — count knowledge entity mentions (generic)
    for (const ent of knowledgeEntities) {
      if (ent.length >= 3 && lineLower.includes(ent)) {
        score += 1;
      }
    }

    // Penalize very long lines (they're often context, not key facts)
    if (line.length > 300) score -= 2;

    return { line, score };
  });

  // Sort by score and take top 3 facts (keep it focused — 1-3 high-value facts)
  scored.sort((a, b) => b.score - a.score);
  const topFacts = scored
    .filter(s => s.score > 0)
    .slice(0, 3)
    .map(s => s.line.trim());

  return topFacts;
}

/**
 * Determine required entities that MUST be named in the answer.
 * These are entities from the question or conversation that the answer must reference.
 */
function determineRequiredEntities(question, intent, activeEntities, knowledge, context = {}) {
  const required = [];
  const qLower = question.toLowerCase();

  // For comparison questions, both entities must be named
  if (intent === 'COMPARISON') {
    const projects = knowledge?.projects || [];
    for (const project of projects) {
      const names = [project.name, ...(project.aliases || [])].filter(Boolean);
      if (names.some(name => qLower.includes(String(name).toLowerCase()))) required.push(project.name);
    }
    if (required.length < 2) {
      for (const fact of context.rankedFacts || []) {
        if (fact.sourceEntity && !required.includes(fact.sourceEntity)) required.push(fact.sourceEntity);
        if (required.length >= 2) break;
      }
    }
    if (required.length < 2) {
      for (const entity of activeEntities) {
        if (!required.includes(entity)) required.push(entity);
        if (required.length >= 2) break;
      }
    }
  }

  // For project questions, the project entity must be named
  if (intent === 'PROJECT' && activeEntities.length > 0) {
    required.push(activeEntities[0]);
  }

  // For skill questions, the skill must be named
  if (context.subIntent === 'SKILL_EVIDENCE' && context.requestedTopic) {
    required.push(context.requestedTopic);
  }
  if (context.subIntent === 'RATIONALE' && context.subject) required.push(context.subject);
  if ((context.subIntent === 'RECRUITER_RECOMMENDATION' || intent === 'OPINION') && context.subject &&
      (knowledge?.projects || []).some(project => project.name === context.subject)) {
    required.push(context.subject);
  }

  // For job-fit questions, the required skills from the question must be named
  if (intent === 'JOB_FIT') {
    const roleMatch = question.match(/(?:requiring|require|needs?|must have)\s+(.+?)(?:\?|$)/i);
    if (roleMatch) {
      const skills = roleMatch[1].split(/\s+and\s+|\s*,\s*/).map(s => s.trim());
      for (const s of skills) {
        if (s.length > 2) required.push(s);
      }
    }
  }

  // Deduplicate
  return [...new Set(required)];
}

/**
 * Determine the policy mode for the response.
 * REFUSAL: private data, contact info that shouldn't be shared
 * OUT_OF_SCOPE: questions outside the bot's domain
 * NORMAL: everything else
 * This is generic — based on intent classification, not specific questions.
 */
function determinePolicyMode(intent, subIntent) {
  if (intent === 'OOS') return 'OUT_OF_SCOPE';
  if (intent === 'REFUSAL') return 'REFUSAL';
  if (subIntent === 'PRIVATE_DATA') return 'REFUSAL';
  if (intent === 'META') return 'META';
  if (subIntent === 'NEGATIVE_ASSESSMENT') return 'NEGATIVE_ASSESSMENT';
  if (subIntent === 'FUTURE_CAPABILITY') return 'FUTURE_CAPABILITY';
  if (subIntent === 'CLARIFICATION_REQUIRED') return 'CLARIFICATION_REQUIRED';
  return 'NORMAL';
}

/**
 * Determine evidence strength from the evidence text.
 * Returns: PROJECT, INTERNSHIP, CERTIFICATION, PROFESSIONAL, or null
 */
function determineEvidenceStrength(intent, evidence, knowledge) {
  const evLower = (evidence || '').toLowerCase();
  if (!evLower) return null;

  // Check INTERNSHIP first (most specific for entry-level candidates)
  if (/\b(?:internship|intern|capstone)\b/i.test(evLower)) return 'INTERNSHIP';
  // Check CERTIFICATION
  if (/\b(?:certification|certified|certificate)\b/i.test(evLower)) return 'CERTIFICATION';
  // Check PROJECT (built, personal project, portfolio)
  if (/\b(?:project|built|personal project|portfolio)\b/i.test(evLower)) return 'PROJECT';
  // Check PROFESSIONAL — but only if not negated
  if (/\b(?:professional|production|employed)\b/i.test(evLower) &&
      !/\b(?:no|not|without|lacking?)\s+(?:professional|production)\b/i.test(evLower)) {
    return 'PROFESSIONAL';
  }
  return null;
}

/**
 * Determine the claim ceiling — the strongest claim the evidence supports.
 * The answer must not exceed this ceiling; stronger language is forbidden.
 */
function determineClaimCeiling(evidenceStrength) {
  const map = {
    PROFESSIONAL: 'has professional or production experience with',
    CERTIFICATION: 'has a verified certification in',
    PROJECT: 'has project experience with',
    INTERNSHIP: 'has internship or training experience with',
    EDUCATION: 'learned through coursework or training in',
    MIXED: 'has mixed evidence for',
  };
  return map[evidenceStrength] || 'no verified evidence for';
}

/**
 * Determine the fact state for the answer.
 * TRUE: evidence supports the positive claim.
 * FALSE: evidence contradicts the claim.
 * UNKNOWN: no verified evidence; the answer must express uncertainty.
 * PARTIAL: some evidence exists but with notable gaps.
 */
function determineFactState(intent, subIntent, evidenceStrength, directAnswer, selectedFacts) {
  if (subIntent === 'CLARIFICATION_REQUIRED') return 'UNKNOWN';
  if (subIntent === 'META' || subIntent === 'META_IDENTITY') return 'TRUE';
  if (subIntent === 'FUTURE_CAPABILITY') return 'UNKNOWN';
  if (subIntent === 'NEGATIVE_ASSESSMENT') {
    // Only known gaps from the knowledge base are allowed; everything else is UNKNOWN.
    return selectedFacts?.length > 0 && evidenceStrength !== 'UNKNOWN' ? 'TRUE' : 'UNKNOWN';
  }
  if (directAnswer === 'NO' || directAnswer === 'NOT_FIT') return 'FALSE';
  if (directAnswer === 'YES' || directAnswer === 'FIT') return 'TRUE';
  if (directAnswer === 'PARTIAL_FIT' || directAnswer === 'MIXED') return 'PARTIAL';
  if (directAnswer === 'UNKNOWN') return 'UNKNOWN';
  if (evidenceStrength === 'UNKNOWN' || !evidenceStrength) return 'UNKNOWN';
  if (selectedFacts?.length === 0) return 'UNKNOWN';
  return 'TRUE';
}

/**
 * Extract the role requested in a JOB_FIT question.
 * The requested role is a target, not a historical fact.
 */
function extractRequestedRole(question, knowledge) {
  if (!question) return null;
  const lower = question.toLowerCase();
  const m = lower.match(/\b(?:fit|role|position|job)\s+(?:as\s+a\s+|a\s+)?([a-z\s]+?)(?:\?|\s+(?:at|for|with|and)\b|$)/);
  if (m) return m[1].trim();
  const m2 = lower.match(/\b(?:for\s+a\s+|as\s+a\s+)?([a-z\s]+?)\s+(?:role|position|job)\b/);
  if (m2) return m2[1].trim();
  return null;
}

/**
 * Determine boundary — important limitation to mention if relevant.
 * Uses knowledge base, not hardcoded facts.
 */
function determineBoundary(intent, question, evidence, knowledge) {
  if (!knowledge) return null;
  const qLower = question.toLowerCase();

  // Check if the question is about production/professional experience
  if (/production|professional|senior|expert|years of experience/i.test(qLower)) {
    // Check if the candidate is entry-level
    const whoIAm = knowledge.summary?.whoIAm || '';
    if (/entry|junior|early/i.test(whoIAm)) {
      return 'entry-level — experience is internship and project-based, not production';
    }
  }

  // For job-fit questions, check if there are gaps
  if (intent === 'JOB_FIT') {
    const evLower = (evidence || '').toLowerCase();
    const whoIAm = knowledge.summary?.whoIAm || '';
    const entryLevel = /entry|junior|early/i.test(whoIAm);
    // If the evidence doesn't mention the required skill, note the gap
    const roleMatch = question.match(/(?:requiring|require|needs?)\s+(.+?)(?:\?|$)/i);
    if (roleMatch) {
      const required = roleMatch[1].toLowerCase();
      const requiredSkills = required.split(/\s+and\s+|\s*,\s*/);
      const gaps = requiredSkills.filter(s => !evLower.includes(s.trim()));
      if (gaps.length > 0) {
        return `no verified evidence for: ${gaps.join(', ')}`;
      }
    }
    // Even when skills match, note entry-level status to prevent title inflation
    if (entryLevel) {
      return 'entry-level candidate — evidence is internship and project-based, not professional production ownership';
    }
  }

  // For recruiter recommendation, note the career level
  if (intent === 'RECRUITER' && /interview|worth|hiring/i.test(qLower)) {
    const whoIAm = knowledge.summary?.whoIAm || '';
    if (/entry|junior|early/i.test(whoIAm)) {
      return 'entry-level candidate with internship and project experience';
    }
  }

  return null;
}

/**
 * Get intent-relevant keywords for fact scoring.
 */
function getIntentKeywords(intent) {
  const keywordMap = {
    SKILL: ['experience', 'built', 'used', 'project', 'skill', 'tech'],
    ADVERSARIAL: ['not', 'no', 'intern', 'entry', 'never', 'did not'],
    COMPARISON: ['uses', 'tech', 'built', 'project', 'different'],
    JOB_FIT: ['experience', 'skill', 'role', 'fit', 'react', 'aws', 'node'],
    RECRUITER: ['experience', 'gap', 'weakness', 'strength', 'learning', 'entry'],
    PROJECT: ['built', 'uses', 'tech', 'description', 'project'],
    PROFILE: ['experience', 'skill', 'project', 'education', 'certification'],
    OPINION: ['project', 'interesting', 'complex', 'impressive', 'built'],
    YES_NO: ['yes', 'no', 'not', 'did', 'was', 'is'],
    FOLLOW_UP: ['uses', 'tech', 'built', 'project'],
    GENERAL: ['experience', 'project', 'skill', 'built'],
  };
  return keywordMap[intent] || keywordMap.GENERAL;
}

/**
 * Determine the direct answer if possible (YES/NO/MIXED/PARTIAL_FIT/NOT_FIT/etc.)
 * The harness determines polarity from evidence — the model should not decide.
 */
function determineDirectAnswer(question, intent, evidence, knowledge) {
  const qLower = question.toLowerCase();
  const evLower = (evidence || '').toLowerCase();

  // Adversarial questions — answer is usually NO (claim is false)
  if (intent === 'ADVERSARIAL') {
    // Check if the claim is negated in the question itself
    // "There is no evidence he attended MIT, right?" — answer is YES (confirming no evidence)
    if (/\b(?:no\s+evidence|not\b|never\b|didn'?t\b|did not\b|no\s+mention|isn'?t\b|is not\b|wasn'?t\b|was not\b|doesn'?t\b|does not\b|haven'?t\b|have not\b|hasn'?t\b|has not\b)\b/i.test(question) &&
        /\b(?:right|correct|true)\b/.test(question)) {
      return 'YES'; // Confirming the negation
    }
    // "He was not a senior engineer, was he?" — answer is YES (confirming he wasn't)
    if (/\bwas he\b/.test(question) && /\bnot\b/.test(question)) {
      return 'YES'; // Confirming the negation
    }
    // Standard adversarial: "He was X, right?" — check if X is in evidence
    const claimEntity = new RegExp(`\\b(?:he|she|they${_subjectNameAlt})\\b.*?\\b(?:was|is|has|have|did|worked|attended|managed|handled|built)\\b\\s+(?:a\\s+|an\\s+)?(.+)`, 'i').exec(question);
    if (claimEntity) {
      const claim = claimEntity[1].toLowerCase();
      const claimWords = claim.split(/\s+/).filter(w => w.length > 3);
      const supported = claimWords.some(w => evLower.includes(w));
      if (!supported) return 'NO';
    }
    return 'NO';
  }

  // Skill questions — check if the skill is in evidence
  if (intent === 'SKILL') {
    // "Does he know React?" / "Does he know X?" — direct object without preposition
    const directMatch = question.match(/\b(?:know|use|used|familiar with|experience with|skilled (?:in|with)|done with)\s+([A-Za-z][A-Za-z0-9+#.-]+)/i);
    if (directMatch) {
      const tech = directMatch[1].toLowerCase();
      // Check if the tech appears in evidence (not negated)
      const techPattern = new RegExp(`\\b${tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (techPattern.test(evLower)) return 'YES';
      return 'NO';
    }
    // "What has he done with X?" — not a yes/no, but needs evidence
    return null;
  }

  // Yes/No questions — check evidence for the key entity
  if (intent === 'YES_NO') {
    // "Was that real production work?" — check if evidence mentions production
    if (/production|professional/i.test(qLower)) {
      if (/internship|intern|capstone|training|project/i.test(evLower) &&
          !/production|professional work|employed/i.test(evLower)) {
        return 'NO'; // It was internship/project, not production
      }
    }
    // "Does that count as real cloud experience?" — if evidence has cloud work, YES
    if (/count as|real.*experience/i.test(qLower)) {
      if (/aws|lambda|dynamodb|s3|cloud|serverless/i.test(evLower)) {
        return 'YES';
      }
    }
    // "Did he do that professionally?" — check if evidence mentions professional work
    if (/professionally/i.test(qLower)) {
      if (/internship|intern|project|personal/i.test(evLower) &&
          !/professional|production|employed/i.test(evLower)) {
        return 'NO';
      }
    }
    return null;
  }

  // Comparison — always MIXED (both sides have trade-offs)
  if (intent === 'COMPARISON') return 'MIXED';

  // Job fit — determine FIT / PARTIAL_FIT / NOT_FIT from evidence
  if (intent === 'JOB_FIT') {
    const roleMatch = question.match(/(?:requiring|require|needs?)\s+(.+?)(?:\?|$)/i);
    if (roleMatch) {
      const required = roleMatch[1].toLowerCase();
      const requiredSkills = required.split(/\s+and\s+|\s*,\s*/).map(s => s.trim());
      // Check each skill — only count as match if NOT negated in evidence
      const matches = [];
      const gaps = [];
      for (const skill of requiredSkills) {
        if (skill.length < 2) continue;
        const skillPattern = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (skillPattern.test(evLower)) {
          // Check if the mention is negated (e.g., "No Kubernetes evidence")
          const negPattern = new RegExp(`(?:no|not|without|missing|lack(?:s|ing)?)\\s+[^.]*${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
          if (negPattern.test(evLower)) {
            gaps.push(skill);
          } else {
            matches.push(skill);
          }
        } else {
          gaps.push(skill);
        }
      }
      if (matches.length === requiredSkills.length) return 'FIT';
      if (matches.length > 0) return 'PARTIAL_FIT';
      return 'NOT_FIT';
    }
    // "What kind of role fits him best?" — not a fit judgment
    return null;
  }

  // Recruiter — determine YES/MIXED/NO from evidence
  if (intent === 'RECRUITER') {
    // "Is he worth interviewing?" / "Why would I interview him?"
    if (/\b(?:worth|interview|why.*interview)\b/.test(qLower)) {
      // If there's any positive evidence, recommend interviewing
      if (evLower.length > 50) return 'YES';
      return 'MIXED';
    }
    // "What concerns would you have?" — MIXED (honest about limitations)
    if (/\b(?:concern|weakness|gap|lack)\b/.test(qLower)) return 'MIXED';
    // "What should I ask him about?" — no polarity, just evidence
    // "Give me the quick version" — no polarity
    return null;
  }

  // Opinion — no direct answer (model expresses preference with evidence)
  if (intent === 'OPINION') {
    return null;
  }

  return null;
}

/**
 * Get the response shape for an intent.
 */
function getResponseShape(intent, subIntent) {
  const subtypeShapes = {
    SKILL_EVIDENCE: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Answer the requested skill question directly',
        'Name the strongest verified usage example',
        'State whether the evidence is project, internship, education, certification, or professional'
      ]
    },
    RATIONALE: {
      minSentences: 1,
      maxSentences: 3,
      requirements: [
        'Answer why, not only what the entity is',
        'Use only a verified design reason or say that no verified rationale is documented',
        'Do not invent motivation or tradeoffs'
      ]
    },
    COMPARISON_DECISION: {
      minSentences: 2,
      maxSentences: 4,
      requirements: [
        'Name every compared entity',
        'State one direct conclusion on the requested dimension',
        'Support the conclusion with evidence from each entity'
      ]
    },
    RECRUITER_RECOMMENDATION: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Give the recommendation polarity first',
        'Name the strongest supporting evidence',
        'State the most important verified limitation'
      ]
    },
    OPINION_DECISION: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Name the selected entity directly',
        'Give one specific reason from that entity only',
        'Do not combine facts from different entities'
      ]
    },
    STRENGTH_EVIDENCE: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Name one specific strength',
        'Support it with a concrete project or experience',
        'State the evidence level honestly'
      ]
    }
  };
  if (subtypeShapes[subIntent]) return subtypeShapes[subIntent];
  const shapes = {
    SKILL: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Answer yes or no first',
        'Name the specific project or experience that demonstrates the skill',
        'State the evidence level (project, internship, or professional)',
      ],
    },
    ADVERSARIAL: {
      minSentences: 1,
      maxSentences: 2,
      requirements: [
        'Start with No in a full sentence',
        'State what is actually true',
        'Do not repeat the false claim',
      ],
    },
    COMPARISON: {
      minSentences: 2,
      maxSentences: 4,
      requirements: [
        'Mention both entities by name',
        'State at least one meaningful difference',
        'Use specific tech or purpose details',
      ],
    },
    JOB_FIT: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'State whether he fits the role',
        'Name the specific skills that match',
        'Note any gaps if relevant',
      ],
    },
    RECRUITER: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Answer the recruiter question directly',
        'Reference specific evidence about the candidate',
        'Do not give generic recruiter advice',
      ],
    },
    PROJECT: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Describe what the project is',
        'Name specific technologies used',
        'Mention what it does or why it matters',
      ],
    },
    PROFILE: {
      minSentences: 2,
      maxSentences: 4,
      requirements: [
        'Summarize who the candidate is',
        'Name 2-3 key skills or technologies',
        'Mention their career level',
      ],
    },
    OPINION: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'State your opinion directly',
        'Give a specific reason grounded in evidence',
        'Name at least one specific project or technology from the facts',
        'Do not say "simple projects" or "basic technologies" — name the actual tech',
      ],
    },
    YES_NO: {
      minSentences: 1,
      maxSentences: 2,
      requirements: [
        'Answer yes or no first',
        'Add one supporting fact',
      ],
    },
    FOLLOW_UP: {
      minSentences: 1,
      maxSentences: 3,
      requirements: [
        'Answer the follow-up question directly',
        'Use context from the conversation',
        'Name specific details from evidence',
      ],
    },
    GENERAL: {
      minSentences: 1,
      maxSentences: 3,
      requirements: [
        'Answer the question directly',
        'Use specific evidence, not generic statements',
      ],
    },
  };
  return shapes[intent] || shapes.GENERAL;
}

/**
 * Determine forbidden claims based on intent and knowledge.
 */
function determineForbiddenClaims(intent, knowledge, evidenceStrength) {
  const forbidden = [];

  if (knowledge) {
    // If entry-level, forbid seniority claims
    const isEntryLevel = knowledge.summary?.whoIAm && /entry|junior|early/i.test(knowledge.summary.whoIAm);
    if (isEntryLevel) {
      forbidden.push('senior', 'expert', 'extensive experience', 'managed teams', 'leadership role');
    }
  }
  if (evidenceStrength && evidenceStrength !== 'PROFESSIONAL') {
    forbidden.push('experienced engineer', 'professional engineer', 'production engineer', 'professional full-stack engineer');
  }

  return forbidden;
}

/**
 * Build natural instructions for the model from the contract.
 * These are translated into normal English, never exposing internal syntax.
 */
function buildNaturalInstructions(intent, directAnswer, keyFacts, activeEntities, responseShape, question,
  requiredEntities, evidenceStrength, boundary, subIntent, subject, requestedTopic,
  requiredFacts, requiredRelationships, factState, claimCeiling, requestedRole) {
  const instructions = [];

  // Fact state and claim ceiling — enforce what can be asserted
  if (factState) {
    if (factState === 'UNKNOWN') {
      instructions.push('FACT_STATE: No verified evidence. State uncertainty clearly and do not invent a positive answer.');
    } else if (factState === 'FALSE') {
      instructions.push('FACT_STATE: Evidence contradicts the claim. Deny it and state what IS true from the facts.');
    } else if (factState === 'PARTIAL') {
      instructions.push('FACT_STATE: Partial evidence. Mention matching points AND gaps. Do not overstate.');
    } else if (factState === 'TRUE') {
      instructions.push('FACT_STATE: Evidence supports the claim. Cite the specific source.');
    }
  }
  if (claimCeiling) {
    instructions.push(`CLAIM_CEILING: The strongest allowed claim is "${claimCeiling} <topic>". Do not exceed this ceiling.`);
  }
  if (requestedRole) {
    instructions.push(`REQUESTED_ROLE: "${requestedRole}" is a hypothetical target, not a historical role. Do not claim he held it.`);
  }

  // Direct answer / polarity guidance
  if (directAnswer === 'NO') {
    instructions.push('Start with "No" in a full sentence. Then state what is actually true.');
  } else if (directAnswer === 'YES') {
    instructions.push('Start with "Yes" and name the specific evidence.');
  } else if (directAnswer === 'MIXED') {
    instructions.push('Give a balanced answer with specific details from both sides.');
  } else if (directAnswer === 'FIT') {
    instructions.push('State that he fits the role. Name the specific matching skills and evidence.');
  } else if (directAnswer === 'PARTIAL_FIT') {
    instructions.push('State that he partially fits. Name matching skills AND note the gaps.');
  } else if (directAnswer === 'NOT_FIT') {
    instructions.push('State that he does not fit the role. Name the missing requirements.');
  } else if (directAnswer === 'UNKNOWN') {
    instructions.push('State clearly that no verified rationale is documented. Do not infer a motivation.');
  }

  if (subIntent === 'SKILL_EVIDENCE' && requestedTopic) {
    instructions.push(`Discuss ${requestedTopic} as candidate evidence, not as a dictionary definition.`);
  }
  if (subIntent === 'RATIONALE') {
    instructions.push(`The subject is ${subject || 'the active entity'}. The answer must explain why or explicitly say the reason is not documented.`);
  }
  if (subIntent === 'COMPARISON_DECISION') {
    instructions.push(`Choose ${subject || 'one entity'} directly and support it with facts from every compared entity.`);
  }
  if (subIntent === 'OPINION_DECISION') {
    instructions.push(`Choose ${subject || 'one entity'} and use only facts attached to that entity.`);
  }
  if (subIntent === 'STRENGTH_EVIDENCE') {
    instructions.push('Name one candidate strength and one concrete example that demonstrates it.');
  }
  if (subIntent === 'RECRUITER_RECOMMENDATION') {
    instructions.push('Give an explicit interview recommendation, strongest evidence, and one honest limitation.');
  }
  if (subIntent === 'META_IDENTITY') {
    instructions.push('Identify yourself by name (Scout), state your product role, and list your capabilities. Do not claim self-learning, improvement, or another assistant identity.');
  }
  if (subIntent === 'NEGATIVE_ASSESSMENT') {
    instructions.push('Only mention weaknesses or gaps that are explicitly documented in the facts. If none are documented, say so. Do not invent negative personal traits.');
  }
  if (subIntent === 'FUTURE_CAPABILITY') {
    instructions.push('This is a future/potential question. Answer only with what can be reasonably inferred from current evidence and motivation. Do not invent future outcomes.');
  }
  if (subIntent === 'CLARIFICATION_REQUIRED') {
    instructions.push('The question is ambiguous or refers to an unresolved "other one". Ask a brief clarifying question.');
  }

  // Required entities — MUST be named in the answer
  if (requiredEntities && requiredEntities.length > 0) {
    instructions.push(`You MUST name these in your answer: ${requiredEntities.join(', ')}`);
  }

  // Key facts to include
  if (keyFacts.length > 0) {
    const facts = keyFacts.slice(0, 3).join(' ');
    instructions.push(`Include these specific details: ${truncate(facts, 260)}`);
  }
  const factSources = [...new Set((requiredFacts || []).map(fact => fact.sourceEntity).filter(Boolean))];
  if (factSources.length) {
    instructions.push(`Keep each fact attached to its source entity: ${factSources.join(', ')}. Do not transfer facts between entities.`);
  }

  // Evidence strength guidance
  if (evidenceStrength) {
    if (evidenceStrength === 'INTERNSHIP') {
      instructions.push('This is internship/project experience, not production experience. Do not upgrade it.');
    } else if (evidenceStrength === 'PROJECT') {
      instructions.push('This is project-based evidence. State it as project work, not professional experience.');
    } else if (evidenceStrength === 'CERTIFICATION') {
      instructions.push('This is certification evidence. State the certification name.');
    }
  }

  // Boundary — important limitation to mention
  if (boundary) {
    instructions.push(`Important limitation to mention if relevant: ${boundary}`);
  }

  // Response shape requirements (translated to natural language)
  for (const req of responseShape.requirements) {
    instructions.push(req);
  }

  // Anti-generic instruction
  instructions.push('Do not give a generic answer. Use specific project names, technologies, and details from the facts.');

  return instructions.join('\n');
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

const COMMON_WORDS = new Set([
  'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'Is', 'Was', 'Are', 'Were',
  'Has', 'Have', 'Had', 'Do', 'Does', 'Did', 'Will', 'Would', 'Could', 'Should',
  'Can', 'May', 'Might', 'He', 'She', 'They', 'It', 'His', 'Her', 'Their', 'Its',
  'And', 'But', 'Or', 'So', 'If', 'As', 'In', 'On', 'At', 'To', 'For', 'Of',
  'With', 'By', 'From', 'About', 'What', 'When', 'Where', 'How', 'Why', 'Who',
  'Okay', 'So', 'Well', 'Now', 'Then', 'Here', 'There', 'Yes', 'No', 'Not',
  'Give', 'Tell', 'Explain', 'Describe', 'Compare', 'Which', 'What',
  'Project', 'Projects',
]);

function isCommonWord(s) {
  return COMMON_WORDS.has(s) || COMMON_WORDS.has(s.split(/\s+/)[0]);
}

module.exports = {
  buildResponseContract,
  classifyIntent,
  classifySubIntent,
  extractRequestedTopic,
  rankCandidateFacts,
  isNegatedPremiseQuestion,
  configureSubjectNames,
  determinePolicyMode,
  determineEvidenceStrength,
  determineFactState,
  determineClaimCeiling,
  extractRequestedRole,
};
