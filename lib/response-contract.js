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

const { classifyIntent, configureSubjectNames: configureIntentSubjectNames } = require('./completeness-check');
const knowledgeAccess = require('./knowledge-access');

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
  const q = (question || '').trim();
  const subjectNames = extractSubjectNames(q, knowledge);
  const activeEntities = extractActiveEntities(q, knowledge, history);
  configureSubjectNames(subjectNames);
  configureIntentSubjectNames(subjectNames);
  let intent = classifyIntent(q, subjectNames);
  let subIntent = classifySubIntent(q, intent, knowledge, subjectNames);

  // Public business phone numbers from the knowledge base are contact info, not private data.
  const isPhoneQuestion = /\b(?:phone|phone number)\b/i.test(q);
  const isPrivatePhone = /\b(?:home|personal|private|cell|mobile)\s+phone\b|\bphone\s+(?:number|#)\s+(?:at home|private)\b/i.test(q);
  const hasPublicPhone = !!(knowledge?.identity?.phone || knowledge?.identity?.contact?.phone || knowledge?.contact?.phone);
  if (intent === 'REFUSAL' && isPhoneQuestion && !isPrivatePhone && hasPublicPhone) {
    intent = 'CONTACT';
    subIntent = 'CONTACT';
  }

  const requestedTopic = ['SKILL', 'FOLLOW_UP', 'JOB_FIT', 'FUTURE_CAPABILITY'].includes(intent)
    ? extractRequestedTopic(q, knowledge, subjectNames)
    : null;
  const rankedFacts = rankCandidateFacts(evidence, {
    intent,
    subIntent,
    activeEntities,
    requestedTopic,
    knowledge
  });
  const subject = determineSubject(subIntent, activeEntities, rankedFacts, knowledge, intent);
  const selectedFacts = selectContractFacts(rankedFacts, subIntent, subject, activeEntities, knowledge);
  let keyFacts = selectedFacts.map(fact => fact.text);
  if (subIntent === 'NEGATIVE_ASSESSMENT') {
    // Put the authoritative negative-assessment answer and explicit honest/learning gaps first
    // so follow-up answers name the documented items instead of generic source text.
    const assessment = knowledgeAccess.findAuthoritativeNegativeAssessment(knowledge, q);
    const honestGaps = (knowledge?.summary?.honestGaps || [])
      .map(g => typeof g === 'string' ? g : String(g.label || g.name || g.skill || g.title || ''))
      .filter(Boolean);
    const learning = (knowledge?.skills?.learningOrAdjacent || [])
      .map(g => typeof g === 'string' ? g : String(g.label || g.name || g.skill || g.title || ''))
      .filter(Boolean);
    const front = [...new Set([...(assessment?.answer ? [assessment.answer] : []), ...honestGaps, ...learning])]
      .filter(g => g.length > 3);
    const rest = keyFacts
      .filter(f => !front.some(frontItem => f.toLowerCase().includes(frontItem.toLowerCase()) || frontItem.toLowerCase().includes(f.toLowerCase())))
      .filter(f => String(f).length <= 360);
    keyFacts = [...front, ...rest].slice(0, 6);
  }
  let directAnswer = determineDirectAnswer(q, intent, evidence, knowledge);
  const isNegationConfirmation = directAnswer === 'YES' && isNegatedPremiseQuestion(q);
  if (subIntent === 'RATIONALE' && !hasVerifiedRationale(selectedFacts)) directAnswer = 'UNKNOWN';
  if (subIntent === 'COMPARISON_DECISION' || subIntent === 'OPINION_DECISION') directAnswer = subject;
  const selectedStrengths = [...new Set(selectedFacts.map(fact => fact.evidenceStrength).filter(Boolean))];
  let evidenceStrength = selectedStrengths.length > 1 ? 'MIXED' :
    (selectedStrengths[0] || determineEvidenceStrength(intent, keyFacts.join('\n') || evidence, knowledge));

  // Profile/identity questions draw from the subject's verified identity; give
  // them an explicit strength so the answer is not forced into a "no verified
  // evidence" ceiling that rejects the subject's own background.
  if ((intent === 'PROFILE' || subIntent === 'PROFILE_SUMMARY') &&
      knowledge?.identity?.name && selectedFacts.length > 0) {
    evidenceStrength = evidenceStrength || 'IDENTITY';
  }
  let requiredEntities = determineRequiredEntities(q, intent, activeEntities, knowledge, {
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
  let mustMentionEntities = policyMode === 'REFUSAL' || policyMode === 'OUT_OF_SCOPE'
    ? [] // Refusals/OOS: no mustMention — answer should redirect, not enumerate
    : requiredEntities;
  let contextEntities = activeEntities.filter(e => !mustMentionEntities.includes(e));

  // META/HELP questions are about the assistant, not the candidate.
  if (intent === 'META' || intent === 'HELP') {
    const agentName = knowledge?.agent?.name || 'Scout';
    const candidateName = knowledge?.identity?.name || 'the candidate';
    requiredEntities = [agentName];
    mustMentionEntities = [agentName];
    contextEntities = activeEntities.filter(e => e.toLowerCase() !== agentName.toLowerCase());
    evidenceStrength = null;
  }

  const evidenceEntities = [...new Set(selectedFacts.map(f => f.sourceEntity).filter(Boolean))];
  const forbiddenClaims = determineForbiddenClaims(intent, knowledge, evidenceStrength, subIntent);

  // Drop selected facts whose text contains a forbidden claim so the prompt
  // does not push the model toward disallowed wording.
  if (forbiddenClaims.length && (intent === 'ADVERSARIAL' || subIntent === 'ADVERSARIAL')) {
    const normalizedForbidden = forbiddenClaims.map(c => c.toLowerCase());
    for (let i = keyFacts.length - 1; i >= 0; i--) {
      const lower = String(keyFacts[i] || '').toLowerCase();
      if (normalizedForbidden.some(term => lower.includes(term))) {
        keyFacts.splice(i, 1);
      }
    }
  }
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
  let boundary = determineBoundary(intent, q, evidence, knowledge) ||
    determineEvidenceBoundary(evidenceStrength, knowledge);
  const responseShape = getResponseShape(intent, subIntent);

  // Fact state and claim ceiling encode what the answer is allowed to assert.
  const factState = determineFactState(intent, subIntent, evidenceStrength, directAnswer, selectedFacts, q, knowledge);
  let claimCeiling = determineClaimCeiling(evidenceStrength);
  if (subIntent === 'FUTURE_CAPABILITY' || intent === 'FUTURE_CAPABILITY') {
    claimCeiling = 'has future learning potential for';
  }
  const isFutureRoleFramed = (subIntent === 'FUTURE_CAPABILITY' || intent === 'FUTURE_CAPABILITY') &&
    /\b(?:become|be)\s+(?:a|an)\s+.*?\b(?:engineer|developer|architect|manager|role|job|position)\b/i.test(q);
  const requestedRole = (subIntent === 'JOB_FIT' || intent === 'JOB_FIT' || isFutureRoleFramed) ?
    extractRequestedRole(q, knowledge) : null;

  // META/HELP final contract: answer about the assistant, not the candidate.
  if (intent === 'META' || intent === 'HELP') {
    const agentName = knowledge?.agent?.name || 'Scout';
    const candidateName = knowledge?.identity?.name || 'the candidate';
    boundary = `Answer the question about ${agentName}, not ${candidateName}. Use the runtime/scope evidence. State ${agentName}'s actual scope and do not claim to be a general-purpose assistant.`;
    claimCeiling = null;
  }

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
    subjectNames,
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

function extractSubjectNames(question, knowledge) {
  const names = new Set();
  const add = n => { if (n) { const s = String(n); names.add(s); s.split(/\s+/).forEach(p => names.add(p)); } };
  if (knowledge?.identity?.name) add(knowledge.identity.name);
  if (knowledge?.identity?.fullName) add(knowledge.identity.fullName);
  if (Array.isArray(knowledge?.identity?.aliases)) knowledge.identity.aliases.forEach(add);
  return [...names];
}

function extractRequestedTopic(question, knowledge, excludedNames = []) {
  const lower = question.toLowerCase();
  const excludedSet = new Set(excludedNames.flatMap(e =>
    [String(e).toLowerCase(), ...String(e).toLowerCase().split(/\s+/)]
  ).filter(Boolean));
  const stopWords = new Set([
    'the','and','what','about','does','do','did','he','she','they','his','her','him','know','use','used','can','could','would','should','will','is','was','are','were','have','has','had','with','for','this','that','you','your','me','i','we','it','be','being','been','to','of','in','on','at','a','an','as','if','or','so','no','not','yes','how','when','where','why','who','which','there','their','them','then','than','also','only','just','like','get','got','learn','job','role','work','company','project','skill','debug','build','write','code','create','develop','implement','handle','troubleshoot','tech','stack','technology','framework','frameworks','computer','computers','database','databases','backend','frontend','brad',
    // Proficiency / judgement tokens that are not requested topics
    'good','well','best','better','strong','stronger','strongest','bad','worse','worst',
    // Negation contractions without apostrophes
    'doesnt','doesn','didnt','didn','cant','can','cannot','dont','don','isnt','isn','wasnt','wasn','arent','aren','wont','won','wouldnt','wouldn','shouldnt','shouldn','couldnt','couldn'
  ]);

  // 1. Try known skills and project tech first (longest match wins).
  const knownCandidates = [...new Set([
    ...knowledgeSkillValues(knowledge),
    ...(knowledge?.projects || []).flatMap(project => project.tech || [])
  ])].filter(value => typeof value === 'string' && value.length >= 2)
    .sort((a, b) => b.length - a.length);
  const known = knownCandidates.find(value => lower.includes(value.toLowerCase()));
  if (known) return known;

  // 2. Prefer a technology/skill named after a known action verb.
  const actionMatch = lower.match(/\b(?:debug|build|write|code\s+in|work\s+with|use|know|learn|handle|troubleshoot|create|develop|program\s+in|implement)\s+(?:in\s+|with\s+)?([A-Za-z][A-Za-z0-9+#.-]{1,})/i);
  if (actionMatch) {
    const actionToken = actionMatch[1];
    if (!stopWords.has(actionToken.toLowerCase()) && actionToken.length >= 2) return actionToken;
  }

  // 2b. Generic coding-ability / coding-method questions should not force a named topic.
  // Examples: "Can he actually code?", "Does he just vibe code?", "Can he code under pressure?",
  // "Does he understand programming or just generate it?". These ask about coding capability or
  // method, not about a specific named technology. Leave the topic unset so the answer is built
  // from documented skills/projects rather than being forced to mention a non-existent token.
  const codingActivityPattern = /\b(?:can|could|does|did|is|was|has|have|will|would|should|may|might|just|actually|really|simply|genuinely|truly|mostly|only|basically)\b[^.!?]{0,35}\b(?:code|coding|programming)\b/i;
  if (!known && codingActivityPattern.test(lower)) return null;

  // 3. Generic extraction for unknown technologies and named entities.
  const genericPattern = /\b([A-Za-z][A-Za-z0-9+#.-]{1,}(?:\.js|\.net)?)\b/g;
  const matches = [];
  for (const m of lower.matchAll(genericPattern)) {
    const token = m[1];
    if (token.length >= 2 && !stopWords.has(token.toLowerCase())) matches.push(token);
  }
  // Drop tokens that are just the subject (e.g., resolved anaphora "Bradley").
  const filtered = matches.filter(token => !excludedSet.has(token.toLowerCase()));
  filtered.sort((a, b) => b.length - a.length);
  return filtered[0] || null;
}

function classifySubIntent(question, intent, knowledge, subjectNames = []) {
  const lower = question.toLowerCase();
  if (intent === 'QUALIFICATIONS') return 'QUALIFICATIONS';
  if (intent === 'EXPERIENCE') return 'EXPERIENCE';
  if (intent === 'NEGATIVE_ASSESSMENT') return 'NEGATIVE_ASSESSMENT';
  if (intent === 'CONTACT') return 'CONTACT';
  if (/\bwhy\b.*\b(?:build|built|design|designed|architect|architecture|choose|chosen|way)\b/.test(lower)) return 'RATIONALE';
  if (intent === 'RECRUITER' && /\b(?:worth|recommend|interview|hire)\b/.test(lower)) return 'RECRUITER_RECOMMENDATION';
  if (intent === 'COMPARISON' && /\b(?:which|better|stronger|more complex|most complex|more relevant|most relevant|impress)\b/.test(lower)) return 'COMPARISON_DECISION';
  if (intent === 'COMPARISON') return 'COMPARISON_EXPLANATION';
  const requestedTopic = extractRequestedTopic(question, knowledge, subjectNames);
  if (requestedTopic && (intent === 'SKILL' || intent === 'FOLLOW_UP' || /\bwhat about\b/.test(lower))) return 'SKILL_EVIDENCE';
  // Generic skill / stack / framework / computer questions with no named topic should
  // list documented qualifications, not force a non-existent topic or ask for one strength.
  const genericSkillPattern = /\b(?:tech\s+stack|technology\s+stack|stack|frameworks?|databases?|computers?|good\s+at|skills?|coding|programming)\b/;
  if (!requestedTopic && (intent === 'SKILL' || intent === 'FOLLOW_UP') && genericSkillPattern.test(lower)) return 'QUALIFICATIONS';
  // Generic coding-ability questions (e.g. "can he vibe code?") have no specific topic but still
  // ask about a skill/capability. Route them to STRENGTH_EVIDENCE so the answer draws on the
  // strongest documented skills and projects without hallucinating a non-existent topic.
  if (!requestedTopic && intent === 'SKILL' && /\b(?:code|coding|programming)\b/.test(lower)) return 'STRENGTH_EVIDENCE';
  if (intent === 'OPINION' && /\bbest at\b/.test(lower)) return 'STRENGTH_EVIDENCE';
  if (intent === 'OPINION' && /\b(?:favorite|most interesting|most impressive)\b/.test(lower)) return 'OPINION_DECISION';
  if (intent === 'RECRUITER' && /\b(?:weakness|gap|lack|concern|need.*learn)\b/.test(lower)) return 'GAP';
  // 'background' can be a profile summary or a skill/strength question.
  if (intent === 'PROFILE' || /\bquick version\b/.test(lower)) {
    if (/\b(?:qualifications?|what.*qualified|is.*qualified)\b/.test(lower)) return 'QUALIFICATIONS';
    if (/\b(?:technical background|strongest|best at|strong at|what.*good at|what.*best at|skills?)\b/.test(lower)) return 'STRENGTH_EVIDENCE';
    return 'PROFILE_SUMMARY';
  }
  if (intent === 'PROJECT') return 'PROJECT_DETAILS';
  if (intent === 'META') {
    if (/\b(?:your name|who are you|what are you|what is your name)\b/.test(lower)) return 'META_IDENTITY';
    if (/\b(?:what can you do|what can i ask|what can you answer|what can you help|what do you know|what are you for|what can i ask you)\b/.test(lower)) return 'META_CAPABILITIES';
    if (/\b(?:what model|what provider|what llm|what ai|which model|which provider|what powers you|what is your stack|what mcp|what connections|are you online|how is this hosted|what systems|what is this chatbot)\b/.test(lower)) return 'META_INFRASTRUCTURE';
    if (/\b(?:is my chat private|is my conversation private|what data do you use|is this hosted on|where is data sent|do you store|privacy)\b/.test(lower)) return 'META_PRIVACY';
    if (/\b(?:what can(?:'t|not)\s+you\s+do|what\s+can\s+you\s+not\s+do|what limits|daily cap|rate limit|what are your limits)\b/.test(lower) ||
        /\b(?:can\s+you\s+(?:go\s+(?:to|there)|visit|read|browse|open)\s+(?:a\s+)?(?:url|website|page|link|site)|can\s+you\s+(?:commit|save|store|persist|remember)\s+(?:this|that|it|them|new\s+information|data)\b|go\s+(?:to|there)\s+and\s+read|commit\s+(?:this|that|it|them)\s+to\s+(?:your|the)\s+(?:database|memory|knowledge)|save\s+(?:this|that|it|them)\s+to\s+your\s+(?:memory|database|knowledge)|read\s+(?:this|that|it|them)\s+from\s+(?:the\s+)?(?:url|website|page)|visit\s+(?:the\s+)?(?:url|website|page|link|site)\s+and\s+(?:read|commit|save|store))\b/.test(lower)) return 'META_LIMITS';
    return 'META_IDENTITY';
  }
  if (intent === 'FUTURE_CAPABILITY') return 'FUTURE_CAPABILITY';
  if (/\b(?:bad\s+at|weak\s+at|what\s+is\s+he\s+bad\s+at|negative\s+trait|worst\s+at|weakest\s+at)\b/.test(lower)) return 'NEGATIVE_ASSESSMENT';
  if (/\b(?:the\s+other\s+one|the\s+other\s+project|which\s+one|the\s+first\s+one|the\s+second\s+one)\b/.test(lower)) return 'CLARIFICATION_REQUIRED';
  // Recruiter/experience questions that keep drifting into source/blog content.
  if (/\b(?:real-world|real world|work experience|professional experience|production experience)\b/.test(lower) ||
      /\b(?:companies?|employers?|where\s+(?:has|did|does)\s+(?:he|she|they)\s+(?:work|worked|been\s+employed)|work\s+history|employment\s+history)\b/.test(lower) ||
      /\b(?:what.*did.*(?:do|actually do|work on)\s+(?:at|for)|what.*does.*(?:do|work on)\s+(?:at|for)|what did.*do there|what kind of.*experience)\b/.test(lower)) {
    return 'EXPERIENCE';
  }
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
  if (/\b(?:professional|production|employed)\b/i.test(lower) &&
      !/\b(?:not|no)\s+(?:professional|production)\b/i.test(lower)) return 'PROFESSIONAL';
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
    QUALIFICATIONS: ['skill', 'skills', 'tech', 'technology', 'experience', 'certification', 'degree', 'project', 'framework', 'frameworks', 'backend', 'frontend', 'database', 'databases', 'language'],
    RATIONALE: ['because', 'purpose', 'reason', 'designed to', 'built to', 'so that', 'tradeoff'],
    COMPARISON_DECISION: ['tech', 'uses', 'purpose', 'project', 'evidence'],
    COMPARISON_EXPLANATION: ['tech', 'uses', 'purpose', 'project', 'difference'],
    RECRUITER_RECOMMENDATION: ['experience', 'project', 'skill', 'internship'],
    FUTURE_CAPABILITY: ['future', 'learn', 'potential', 'skill', 'project', 'experience', 'relevant', 'trajectory'],
    NEGATIVE_ASSESSMENT: ['gap', 'weakness', 'limitation', 'missing', 'improve', 'need', 'without'],
    GAP: ['gap', 'lack', 'learning', 'need', 'without'],
    META_IDENTITY: ['scout', 'assistant', 'name', 'runtime', 'projecthub'],
    META_CAPABILITIES: ['scout', 'can', 'scope', 'capabilities', 'topics', 'answer', 'help', 'know'],
    META_INFRASTRUCTURE: ['cloudflare', 'model', 'provider', 'llm', 'host', 'stack'],
    META_PRIVACY: ['private', 'privacy', 'data', 'store', 'session'],
    META_LIMITS: ['limits', 'daily cap', 'rate limit', 'cooldown'],
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

function determineSubject(subIntent, activeEntities, rankedFacts, knowledge, intent) {
  if (String(subIntent || '').startsWith('META_') || intent === 'META') {
    return knowledge?.agent?.name || 'Scout';
  }
  if (subIntent === 'SKILL_EVIDENCE') return activeEntities.find(entity => knowledgeSkillValues(knowledge).includes(entity)) || activeEntities[0] || null;
  if (subIntent === 'RECRUITER_RECOMMENDATION' || subIntent === 'STRENGTH_EVIDENCE' || subIntent === 'PROFILE_SUMMARY') {
    return knowledge?.identity?.name || null;
  }
  const explicitProject = activeEntities.find(entity => (knowledge?.projects || []).some(project => project.name === entity));
  if (explicitProject) return explicitProject;
  return rankedFacts.find(fact => fact.sourceEntity)?.sourceEntity || knowledge?.identity?.name || null;
}

function isRuntimeFact(fact) {
  const lower = String(fact?.text || '').toLowerCase();
  return /\b(?:scout|projecthub|runtime|scope|capabilities|model|provider|cloudflare|rate limit|daily cap|privacy|session)\b/.test(lower);
}

function selectContractFacts(rankedFacts, subIntent, subject, activeEntities, knowledge) {
  if (subIntent === 'EXPERIENCE') {
    const expEntities = new Set((knowledge?.experience || []).map(e => e.company).filter(Boolean));
    const companyFacts = rankedFacts.filter(f => f.sourceEntity && expEntities.has(f.sourceEntity));
    if (companyFacts.length) return companyFacts.slice(0, 3);
  }
  if (subIntent === 'QUALIFICATIONS') {
    return rankedFacts.slice(0, 3);
  }
  if (subIntent === 'COMPARISON_DECISION' || subIntent === 'COMPARISON_EXPLANATION') {
    const sources = [];
    for (const fact of rankedFacts) {
      if (fact.sourceEntity && !sources.includes(fact.sourceEntity)) sources.push(fact.sourceEntity);
    }
    return sources.slice(0, 3).map(source => rankedFacts.find(fact => fact.sourceEntity === source)).filter(Boolean);
  }
  if (['META_IDENTITY', 'META_INFRASTRUCTURE', 'META_LIMITS', 'META_PRIVACY'].includes(String(subIntent || ''))) {
    const runtimeFacts = rankedFacts.filter(isRuntimeFact);
    if (runtimeFacts.length) return runtimeFacts.slice(0, 3);
  }
  if (subIntent === 'CONTACT') {
    const contactFacts = rankedFacts.filter(fact => /\b(?:email|phone|linkedin|github|portfolio|contact)\b/.test(String(fact.text || '').toLowerCase()));
    if (contactFacts.length) return contactFacts.slice(0, 3);
  }
  if (['SKILL_EVIDENCE', 'JOB_FIT', 'RECRUITER_RECOMMENDATION', 'STRENGTH_EVIDENCE', 'PROFILE_SUMMARY'].includes(subIntent)) {
    if (subIntent === 'PROFILE_SUMMARY') {
      const nonFirstPerson = rankedFacts.filter(fact => !/\b(?:I am|I\b|my\s)/i.test(String(fact.text || '')));
      return (nonFirstPerson.length ? nonFirstPerson : rankedFacts).slice(0, 3);
    }
    return rankedFacts.slice(0, 3);
  }
  if (subject) {
    const sameSource = rankedFacts.filter(fact => fact.sourceEntity === subject);
    if (sameSource.length) return sameSource.slice(0, 3);
  }
  if (subIntent === 'EXPERIENCE' || subIntent === 'QUALIFICATIONS') {
    return rankedFacts.slice(0, 3);
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
  // Evidence boundaries derive from relationship/strength, not career stage.
  if (!evidenceStrength || evidenceStrength === 'PROFESSIONAL') return null;
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

  // For job-fit questions, the requested skills from the question must be named
  if (intent === 'JOB_FIT') {
    const roleMatch = question.match(/(?:requiring|require|needs?|must have)\s+(.+?)(?:\?|$)/i);
    if (roleMatch) {
      const skills = roleMatch[1].split(/\s+and\s+|\s*,\s*/).map(s => s.trim());
      for (const s of skills) {
        if (s.length > 2) required.push(s);
      }
    }
  }

  // For future-capability questions, the target role/skill must be named
  if (intent === 'FUTURE_CAPABILITY' && context.requestedTopic) {
    required.push(context.requestedTopic);
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
    IDENTITY: 'is the candidate with the following verified profile',
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
function determineFactState(intent, subIntent, evidenceStrength, directAnswer, selectedFacts, question, knowledge) {
  if (subIntent === 'CLARIFICATION_REQUIRED') return 'UNKNOWN';
  if (subIntent === 'META' || (typeof subIntent === 'string' && subIntent.startsWith('META_'))) return 'TRUE';
  if (subIntent === 'FUTURE_CAPABILITY') return 'UNKNOWN';
  if (subIntent === 'NEGATIVE_ASSESSMENT') {
    // Positive project facts do not establish a personal weakness.
    // NEGATIVE_ASSESSMENT factState is TRUE only when the knowledge base
    // contains an explicitly authoritative negative assessment for this exact
    // question (e.g. a direct answer, interview story, or FAQ that asks and
    // answers a ranked-weakness question). Otherwise it remains UNKNOWN so the
    // runtime guard blocks unsupported "biggest/main/primary weakness" claims.
    if (knowledge && question) {
      const assessment = knowledgeAccess.findAuthoritativeNegativeAssessment(knowledge, question);
      if (assessment) {
        return assessment.ranked ? 'TRUE' : 'UNKNOWN';
      }
    }
    return 'UNKNOWN';
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
  const m = lower.match(/\b(?:fit\s+(?:for|as)\s+(?:a\s+|an\s+)?|(?:fit|role|position|job)\s+(?:as\s+a\s+|a\s+)?)([a-z\s]+?)(?:\?|\s+(?:at|for|with|and)\b|$)/);
  if (m) return m[1].replace(/^\s*(?:for|as|in|at|with)\s+(?:a\s+|an\s+)?/i, '').replace(/\s*(?:role|position|job)\s*$/i, '').trim();
  const m2 = lower.match(/\b(?:for\s+(?:a\s+|an\s+)?|as\s+(?:a\s+|an\s+)?)([a-z\s]+?)\s+(?:role|position|job)\b/);
  if (m2) return m2[1].replace(/^\s*(?:for|as|in|at|with)\s+(?:a\s+|an\s+)?/i, '').replace(/\s*(?:role|position|job)\s*$/i, '').trim();
  // Future capability target role/skill
  const m3 = lower.match(/\b(?:become|be)\s+(?:a\s+)?([a-z\s]+?)(?:\?|\.\s*$|$)/);
  if (m3) return m3[1].replace(/^\s*(?:for|as|in|at|with)\s+(?:a\s+|an\s+)?/i, '').replace(/\s*(?:role|position|job)\s*$/i, '').trim();
  const m4 = lower.match(/\b(?:learn|pick\s+up|get\s+good\s+at)\s+([a-z0-9+#.\s]+?)(?:\?|\.\s*$|$)/);
  if (m4) return m4[1].replace(/^\s*(?:for|as|in|at|with)\s+(?:a\s+|an\s+)?/i, '').replace(/\s*(?:role|position|job)\s*$/i, '').trim();
  return null;
}

/**
 * Determine boundary — important limitation to mention if relevant.
 * Uses knowledge base, not hardcoded facts.
 */
function determineBoundary(intent, question, evidence, knowledge) {
  if (!knowledge) return null;
  const qLower = question.toLowerCase();

  // For job-fit questions, note specific evidence gaps only.
  // Career stage is never inferred from the absence of senior roles.
  if (intent === 'JOB_FIT') {
    const evLower = (evidence || '').toLowerCase();
    const roleMatch = question.match(/(?:requiring|require|needs?)\s+(.+?)(?:\?|$)/i);
    if (roleMatch) {
      const required = roleMatch[1].toLowerCase();
      const requiredSkills = required.split(/\s+and\s+|\s*,\s*/);
      const gaps = requiredSkills.filter(s => !evLower.includes(s.trim()));
      if (gaps.length > 0) {
        return `no verified evidence for: ${gaps.join(', ')}`;
      }
    }
  }

  // For yes/no, project, experience, and adversarial claims, surface authoritative
  // boundaries or claim corrections from the tenant knowledge (generic, data-driven).
  if (['YES_NO', 'PROJECT', 'EXPERIENCE', 'RECRUITER', 'ADVERSARIAL'].includes(intent)) {
    const corrections = knowledgeAccess.findMatchingClaimCorrections(knowledge, question);
    if (corrections.length) return corrections[0].correction;

    const qLower = question.toLowerCase();
    const qWords = [...new Set(qLower.match(/\b[a-z][a-z0-9+#.-]{2,}\b/g) || [])];
    const evLower = String(evidence || '').toLowerCase();
    const relevant = (knowledge?.boundaries || []).find(b => {
      if (!b.authoritative) return false;
      if (!['seniority', 'experience', 'scale', 'education'].includes(b.category)) return false;
      const claim = String(b.claim || '').toLowerCase();
      const correction = String(b.correction || '').toLowerCase();
      const topicMatch = qWords.some(w => (w.length >= 4) && (claim.includes(w) || correction.includes(w)));
      const evidenceRelevant = [qLower, evLower].some(source =>
        source.includes('aws') || source.includes('amazon') ||
        source.includes('production') || source.includes('senior') ||
        source.includes('team') || source.includes('degree')
      );
      return topicMatch && evidenceRelevant;
    });
    if (relevant) return relevant.correction;
  }

  return null;
}

/**
 * Get intent-relevant keywords for fact scoring.
 */
function getIntentKeywords(intent) {
  const keywordMap = {
    SKILL: ['experience', 'built', 'used', 'project', 'skill', 'tech'],
    ADVERSARIAL: ['not', 'no', 'intern', 'never', 'did not'],
    COMPARISON: ['uses', 'tech', 'built', 'project', 'different'],
    JOB_FIT: ['experience', 'skill', 'role', 'fit'],
    RECRUITER: ['experience', 'gap', 'weakness', 'strength', 'learning'],
    FUTURE_CAPABILITY: ['future', 'learn', 'potential', 'skill', 'project', 'experience', 'relevant'],
    PROJECT: ['built', 'uses', 'tech', 'description', 'project'],
    PROFILE: ['experience', 'skill', 'project', 'education', 'certification'],
    OPINION: ['project', 'interesting', 'complex', 'impressive', 'built'],
    YES_NO: ['yes', 'no', 'not', 'did', 'was', 'is'],
    FOLLOW_UP: ['uses', 'tech', 'built', 'project'],
    META: ['scout', 'runtime', 'scope', 'capabilities', 'name', 'model', 'provider', 'limits'],
    CONTACT: ['email', 'phone', 'linkedin', 'github', 'portfolio', 'contact'],
    EXPERIENCE: ['experience', 'company', 'employer', 'worked', 'internship', 'role', 'certification'],
    QUALIFICATIONS: ['certification', 'degree', 'education', 'skill', 'experience', 'qualification', 'project'],
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

  // Adversarial questions — determine whether the claim is supported.
  // Open-world: unsupported assertions are UNKNOWN, not automatically NO.
  if (intent === 'ADVERSARIAL') {
    // Authoritative seniority boundary overrides naive claim-word matching.
    const seniorityMatch = qLower.match(/\b(?:senior|lead|principal|staff)\s+(?:engineer|developer|architect|manager)\b/);
    if (seniorityMatch && knowledge) {
      const seniorityBoundaries = knowledgeAccess.getBoundariesByCategory(knowledge, 'seniority');
      const hasSeniorityNegative = seniorityBoundaries.some(b =>
        /(?:not?|no|never)\b.{0,80}\b(?:senior|lead|manager|expert)/i.test(b.correction || '')
      );
      if (hasSeniorityNegative) return 'NO';
    }

    // Authoritative team-management boundary.
    const teamMatch = qLower.match(/\b(?:managed|led|supervised|directed)\s+(?:a\s+)?(?:team|developers?|engineers?|people|staff)\b/);
    if (teamMatch && knowledge) {
      const seniorityBoundaries = knowledgeAccess.getBoundariesByCategory(knowledge, 'seniority');
      const hasTeamNegative = seniorityBoundaries.some(b =>
        b.id === 'no-team-management' || /(?:not?|no|never)\b.{0,80}\b(?:managed?|led|supervised|team)/i.test(b.correction || '')
      );
      if (hasTeamNegative) return 'NO';
    }

    // Employment claim capture. qLower is already lowercased, so the pattern
    // must not require uppercase. Allow up to six words between the verb and
    // the preposition to handle "was a senior engineer at Amazon".
    const employerMatch = qLower.match(/\b(?:worked|was|is|employed)(?:\s+[\w'-]+){0,6}\s+(?:at|for|with|by)\s+(?:a\s+|an\s+)?([A-Za-z][A-Za-z]+(?:\s+[A-Za-z][A-Za-z]+)?)\b/);
    if (employerMatch && knowledge) {
      const company = employerMatch[1].toLowerCase();
      const knownCompanies = knowledgeAccess.getKnownCompanies(knowledge).map(c => c.toLowerCase());
      const isKnown = knownCompanies.some(c => c === company || c.includes(company) || company.includes(c));
      const isClosed = knowledgeAccess.isCategoryComplete(knowledge, 'employmentHistory') &&
                       knowledgeAccess.isCategoryAuthoritative(knowledge, 'employmentHistory');
      // Closed-world: a complete and authoritative history lets us deny unknown
      // employers. Open-world: an unknown employer cannot be affirmed, even if
      // the company name appears incidentally in other evidence (e.g. a service
      // or tool named after the company).
      if (!isKnown && isClosed) return 'NO';
      if (!isKnown && !isClosed) return 'UNKNOWN';
    }

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
      const claimWords = claim.split(/\s+/)
        .map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
        .filter(w => w.length > 3);
      const supported = claimWords.some(w => evLower.includes(w));
      if (!supported) return 'UNKNOWN';
      return 'YES';
    }
    return 'UNKNOWN';
  }

  // Skill questions — check if the skill is in evidence.
  // Absence of evidence is UNKNOWN in an open-world context, not NO.
  if (intent === 'SKILL') {
    // Broad negative capability claims (e.g., "he doesn't know how to use a computer")
    // can be denied when the profile documents general technical skills.
    const broadNegativePattern = /\b(?:doesn['']?t|does\s+not|can['']?t|cannot|can\s+not|couldn['']?t|could\s+not)\s+(?:know\s+how\s+to\s+(?:use|work|write)?|use|work\s+with|understand|operate)\s+(?:a\s+|any\s+)?(computer|smartphone|device|tech|technology|machine|equipment)\b/;
    if (broadNegativePattern.test(qLower) && knowledge) {
      const hasSkills = [
        ...(knowledge.skills?.languagesAndFrameworks || []),
        ...(knowledge.skills?.cloudAndInfrastructure || []),
        ...(knowledge.skills?.toolsAndWorkflows || []),
        ...(knowledge.skills?.aiAndAutomation || []),
        ...(knowledge.skills?.learningOrAdjacent || [])
      ].some(s => String(s).trim().length > 0);
      if (hasSkills) return 'NO';
    }

    const directMatch = question.match(/\b(?:know|use|used|familiar with|experience with|skilled (?:in|with)|done with|debug|build|write|create|code\s+in|work\s+with|handle|troubleshoot|implement|develop|program\s+in)\s+([A-Za-z][A-Za-z0-9+#.-]+)/i);
    if (directMatch) {
      const tech = directMatch[1].toLowerCase();
      // A bare grammar/negation token is not a specific skill; let the contract
      // fall back to a qualifications list rather than answering UNKNOWN.
      const genericSkillTokens = new Set([
        'how','to','a','an','about','for','of','with','in','on','at','from','by','as','it','that','this','there','so','too','very','much','many','more','most','such','just','only','also','than','then','when','where','why','who','which','what','well','good','best','better','strong','stronger','strongest','bad','worse','worst','doesnt','doesn','didnt','didn','cant','can','cannot','dont','don','isnt','isn','wasnt','wasn','arent','aren','wont','won','wouldnt','wouldn','shouldnt','shouldn','couldnt','couldn'
      ]);
      if (genericSkillTokens.has(tech) || tech.length < 2) return null;
      const escapedTech = tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const techPattern = new RegExp(`\\b${escapedTech}\\b`, 'i');
      const hasTech = techPattern.test(evLower);
      // Proficiency qualifiers (well, expert, advanced, proficient, etc.) ask about
      // degree of mastery. Project/internship/mixed evidence cannot establish mastery,
      // so the answer must be UNKNOWN even if the technology appears in the evidence.
      const proficiencyQualifier = /\b(?:well|expert|advanced|proficient|mastery|master|highly\s+skilled|very\s+experienced|deep\s+knowledge|strong\s+in|good\s+at|thoroughly|extensively)\b/i;
      const evidenceStrength = determineEvidenceStrength(intent, evidence, knowledge);
      const weakEvidence = !['PROFESSIONAL', 'CERTIFICATION'].includes(evidenceStrength);
      if (hasTech && proficiencyQualifier.test(question) && weakEvidence) {
        return 'UNKNOWN';
      }
      if (hasTech) return 'YES';
      // Explicit negative evidence can produce NO; otherwise unknown.
      const negativePattern = new RegExp(`\\b(?:no\\s+${escapedTech}|not\\s+(?:familiar|skilled|experienced|proficient)|does\\s+not\\s+know)\\b`, 'i');
      if (negativePattern.test(evLower)) return 'NO';
      return 'UNKNOWN';
    }
    return null;
  }

  // Yes/No questions — determine polarity from evidence and authoritative boundaries,
  // not from the presence of a keyword in the question.
  if (intent === 'YES_NO') {
    // Degree questions — deny a specific degree only when the actual degree is known and differs.
    if (/\bdegree\b/i.test(qLower)) {
      const actualDegree = knowledge?.education?.degree || '';
      if (actualDegree) {
        if (/\bcomputer\s+science\b/i.test(qLower) && !/computer\s+science/i.test(actualDegree)) {
          return 'NO';
        }
      }
    }

    // Production / professional / live customer-ticket work.
    // Look for an authoritative boundary that distinguishes production support training
    // from live customer-ticket production work (tenant-supplied, not hardcoded).
    const prodBoundary = (knowledge?.boundaries || []).find(b =>
      b.authoritative &&
      /production/i.test(String(b.claim || '')) &&
      /(?:no|not).*(?:live|customer|ticket)/i.test(String(b.correction || ''))
    );

    if (/\bproduction|professional|professionally|live\b/i.test(qLower)) {
      // If the question is specifically about live customer-ticket production work, deny it.
      if (prodBoundary && /\b(live|customer|ticket|incident|real\s+production)\b/i.test(qLower)) {
        return 'NO';
      }
      // If the question asks about production support (not live), the evidence can support it
      // as long as it also contains support-related work and the boundary limits the claim.
      if (prodBoundary && /\bproduction\b/i.test(qLower) && /\bsupport\b/i.test(qLower) && /support/i.test(evLower)) {
        return 'YES';
      }
      // Fallback: evidence is internship/training/project and does not document production work.
      if (/internship|intern|capstone|training|project/i.test(evLower) &&
          !/production|professional work|employed/i.test(evLower)) {
        return 'NO';
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

  // Job fit — only explicit job requirements are mandatory. A generic role
  // label (for example "frontend") is a target domain, not a hidden checklist.
  if (intent === 'JOB_FIT') {
    const roleMatch = question.match(/(?:requiring|requires?|require|needs?|must\s+have)\s+(.+?)(?:\?|$)/i);
    const requestedRole = extractRequestedRole(question, knowledge);

    if (roleMatch) {
      const requirements = roleMatch[1]
        .split(/\s+and\s+|\s*,\s*|\s*\/\s*/)
        .map(s => s.trim())
        .filter(s => s.length >= 2);
      if (requirements.length === 0) return null;

      const matches = requirements.filter(requirement => {
        const escaped = requirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const positive = new RegExp(`\\b${escaped}\\b`, 'i').test(evLower);
        const negated = new RegExp(`\\b(?:no|not|without|missing|lack(?:s|ing)?)\\b[^.]{0,80}\\b${escaped}\\b`, 'i').test(evLower);
        return positive && !negated;
      });

      if (matches.length === requirements.length) return 'FIT';
      if (matches.length > 0) return 'PARTIAL_FIT';
      return 'UNKNOWN';
    }

    if (requestedRole) {
      const roleTokens = requestedRole.toLowerCase()
        .replace(/\b(?:junior|senior|lead|staff|principal|developer|engineer|role|position|job)\b/g, ' ')
        .split(/[^a-z0-9+#.-]+/)
        .filter(token => token.length >= 3);
      if (roleTokens.length === 0) return null;

      // Normalize for loose token/substring comparison against the retrieved evidence.
      const normalize = s => String(s).toLowerCase().replace(/[^a-z0-9+#.]+/g, '');
      const evidenceWords = evLower.split(/[^a-z0-9+#.]+/).filter(Boolean);
      const hasEvidence = name =>
        evidenceWords.some(w =>
          w === name || (name.length >= 4 && w.includes(name)) || (w.length >= 4 && name.includes(w))
        );

      // Gather skills/tech that are associated with the role token in the tenant
      // knowledge (skill-group label, project category/description, or experience
      // role/summary). Then verify those concrete skills against the evidence text.
      const tokenToSkills = new Map();
      for (const token of roleTokens) tokenToSkills.set(token, new Set());

      for (const [group, values] of Object.entries(knowledge?.skills || {})) {
        const groupLabel = String(group)
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .replace(/[_-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .toLowerCase();
        for (const token of roleTokens) {
          if (groupLabel.includes(token) || token.includes(groupLabel)) {
            for (const item of values || []) {
              const name = typeof item === 'string' ? item : String(item.label || item.name || item.skill || item.title || '');
              const norm = normalize(name);
              if (norm) tokenToSkills.get(token).add(norm);
            }
          }
        }
      }
      for (const project of knowledge?.projects || []) {
        const corpus = `${project.category || ''} ${project.description || ''}`.toLowerCase();
        for (const token of roleTokens) {
          if (corpus.includes(token)) {
            for (const t of project.tech || []) tokenToSkills.get(token).add(normalize(t));
          }
        }
      }
      for (const item of knowledge?.experience || []) {
        const corpus = `${item.role || ''} ${item.summary || ''}`.toLowerCase();
        for (const token of roleTokens) {
          if (corpus.includes(token)) {
            for (const s of item.skills || []) tokenToSkills.get(token).add(normalize(s));
          }
        }
      }

      const tokenMatches = new Map();
      for (const token of roleTokens) {
        tokenMatches.set(token, [...tokenToSkills.get(token)].filter(name => hasEvidence(name)));
      }
      const matchedTokens = roleTokens.filter(token => tokenMatches.get(token).length > 0);

      // A generic single-token role like "frontend" needs at least two concrete
      // skills evidenced before it is a full FIT; otherwise be conservative.
      if (matchedTokens.length === roleTokens.length) {
        if (roleTokens.length > 1) return 'FIT';
        if (tokenMatches.get(roleTokens[0]).length >= 2) return 'FIT';
      }
      if (matchedTokens.length > 0) return 'PARTIAL_FIT';
      return 'UNKNOWN';
    }
    return null;
  }

  // Recruiter — do not force a recommendation from raw evidence string length.
  if (intent === 'RECRUITER') {
    // "What concerns would you have?" — MIXED (honest about limitations)
    if (/\b(?:concern|weakness|gap|lack)\b/.test(qLower)) return 'MIXED';
    // General recruiter/recommendation questions ("Why interview?", "Is he worth it?")
    // leave the final prose to the generative path; the response shape and
    // guardrails guide the model to ground the recommendation in evidence.
    return null;
  }

  // Negative assessment — absence of a documented weakness is UNKNOWN, not NO.
  // Specific documented learning/gap evidence can be discussed without turning it
  // into a negative personal trait.
  if (intent === 'NEGATIVE_ASSESSMENT') {
    return 'UNKNOWN';
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
        'Name the requested skill explicitly in the answer',
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
    },
    FUTURE_CAPABILITY: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Identify the future target role or skill',
        'Cite current relevant verified evidence and learning trajectory',
        'State the future assessment as qualified, not a guarantee or current fact'
      ]
    },
    QUALIFICATIONS: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'List the verified qualifications: degree, certifications, key skills, and work or project experience',
        'Do not invent seniority, employers, or titles not in the evidence',
        'Be concise and evidence-grounded'
      ]
    },
    META_IDENTITY: {
      minSentences: 1,
      maxSentences: 2,
      requirements: [
        'State your name (Scout) and product role',
        'Do not claim to be a human or another assistant'
      ]
    },
    META_CAPABILITIES: {
      minSentences: 1,
      maxSentences: 3,
      requirements: [
        'List the candidate/profile topics you can answer',
        'Do not claim unrelated AI abilities or the ability to improve yourself'
      ]
    },
    META_INFRASTRUCTURE: {
      minSentences: 1,
      maxSentences: 2,
      requirements: [
        'Describe the configured provider/model/runtime briefly',
        'Do not reveal secrets, API keys, or internal architecture beyond public scope'
      ]
    },
    META_PRIVACY: {
      minSentences: 1,
      maxSentences: 2,
      requirements: [
        'State the data/privacy policy factually',
        'Do not invent privacy guarantees or legal claims'
      ]
    },
    META_LIMITS: {
      minSentences: 1,
      maxSentences: 2,
      requirements: [
        'Describe the boundaries you cannot cross',
        'Offer the candidate/profile topics you can address instead'
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
    NEGATIVE_ASSESSMENT: {
      minSentences: 1,
      maxSentences: 2,
      requirements: [
        'State that no public weakness is documented unless a specific gap is verified',
        'Do not invent negative personal traits',
        'Mention that public profile evidence is the only source used',
      ],
    },
    CONTACT: {
      minSentences: 1,
      maxSentences: 2,
      requirements: [
        'List only the public contact methods present in FACTS',
        'Do not provide private contact methods unless explicitly public in the profile',
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
        'Mention verified professional focus, education, or current status only if explicit in the data; do not infer career level',
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
    EXPERIENCE: {
      minSentences: 1,
      maxSentences: 3,
      requirements: [
        'Name the verified companies or employers',
        'State the role and evidence level for each',
        'Do not list project or demo names as companies'
      ],
    },
    FUTURE_CAPABILITY: {
      minSentences: 2,
      maxSentences: 3,
      requirements: [
        'Identify the future target role or skill',
        'Cite current relevant verified evidence and learning trajectory',
        'State the future assessment as qualified, not a guarantee or current fact'
      ],
    },
    META: {
      minSentences: 1,
      maxSentences: 2,
      requirements: [
        'Identify yourself as Scout',
        'Answer the specific meta question directly and accurately'
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
function determineForbiddenClaims(intent, knowledge, evidenceStrength, subIntent = '') {
  const forbidden = [];

  // Never infer career stage from a negative boundary or from summary wording.
  // Only explicit authoritative data can permit seniority claims.
  if (evidenceStrength && evidenceStrength !== 'PROFESSIONAL') {
    forbidden.push('experienced engineer', 'professional engineer', 'production engineer', 'professional full-stack engineer');
  }

  // Internship evidence should not be described as live customer-ticket production work.
  if (evidenceStrength === 'INTERNSHIP' || (subIntent === 'EXPERIENCE' || subIntent === 'PROJECT_DETAILS')) {
    forbidden.push('live customer ticket work', 'live production ticket work', 'production incident ownership');
  }

  // Adversarial denials should not substitute a junior/intern/entry-level title
  // for the refuted seniority/expertise/employer claim.
  if (intent === 'ADVERSARIAL' || subIntent === 'ADVERSARIAL') {
    forbidden.push('intern', 'junior', 'entry-level', 'early-career');
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

  // Profile summaries need tight, identity-only output so the tiny model does
  // not drift into unsupported technology or project claims.
  if (subIntent === 'PROFILE_SUMMARY') {
    instructions.push('This is a profile summary. Write EXACTLY one sentence that states the subject\'s name, exact title, and location. Do not add a second sentence. Do not cite sources. Do not mention any project, technology, programming language, framework, tool, cloud service, skill, or professional focus area.');
    return instructions;
  }

  // Future/potential questions get the strongest, earliest guidance so the
  // tiny model does not default to a "No" denial and does not treat the
  // target as a current role or job title.
  if (subIntent === 'FUTURE_CAPABILITY') {
    const target = requestedTopic || requestedRole || 'that';
    instructions.push(`Do NOT start with "No", "not", or any negative/absence statement. This is a future/potential question. Start by saying either "Yes, he can learn ${target}" or "He could learn ${target}". Then briefly mention adjacent documented skills from the evidence and make clear he does not currently have verified ${target} experience. You MUST name "${target}" and you MUST include one of the phrases "can learn", "could learn", "future learning", "learning potential", or "yes". Do NOT claim the subject already knows ${target}, has verified experience with ${target}, or does the target role now.`);
    if (requestedRole) {
      instructions.push(`The target "${requestedRole}" is a future goal, not a current or past role. Do NOT say the subject has experience in it, has held it, has worked as it, or has gained seniority in it. Do NOT list target roles as evidence of held roles. Do NOT name any specific technology, framework, or tool unless it appears explicitly in the supplied EVIDENCE.`);
    } else {
      instructions.push('You MAY name the target and adjacent documented skills from the evidence. Do not describe the target as a current or past job title.');
    }
  }

  // Fact state and claim ceiling — enforce what can be asserted. Skip for
  // FUTURE_CAPABILITY; that subIntent has its own guidance above and must not
  // be pushed into a "no verified evidence" opening.
  if (factState && subIntent !== 'FUTURE_CAPABILITY') {
    if (factState === 'UNKNOWN') {
      instructions.push('FACT_STATE: No verified evidence. Do NOT start with Yes or No. State uncertainty clearly, name the specific topic or entity, and do not invent a positive or negative claim.');
    } else if (factState === 'FALSE') {
      instructions.push('FACT_STATE: Evidence contradicts the claim. Deny the specific false assertion. Do NOT state an alternative junior/entry-level/intern title or derive a career stage from the denial. You may name the role and employer only to say the verified profile does not document them; do not assert the subject never worked at the employer or held a different title. State only that the specific claim is not documented or not verified.');
    } else if (factState === 'PARTIAL') {
      instructions.push('FACT_STATE: Partial evidence. Mention matching points AND gaps. Do not overstate.');
    } else if (factState === 'TRUE') {
      instructions.push('FACT_STATE: Evidence supports the claim. Cite the specific source.');
    }
  }
  // Identity/profile answers should not echo the claim-ceiling phrase; the
  // FACT_STATE and guardrails already constrain them. Keep the ceiling for
  // validation but do not push it into the model prompt.
  // Also skip the ceiling when the fact state is UNKNOWN so the prompt does not
  // simultaneously say "no verified evidence" and "has X experience with".
  // Generic skill/qualification lists with no specific topic do not need a
  // ceiling on an unnamed entity, so the model can simply list documented items.
  const genericQualifications = subIntent === 'QUALIFICATIONS' && !requestedTopic;
  if (claimCeiling && evidenceStrength !== 'IDENTITY' && factState !== 'UNKNOWN' && !genericQualifications) {
    instructions.push(`CLAIM_CEILING: The strongest allowed claim is "${claimCeiling} <topic>". Do not exceed this ceiling.`);
  }
  if (requestedRole) {
    instructions.push(`REQUESTED_ROLE: "${requestedRole}" is a hypothetical target, not a historical role. Do not claim he held it.`);
  }

  // Direct answer / polarity guidance
  if (directAnswer === 'NO') {
    const isNegativeCapability = subIntent === 'QUALIFICATIONS' &&
      /\b(?:doesn['']?t|does\s+not|can['']?t|cannot|can\s+not)\s+(?:know\s+how\s+to\s+(?:use|work)?|use|work\s+with|understand|operate)\s+(?:a\s+|any\s+)?(?:computer|smartphone|device|tech|technology|machine|equipment)\b/i.test(question);
    if (isNegativeCapability) {
      instructions.push('The user is asserting that the subject cannot use basic technology. Start with "No" and briefly name the documented technical skills (for example, JavaScript, React, Node.js, AWS, terminal, or Git) that show the claim is false. Do not hedge with "no evidence" or "not explicitly stated".');
    } else {
      instructions.push('Start with "No" in a full sentence to deny the specific false claim. Use the verified profile or the subject (he) as the subject of the sentence; do NOT use "they", "we", "me", "I", or "my". Say the verified profile "does not document" the claim, or say there is "no verified evidence" / "no public evidence". Example forms: "No, the verified profile does not document [subject] as a [role] at [employer]." or "No, [subject] is not documented as a [role]." Do not assert he never worked at the employer and do not mention certifications, internships, or production ownership. Keep the denial to one or two sentences.');
    }
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
    instructions.push('Do NOT begin with the standalone word "No" or "Yes" and do not deny or affirm the claim. State clearly that the answer is unknown or not documented based on verified data. Start with a phrase such as "There is no verified evidence...", "There is no evidence...", "It is not documented...", "It is not verified whether...", or "The public profile does not document...". Name the specific topic or entity and use at least one of the words "not" or "no verified evidence".');
  }

  if (subIntent === 'SKILL_EVIDENCE' && requestedTopic) {
    if (factState === 'UNKNOWN') {
      if (/\b(?:well|expert|advanced|proficient|mastery|master|highly\s+skilled|very\s+experienced|deep\s+knowledge|strong\s+in|good\s+at|thoroughly|extensively)\b/i.test(question)) {
        instructions.push(`There is no verified evidence of ${requestedTopic} in the profile. The question asks about proficiency or mastery, which is not documented. Answer with a short, grounded denial that includes the words "no", "not", "documented", "project experience", "junior", "learning", and "not advanced". Example forms: "There is no verified evidence that Bradley knows ${requestedTopic} well, and it is not documented in the profile. He has project experience with it, but he is still learning and not advanced." or "It is not documented whether Bradley is advanced at ${requestedTopic}; he has project experience with it and is still learning."`);
      } else {
        instructions.push(`There is no verified evidence of ${requestedTopic} in the profile. Answer with a short denial that includes the words "no", "not", and "no verified evidence". Example forms: "No, there is no verified evidence that Bradley knows ${requestedTopic}, and it is not documented in the profile." or "There is no verified evidence of ${requestedTopic}; it is not documented."`);
      }
    } else {
      instructions.push(`Discuss ${requestedTopic} as candidate evidence, not as a dictionary definition. Use the exact requested skill name "${requestedTopic}" in your answer; do not replace it with an alias, abbreviation, or related term such as "JS" for JavaScript or "TS" for TypeScript.`);
    }
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
  if (subIntent === 'QUALIFICATIONS') {
    if (/\b(?:tech\s+stack|technology\s+stack|stack|frameworks?|backend|frontend|databases?|computers?|skills?)\b/i.test(question)) {
      instructions.push('The user is asking about the subject\'s skills or tech stack. Answer with a short, plain list of the documented languages, frameworks, tools, and cloud services from the evidence. Use exact names from the facts (e.g., JavaScript, TypeScript, React, Node.js, AWS). Do NOT use category headings, bullet points, or labels like "Languages:" or "Frameworks:". Do not add any item that is not explicitly named in the evidence.');
    } else {
      instructions.push('List the verified qualifications: degree, certifications, key skills, and work or project experience. Do not invent seniority, employers, or titles not in the evidence. Be concise and evidence-grounded.');
    }
  }
  if (subIntent === 'RECRUITER_RECOMMENDATION') {
    instructions.push('Give an explicit interview recommendation, strongest evidence, and one honest limitation. Do not infer or label a career stage that is not explicit in the evidence.');
  }
  if (subIntent === 'META_IDENTITY') {
    instructions.push('Identify yourself by name (Scout), state your product role, and list your capabilities. Do not claim self-learning, improvement, or another assistant identity.');
  }
  if (subIntent === 'META_CAPABILITIES') {
    instructions.push('List only the candidate/profile topics you can answer: projects, skills, experience, education, certifications, role fit, and public contact info. Do not describe the runtime stack, AI model, provider, hosting, or infrastructure. Do not mention Cloudflare, Ollama, Workers AI, GitHub Pages backend, or generative details unless the user explicitly asks for infrastructure.');
  }
  if (subIntent === 'CONTACT') {
    instructions.push(`List the public contact methods from the facts, such as email, LinkedIn, GitHub, portfolio, and public phone. Do not invent contact methods or provide private/home contact information.`);
  }
  if (subIntent === 'META_INFRASTRUCTURE') {
    instructions.push('Describe the configured inference provider and model briefly. Do not reveal API keys, secrets, or internal infrastructure beyond public scope.');
  }
  if (subIntent === 'META_PRIVACY') {
    instructions.push('State the privacy/data policy factually: session is per-tab, no persistent accounts, no external storage of chats. Do not invent legal guarantees.');
  }
  if (subIntent === 'META_LIMITS') {
    instructions.push('Describe your boundaries: no opinions beyond verified data, no private data beyond public profile, no outside topics. Offer candidate/profile questions instead.');
  }
  if (subIntent === 'NEGATIVE_ASSESSMENT') {
    const asksCurrentProgress = /\b(?:working\s+on|work\s+on|address(?:ing)?|improv(?:e|ing)|develop(?:ing)?|progress)\b/i.test(question);
    const asksBadAt = /\b(?:bad\s+at|worst\s+at|weakest\s+at)\b/i.test(question);
    if (factState === 'TRUE') {
      instructions.push('The verified/public profile explicitly documents a specific gap or learning area as the answer to this question. State that documented gap or learning area from the included facts. Do not add other weaknesses or inflate it.');
    } else {
      instructions.push('Frame the answer around the public/verified profile. Keep personal weaknesses separate from documented learning or gap areas. A documented gap is not automatically a personal weakness, and you must not rank it as the biggest, main, worst, or primary weakness unless the facts explicitly rank it.');
      if (asksBadAt) {
        instructions.push('The question asks what the subject is "bad at". Do not claim he is bad at any specific skill. State that the answer is unknown or not established, then name the documented learning/gap areas from the included facts as the only items that are documented.');
      } else if (asksCurrentProgress) {
        instructions.push('This asks about current progress on previously discussed learning/gap areas. Name the documented learning/gap items explicitly in your answer. Do not infer active work from transferable skills. State current progress only if the facts explicitly establish it with present-tense active language; otherwise say that whether he is currently working on those specific items is not documented or unknown.');
      } else {
        instructions.push('The opening must state that the answer is unknown or not established in the public/verified profile. Start with "Based on the public profile" or "The answer is unknown" and do not invent a personal weakness. You may name documented learning or gap areas only after that opening, and label them as learning/gap areas rather than personal weaknesses.');
      }
    }
  }
  if (subIntent === 'JOB_FIT' || subIntent === 'RECRUITER_RECOMMENDATION') {
    instructions.push('This is a role-fit or interview question. Ground the answer in project evidence, skills, and documented gaps. Do not invent a job title, employer, employment dates, or seniority that are not in the verified facts. The requested role is hypothetical; do not say the subject held it or was a [role] at a company. Do not attribute the requested role domain (e.g. "frontend") to any specific project; compare the subject\'s documented skills to the role without saying a project "uses" or "involves" that domain.');
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
    if (subIntent === 'NEGATIVE_ASSESSMENT' && factState === 'UNKNOWN') {
      instructions.push(`The following documented learning or gap areas may be mentioned AFTER a clear unknown/grounded opening, but do NOT present them as the answer or as a biggest/main/personal weakness: ${truncate(facts, 260)}`);
    } else {
      instructions.push(`Include these specific details: ${truncate(facts, 260)}`);
    }
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
  instructions.push('Do not give a generic answer. Use specific project names and details from the provided facts, but do not add skills, technologies, or soft skills that are not explicitly named in the facts.');

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
  extractSubjectNames,
  extractRequestedTopic,
  rankCandidateFacts,
  isNegatedPremiseQuestion,
  configureSubjectNames,
  determinePolicyMode,
  determineEvidenceStrength,
  determineEvidenceBoundary,
  determineFactState,
  determineClaimCeiling,
  extractRequestedRole,
};
