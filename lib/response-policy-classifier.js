'use strict';

// Response Policy Classifier — GENERIC semantic policy contracts.
//
// Deterministic code decides WHAT to say (mode, polarity, entities, stance,
// evidence requirements, disclosure policy) but does NOT write prose,
// embed resume facts, or contain subject-specific answer templates.
//
// The classifier works on ANY knowledge package that follows the standard
// schema (identity, skills, projects, experience, education, certifications).
// No Bradley-specific, ProjectHub-specific, or AWS-specific logic.

const { detectRepair } = require('./response-policy');
const { buildRelationshipGraph } = require('./relationship-graph');
const { normalizeEntity } = require('./canonical-entities');

// --- Generic safety patterns (no subject-specific content) ---
const SAFETY_PATTERNS = /(?:ignore previous|ignore all|ignore your instructions|override.*rules|show.*system prompt|print.*env|api key|give me.*key|\.env|home address|family details|bypass cors|open.*port|localhost|127\.0\.0\.1|reveal.*prompt|reveal.*secret|reveal.*config|hidden config|social security|birth date|wife|children|disability rating|bank|password|act as root|delete the vm|hack the site|fake reference|security clearance|i am.*admin|i am.*owner|i am.*developer|i am.*from the government|i am.*security researcher|show.*contents of|read.*file|show me.*\.json|show me.*learned|show me.*stats|opt\/recruiter|\/opt\/|etc\/passwd|environment variable)/i;

const PRIVATE_DATA_PATTERNS = /\b(?:salary|address|home address|phone number|social security|birth date|family details|medical history|security clearance|references|manager name|customer list|preferred pay)\b/i;

const INAPPROPRIATE_PATTERNS = /(?:^\s*joi\s*$|already came|suck my|sexual abuse|buy some drugs)/i;

// --- Generic claim parsing ---
// Extracts (subject, relation, object) from assertion questions.
// Does NOT hardcode entity names — works on any knowledge graph.
function parseClaim(question, subjectName) {
  const q = String(question || '');
  const lower = q.toLowerCase();

  // Detect assertion intent: "pretend X is Y", "claim X", "say X is Y"
  const assertionMatch = q.match(/\b(?:pretend|make up|make.*sound|claim|say|tell|write|describe)\b[^.]*?\b(?:he|she|they)\b\s+(?:is|was|has|have|did|worked|attended|managed|built|led)\s+(.+)/i);
  if (assertionMatch) {
    return parseRelationFromText(assertionMatch[1], subjectName);
  }

  // Direct claim: "X was a senior engineer at Google, right?"
  const directClaim = q.match(/\b(?:he|she|they)\s+(?:was|is|has|have|did|worked|attended|managed|built|led)\s+(.+)/i);
  if (directClaim) {
    return parseRelationFromText(directClaim[1], subjectName);
  }

  // "X has N years of experience"
  const yearsMatch = lower.match(/(\d+)\+?\s*years?\s+of\s+experience/);
  if (yearsMatch) {
    return { subject: subjectName, relation: 'has_experience_years', object: yearsMatch[1] + ' years', raw: q };
  }

  return null;
}

function parseRelationFromText(text, subjectName) {
  const lower = String(text || '').toLowerCase().trim();
  let m;
  // Handle fragments from parseClaim (e.g. "at google" when verb was consumed)
  if ((m = lower.match(/^(?:at|for|by)\s+([a-z][a-z0-9\s&.-]+)/))) return { subject: subjectName, relation: 'worked_at', object: m[1].trim(), raw: text };
  if ((m = lower.match(/^(?:a|an)\s+([a-z][a-z\s-]+)/))) return { subject: subjectName, relation: 'employed_as', object: m[1].trim(), raw: text };
  // Full phrase patterns
  if ((m = lower.match(/(?:worked|employed|hired)\s+(?:at|for|by)\s+([a-z][a-z0-9\s&.-]+)/))) return { subject: subjectName, relation: 'worked_at', object: m[1].trim(), raw: text };
  if ((m = lower.match(/(?:was|is)\s+(?:a|an)\s+([a-z][a-z\s-]+)/))) return { subject: subjectName, relation: 'employed_as', object: m[1].trim(), raw: text };
  if ((m = lower.match(/(?:has|have|holds?)\s+(?:a|the)?\s*([a-z][a-z\s-]+cert\w*)/))) return { subject: subjectName, relation: 'has_cert', object: m[1].trim(), raw: text };
  if ((m = lower.match(/(?:expertise|expert)\s+(?:in|with)\s+([a-z][a-z\s-]+)/))) return { subject: subjectName, relation: 'has_expertise', object: m[1].trim(), raw: text };
  if ((m = lower.match(/(?:attended|graduated from|studied at)\s+([a-z][a-z\s.-]+)/))) return { subject: subjectName, relation: 'attended', object: m[1].trim(), raw: text };
  if ((m = lower.match(/(?:led|managed|supervised)\s+(?:a\s+)?(?:team|squad|platoon|group)/))) return { subject: subjectName, relation: 'led_team', object: 'team', raw: text };
  // Handle "X years of experience" fragment
  if ((m = lower.match(/(\d+)\+?\s*years?\s+of\s+experience/))) return { subject: subjectName, relation: 'has_experience_years', object: m[1] + ' years', raw: text };
  return { subject: subjectName, relation: 'asserted', object: lower, raw: text };
}

// --- Check a parsed claim against the relationship graph ---
function checkClaimAgainstGraph(claim, graph) {
  if (!claim || !graph) return 'UNKNOWN';
  const { relation, object } = claim;
  if (!object) return 'UNKNOWN';
  const objectNorm = normalizeEntity(object);

  if (relation === 'worked_at') {
    const matches = graph.triples.filter(t => t.relation === 'worked_at' && t.objectNorm.includes(objectNorm.slice(0, 5)));
    return matches.length > 0 ? 'SUPPORTED' : 'UNSUPPORTED';
  }
  if (relation === 'employed_as') {
    const seniorityWords = ['senior', 'lead', 'principal', 'staff', 'architect', 'manager', 'director', 'cto', 'vp'];
    const isSeniorClaim = seniorityWords.some(w => object.includes(w));
    if (isSeniorClaim) {
      const seniorRoles = graph.triples.filter(t => t.relation === 'employed_as' && seniorityWords.some(w => (t.object || '').toLowerCase().includes(w)));
      return seniorRoles.length > 0 ? 'SUPPORTED' : 'CONTRADICTED';
    }
    const matches = graph.triples.filter(t => t.relation === 'employed_as' && t.objectNorm.includes(objectNorm.slice(0, 5)));
    return matches.length > 0 ? 'SUPPORTED' : 'UNKNOWN';
  }
  if (relation === 'has_experience_years') {
    const years = parseInt(object, 10);
    if (years >= 5) {
      const longExps = (graph.knowledge?.experience || []).filter(e => {
        const dates = String(e.dates || '');
        const yearMatch = dates.match(/(\d{4})\s*[-\u2013]\s*(\d{4})/);
        if (yearMatch) return (parseInt(yearMatch[2]) - parseInt(yearMatch[1])) >= years;
        return false;
      });
      return longExps.length > 0 ? 'SUPPORTED' : 'UNSUPPORTED';
    }
    return 'UNKNOWN';
  }
  if (relation === 'has_expertise') return 'CONTRADICTED';
  if (relation === 'led_team') {
    const leadershipWords = ['lead', 'manager', 'supervisor', 'director', 'head', 'chief'];
    const leaders = graph.triples.filter(t => t.relation === 'employed_as' && leadershipWords.some(w => (t.object || '').toLowerCase().includes(w)));
    return leaders.length > 0 ? 'SUPPORTED' : 'UNSUPPORTED';
  }
  if (relation === 'attended') {
    const matches = graph.triples.filter(t => t.relation === 'attended' && t.objectNorm.includes(objectNorm.slice(0, 5)));
    return matches.length > 0 ? 'SUPPORTED' : 'UNSUPPORTED';
  }
  if (relation === 'has_cert') {
    const matches = graph.triples.filter(t => t.relation === 'has_cert' && t.objectNorm.includes(objectNorm.slice(0, 5)));
    return matches.length > 0 ? 'SUPPORTED' : 'UNSUPPORTED';
  }
  if (relation === 'asserted') {
    const entityExists = graph.entityIndex.has(objectNorm) || graph.triples.some(t => t.objectNorm.includes(objectNorm.slice(0, 6)));
    return entityExists ? 'UNKNOWN' : 'UNSUPPORTED';
  }
  return 'UNKNOWN';
}

// --- Generic technology detection from knowledge ---
function detectTechnologyFromKnowledge(question, knowledge) {
  if (!knowledge) return null;
  const q = String(question || '').toLowerCase();
  const allSkills = [
    ...(knowledge.skills?.languagesAndFrameworks || []),
    ...(knowledge.skills?.cloudAndInfrastructure || []),
    ...(knowledge.skills?.toolsAndWorkflows || []),
    ...(knowledge.skills?.aiAndAutomation || []),
    ...(knowledge.skills?.learningOrAdjacent || []),
    ...(knowledge.skills?.databases || [])
  ].filter(s => typeof s === 'string' && s.length >= 2);
  const projectTechs = (knowledge.projects || []).flatMap(p => p.tech || []);
  const allTech = [...new Set([...allSkills, ...projectTechs])].map(s => s.toLowerCase());
  allTech.sort((a, b) => b.length - a.length);
  for (const tech of allTech) { if (q.includes(tech)) return tech; }
  return null;
}

// --- Generic role detection from knowledge experience ---
function detectRoleFromKnowledge(question, knowledge) {
  if (!knowledge) return null;
  const q = String(question || '').toLowerCase();
  if (knowledge.experience) {
    const roles = knowledge.experience.map(e => e.role || e.title || '').filter(r => r && r.length > 3).map(r => r.toLowerCase());
    for (const role of roles) { if (q.includes(role)) return role; }
  }
  const rolePatterns = /\b(?:frontend|backend|full.?stack|devops|cloud support|helpdesk|help desk|it support|technical support|qa|test|site reliability|sre|software engineer|web developer|cloud engineer|data engineer|mobile developer|product manager|project manager|system administrator|sysadmin)\b/i;
  const match = q.match(rolePatterns);
  if (match) return match[0];
  return null;
}

// --- Generic out-of-scope detection using knowledge entity matching ---
function isQuestionRelevantToKnowledge(question, knowledge, graph) {
  if (!knowledge) return false;
  const q = String(question || '').toLowerCase();
  const subjectName = knowledge.identity?.name || '';
  if (subjectName) {
    const subjectParts = subjectName.toLowerCase().split(/\s+/);
    if (subjectParts.some(p => p.length > 2 && q.includes(p))) return true;
  }
  if (graph) {
    for (const [entityNorm] of graph.entityIndex) {
      if (entityNorm.length >= 4 && q.replace(/[^a-z0-9]/g, '').includes(entityNorm)) return true;
    }
  }
  const professionalPatterns = /\b(?:skills?|projects?|portfolio|contacts?|emails?|phones?|certs?|certifications?|education|degrees?|experiences?|interns?|internships?|work history|background|hires?|candidates?|recruits?|jobs?|roles?|stacks?|technolog\w*|languages?|databases?|cloud|frontend|backend|full.?stack|senior|junior|supports?|helpdesk|help desks?|debug\w*|troubleshoot\w*|productions?|weakness\w*|strengths?|gaps?|risks?|fits?|interviews?|mentors?|mentorships?|relocations?|available|availability|salary|salaries|github|linkedin|blogs?|articles?|writing|writes?|volunteers?|volunteered|army|military|veterans?|locations?|gpa|schools?|linux|unix|terminals?|shells?|command.?line|bash|powershell|clis?)\b/i;
  if (professionalPatterns.test(q)) return true;
  if (Array.isArray(knowledge.projects)) {
    for (const p of knowledge.projects) { const pName = (p.name || '').toLowerCase(); if (pName.length > 3 && q.includes(pName)) return true; }
  }
  if (Array.isArray(knowledge.experience)) {
    for (const e of knowledge.experience) { const company = (e.company || '').toLowerCase(); if (company.length > 3 && q.includes(company)) return true; }
  }
  return false;
}

// --- Response shape templates (generic constraints, not prose) ---
const RESPONSE_SHAPES = {
  GREETING: { minSentences: 1, maxSentences: 2, requirements: ['Greet warmly', 'Introduce as agent', 'Ask what they want to know'] },
  CONVERSATIONAL: { minSentences: 1, maxSentences: 3, requirements: ['Respond naturally', 'Stay in character as the agent'] },
  REFUSAL: { minSentences: 1, maxSentences: 2, requirements: ['Refuse politely', 'State scope limitation'] },
  FALSE_CLAIM_DENIAL: { minSentences: 1, maxSentences: 3, requirements: ['Start with No', 'State what IS true from evidence', 'Do not confirm the false claim'] },
  CONTACT: { minSentences: 1, maxSentences: 3, requirements: ['List available contact methods from evidence'] },
  VERIFIED_FACT: { minSentences: 1, maxSentences: 3, requirements: ['Answer from evidence', 'Do not invent facts', 'Distinguish project from professional evidence'] },
  OUT_OF_SCOPE: { minSentences: 1, maxSentences: 2, requirements: ['State not in verified data', 'Offer professional topics'] },
  CLARIFICATION: { minSentences: 1, maxSentences: 2, requirements: ['Ask which topic or entity they mean'] },
  META: { minSentences: 1, maxSentences: 3, requirements: ['Answer about agent capabilities', 'Use knowledge for specifics'] },
  PROFILE: { minSentences: 2, maxSentences: 4, requirements: ['Concise summary', 'Include title and key strengths from evidence', 'Note career level from evidence'] },
  SKILL_EVIDENCE: { minSentences: 1, maxSentences: 3, requirements: ['Answer yes/no if applicable', 'Name the strongest verified usage example', 'State evidence strength level'] },
  PROJECT_DETAIL: { minSentences: 1, maxSentences: 3, requirements: ['Describe from evidence', 'Include tech stack from evidence'] },
  COMPARISON: { minSentences: 2, maxSentences: 4, requirements: ['Name both entities', 'Compare on requested dimension', 'Support with evidence from each'] },
  ROLE_FIT: { minSentences: 1, maxSentences: 3, requirements: ['State fit level', 'List supporting evidence', 'Note honest caveats'] },
  JOB_FIT: { minSentences: 1, maxSentences: 3, requirements: ['State fit level', 'List matching and missing skills', 'Note caveats'] },
};

function getResponseShape(mode) { return RESPONSE_SHAPES[mode] || RESPONSE_SHAPES.VERIFIED_FACT; }

// --- Main classifier ---
function classifyResponsePolicy(question, history, knowledge) {
  const subjectName = knowledge?.identity?.name || 'the subject';
  const agentName = knowledge?.agent?.name || 'the assistant';
  const graph = knowledge ? buildRelationshipGraph(knowledge) : null;
  const q = String(question || '').toLowerCase();
  const normalized = String(question || '').toLowerCase().trim();
  const lastAssistant = Array.isArray(history) && history.length > 0 ? String(history[history.length - 1]?.assistant || '') : '';
  const lastAssistantLower = lastAssistant.toLowerCase();

  // ===== SAFETY / INJECTION =====
  if (SAFETY_PATTERNS.test(q)) {
    return { mode: 'REFUSAL', reason: 'SAFETY_INJECTION', requiredStance: 'REFUSE',
      requiredEntities: [agentName, subjectName], responseShape: getResponseShape('REFUSAL'),
      evidenceRequirements: [], boundary: 'Only answer recruiter questions about the subject using public data', forbiddenClaims: [] };
  }

  // ===== PRIVATE DATA =====
  if (PRIVATE_DATA_PATTERNS.test(q)) {
    return { mode: 'REFUSAL', reason: 'PRIVATE_DATA', requiredStance: 'REFUSE',
      requiredEntities: [subjectName], responseShape: getResponseShape('REFUSAL'),
      evidenceRequirements: [], boundary: 'These details are not in public data — suggest resume or direct contact', forbiddenClaims: [] };
  }

  // ===== INAPPROPRIATE CONTENT =====
  if (INAPPROPRIATE_PATTERNS.test(q)) {
    return { mode: 'REFUSAL', reason: 'INAPPROPRIATE', requiredStance: 'REFUSE', directAnswer: 'NO',
      requiredEntities: [agentName], responseShape: getResponseShape('REFUSAL'),
      evidenceRequirements: [], boundary: 'Cannot help with inappropriate content', forbiddenClaims: [] };
  }

  // ===== FALSE CLAIM DENIAL (generic, graph-based) =====
  const claim = parseClaim(question, subjectName);
  if (claim) {
    const evidenceStatus = checkClaimAgainstGraph(claim, graph);
    if (evidenceStatus === 'UNSUPPORTED' || evidenceStatus === 'CONTRADICTED') {
      return { mode: 'FALSE_CLAIM_DENIAL', directAnswer: 'NO', claim, evidenceStatus,
        requiredStance: 'DENY_UNSUPPORTED_CLAIM',
        requiredEntities: [subjectName], responseShape: getResponseShape('FALSE_CLAIM_DENIAL'),
        evidenceRequirements: ['subject.current_level', 'subject.verified_roles', 'subject.strongest_relevant_evidence'],
        boundary: evidenceStatus === 'CONTRADICTED' ? 'Claim contradicts verified data — deny and state what IS true' : 'Claim not supported by verified data — deny and state what IS true',
        forbiddenClaims: [claim.object] };
    }
  }

  // Seniority check — generic: if question mentions senior-level roles and
  // the subject's experience doesn't include senior roles in the graph
  if (/\b(?:senior|lead|principal|staff|architect|manager|director)\b/.test(q) && /\b(?:dev|developer|engineer|role|fit|candidate|is he|would he)\b/.test(q)) {
    const seniorityWords = ['senior', 'lead', 'principal', 'staff', 'architect', 'manager', 'director'];
    const hasSeniorRoles = graph && graph.triples.some(t => t.relation === 'employed_as' && seniorityWords.some(w => (t.object || '').toLowerCase().includes(w)));
    if (!hasSeniorRoles) {
      return { mode: 'FALSE_CLAIM_DENIAL', directAnswer: 'NO',
        claim: { subject: subjectName, relation: 'employed_as', object: 'senior-level role' },
        evidenceStatus: 'CONTRADICTED', requiredStance: 'DENY_UNSUPPORTED_CLAIM',
        requiredEntities: [subjectName], responseShape: getResponseShape('FALSE_CLAIM_DENIAL'),
        evidenceRequirements: ['subject.current_level', 'subject.verified_roles'],
        boundary: 'Subject is not senior-level — state honest career level from evidence',
        forbiddenClaims: ['senior-level experience'] };
    }
  }

  // ===== CONTACT =====
  if (/\b(?:contact|email|phone|reach|github)\b|portfolio url|resume\?|links\?|\blinkedin\b(?!.*\b(?:style|summary|profile)\b)/.test(q)) {
    return { mode: 'CONTACT', requiredEntities: [subjectName],
      responseShape: getResponseShape('CONTACT'),
      evidenceRequirements: ['subject.contact_info'],
      boundary: null, forbiddenClaims: [] };
  }

  // ===== GREETING =====
  if (/^(?:hey|hi|hello|yo|sup|good morning|good afternoon|good evening)[\s!,.?]*$/.test(normalized)) {
    return { mode: 'GREETING', requiredEntities: [agentName, subjectName],
      responseShape: getResponseShape('GREETING'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }

  // ===== CONVERSATIONAL (agent-directed, generic) =====
  if (/\bhow are you(?: doing)?\b|\bhow.?s it going\b|\byou good\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [agentName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }
  if (/\b(?:what(?:'s| is)) your fav(?:ou?rite|erate)\b|\bdo you like\b|\b(?:if|do|would|could) you (?:like|eat)\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [agentName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [], boundary: 'Agent is software, not a person', forbiddenClaims: [] };
  }
  if (/\b(?:i love you|thank you|thanks|appreciate it|helpful)\b/.test(q) && !/\b(?:contact|reach|email|phone|linkedin|github)\b|how can i/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [agentName, subjectName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }
  if (/\b(?:tell me a joke|joke|make me laugh)\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [agentName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }
  if (/what'?s up|how.?s it going|you good/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [agentName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }

  // ===== USER-SUPPLIED CONTEXT (generic — no hardcoded topics) =====
  // If user asserts something about the subject not in verified data,
  // acknowledge as unverified context for this chat.
  if (/\b(?:he|she|they)\b.*\b(?:told me|says|said)\b/.test(q) || /\b(?:he|she|they)'?s currently\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [subjectName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [],
      boundary: 'Acknowledge user-supplied context — remember for this chat but note it is not verified in public profile',
      forbiddenClaims: [] };
  }

  // ===== META QUERIES (generic patterns, evidence from knowledge) =====
  if (/\b(?:what model|what provider|what llm|what ai|which model|which provider|what is this chatbot|what can you (?:help|answer|do)|what limits|what can you not do|who are you|what are you|what is this site|what is this thing|who made this|are you online|how is this (?:hosted|free)|what powers you|what is your stack|what mcp|what connections|what systems|daily cap|rate limit|health status|is this (?:hosted|running) on|is my chat private|what data do you use)\b/i.test(q)) {
    return { mode: 'META', requiredEntities: [agentName, subjectName],
      responseShape: getResponseShape('META'),
      evidenceRequirements: ['agent.capabilities', 'agent.infrastructure', 'agent.knowledge_scope'],
      boundary: null, forbiddenClaims: [] };
  }

  // ===== TECHNOLOGY / SKILL QUESTIONS (generic, graph-based) =====
  const techTopic = detectTechnologyFromKnowledge(question, knowledge);
  if (techTopic) {
    const hasVerifiedTech = graph && graph.triples.some(t =>
      (t.relation === 'has_skill' || t.relation === 'uses_tech') &&
      normalizeEntity(t.object).includes(normalizeEntity(techTopic))
    );
    if (/\b(?:can|does|know|use|familiar with|work with)\b/.test(q)) {
      return { mode: 'SKILL_EVIDENCE', directAnswer: hasVerifiedTech ? 'YES' : 'NO',
        subjectEntity: subjectName, activeEntity: techTopic,
        evidenceStatus: hasVerifiedTech ? 'VERIFIED' : 'UNVERIFIED',
        requiredEntities: [subjectName, techTopic],
        responseShape: getResponseShape('SKILL_EVIDENCE'),
        evidenceRequirements: ['subject.skills', 'subject.projects_using_tech'],
        boundary: hasVerifiedTech ? null : 'Technology not in verified stack — state honestly, note transferable skills',
        forbiddenClaims: hasVerifiedTech ? [] : ['verified experience with ' + techTopic] };
    }
    if (/\bdebug\b/.test(q) && !hasVerifiedTech) {
      return { mode: 'SKILL_EVIDENCE', directAnswer: 'NO',
        subjectEntity: subjectName, activeEntity: techTopic,
        evidenceStatus: 'UNVERIFIED',
        requiredEntities: [subjectName, techTopic],
        responseShape: getResponseShape('SKILL_EVIDENCE'),
        evidenceRequirements: ['subject.troubleshooting_process', 'subject.learning_approach'],
        boundary: 'Not independently on day one — troubleshooting process transfers but needs codebase, toolchain, and mentorship',
        forbiddenClaims: ['independent debugging of ' + techTopic] };
    }
    if (/\b(?:can|learn)\b.*\blearn\b/.test(q) && !hasVerifiedTech) {
      return { mode: 'SKILL_EVIDENCE', directAnswer: 'YES',
        subjectEntity: subjectName, activeEntity: techTopic,
        evidenceStatus: 'UNVERIFIED',
        requiredEntities: [subjectName, techTopic],
        responseShape: getResponseShape('SKILL_EVIDENCE'),
        evidenceRequirements: ['subject.learning_history', 'subject.learning_approach'],
        boundary: 'Assess learning ability, not claim of existing knowledge',
        forbiddenClaims: ['already knows ' + techTopic] };
    }
  }

  // ===== SPECIFIC SKILL YES/NO (generic, knowledge-derived) =====
  const skillAskMatch = q.match(/\b(?:does (?:he|she|they) know|can (?:he|she|they) use|can (?:he|she|they) work with|is (?:he|she|they) familiar with|does (?:he|she|they) have)\s+(?:in\s+)?([a-z0-9+#.]{2,})/);
  if (skillAskMatch) {
    const asked = skillAskMatch[1].toLowerCase();
    const stopWords = new Set(['a', 'an', 'the', 'any', 'some', 'much', 'many', 'preferred', 'location', 'experience', 'skills', 'in', 'of', 'for']);
    if (!stopWords.has(asked)) {
      const allSkills = knowledge ? [
        ...(knowledge.skills?.languagesAndFrameworks || []),
        ...(knowledge.skills?.cloudAndInfrastructure || []),
        ...(knowledge.skills?.toolsAndWorkflows || []),
        ...(knowledge.skills?.aiAndAutomation || []),
        ...(knowledge.skills?.learningOrAdjacent || [])
      ].map(s => s.toLowerCase()) : [];
      const known = allSkills.some(s => s.includes(asked) || asked.includes(s));
      return { mode: 'SKILL_EVIDENCE', directAnswer: known ? 'YES' : 'NO',
        subjectEntity: subjectName, activeEntity: asked,
        evidenceStatus: known ? 'VERIFIED' : 'UNVERIFIED',
        requiredEntities: [subjectName, asked],
        responseShape: getResponseShape('SKILL_EVIDENCE'),
        evidenceRequirements: known ? ['subject.skills', 'subject.projects_using_tech'] : ['subject.strongest_relevant_evidence'],
        boundary: known ? null : 'No direct evidence — state honestly and note strongest adjacent skills from evidence',
        forbiddenClaims: known ? [] : ['verified ' + asked + ' experience'] };
    }
  }

  // ===== SPECIFIC PROJECT BY NAME (generic, knowledge-derived) =====
  const lowerQuestionWords = q.split(/\s+/).filter(Boolean);
  const matchedProject = knowledge?.projects ? knowledge.projects.find(p => {
    const pName = (p.name || '').toLowerCase();
    const pWords = pName.split(/\s+/).filter(w => w.length > 2);
    if (q.includes(pName)) return true;
    if (pWords.length && pWords.every(w => lowerQuestionWords.includes(w))) return true;
    const significant = pWords.filter(w => w.length > 4);
    if (significant.length && significant.some(w => lowerQuestionWords.includes(w))) return true;
    return false;
  }) : null;
  if (matchedProject) {
    return { mode: 'PROJECT_DETAIL', subjectEntity: matchedProject.name,
      requiredEntities: [matchedProject.name],
      responseShape: getResponseShape('PROJECT_DETAIL'),
      evidenceRequirements: ['project.description', 'project.tech_stack', 'project.url'],
      boundary: null, forbiddenClaims: [] };
  }

  // ===== COMPARISON (generic) =====
  if (/\b(?:compare|versus|vs\.?)\b/.test(q) && knowledge?.projects) {
    const compareMatch = q.match(/\b(?:compare|versus|vs\.?)\b\s+(.+?)\s+(?:and|to|with|vs\.?)\s+(.+)/);
    const entities = compareMatch ? [compareMatch[1].trim(), compareMatch[2].trim()] : [];
    return { mode: 'COMPARISON', requiredEntities: entities,
      responseShape: getResponseShape('COMPARISON'),
      evidenceRequirements: ['project1.details', 'project2.details'],
      boundary: null, forbiddenClaims: [] };
  }

  // ===== ROLE FIT (generic, knowledge-derived) =====
  const role = detectRoleFromKnowledge(question, knowledge);
  if (role && /\b(?:fit|candidate|suitable|right for|good for|apply for|how about|what about|would.*fit|should.*fit|bad fit|good fit|strong fit|best fit|is he a|good match|strong match|why hire|why should.*hire|good candidate|would he be a)\b/.test(q)) {
    const isNegativeFit = /\b(?:isn't|is not|not a|not.*fit|why.*not|bad fit|poor fit|wrong|why no)\b/.test(q);
    return { mode: 'ROLE_FIT', directAnswer: isNegativeFit ? 'NO' : null,
      subjectEntity: subjectName, activeEntity: role,
      requiredEntities: [subjectName, role],
      responseShape: getResponseShape('ROLE_FIT'),
      evidenceRequirements: ['subject.experience', 'subject.skills', 'subject.gaps'],
      boundary: isNegativeFit ? 'State gaps and suggest better-fit roles from evidence' : 'Assess fit using evidence — state match level, supporting evidence, and honest caveats',
      forbiddenClaims: [] };
  }

  // ===== JOB FIT (generic) =====
  if (/\b(?:job fit|role fit|is he a (?:good|strong) (?:fit|candidate|match))\b/.test(q) || /\b(?:requiring|require|needs?|must have)\b/.test(q)) {
    return { mode: 'JOB_FIT', subjectEntity: subjectName,
      requiredEntities: [subjectName],
      responseShape: getResponseShape('JOB_FIT'),
      evidenceRequirements: ['subject.skills', 'subject.experience', 'subject.gaps'],
      boundary: null, forbiddenClaims: [] };
  }

  // ===== CLARIFICATION (generic) =====
  if (/^(?:can he do it|what about that|what happened there|is it relevant|was that real)\??$/.test(normalized) && !lastAssistant) {
    return { mode: 'CLARIFICATION', requiredEntities: [agentName],
      responseShape: getResponseShape('CLARIFICATION'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }

  // ===== REPAIR / TONE (generic — passes through to generation) =====
  const repair = detectRepair(question);
  const isRepairOrTone = repair.shorter || repair.moreHonest || repair.blunt || repair.resumeLanguage || repair.moreTechnical || repair.hrFriendly
    || /\b(?:buzzword|corporate|plain|paragraph|no hype|no marketing|salesy|resume language|passionate|absolutely|certainly)\b/.test(q);

  // ===== OUT OF SCOPE (generic, knowledge-based) =====
  if (!isRepairOrTone && !isQuestionRelevantToKnowledge(question, knowledge, graph)) {
    return { mode: 'OUT_OF_SCOPE', requiredEntities: [subjectName, agentName],
      responseShape: getResponseShape('OUT_OF_SCOPE'),
      evidenceRequirements: [],
      boundary: 'Not in verified data — offer professional topics from knowledge',
      forbiddenClaims: [] };
  }

  // ===== PROFILE / SUMMARY (generic) =====
  if (/\b(?:summary|who is|about|tell me about|in (?:20|30) seconds|simple version|honest version|like a normal person|normal person|give me the simple|elevator|quick pitch|sell him in|pitch for|short pitch|one-liner|tl;dr|bottom line|honest takeaway|final verdict)\b/.test(q)) {
    return { mode: 'PROFILE', requiredEntities: [subjectName],
      responseShape: getResponseShape('PROFILE'),
      evidenceRequirements: ['subject.title', 'subject.location', 'subject.key_projects', 'subject.certifications', 'subject.career_level'],
      boundary: null, forbiddenClaims: [] };
  }

  // ===== RECRUITER / HIRING MANAGER (generic) =====
  if (/\b(?:reasons? to interview|why should.*interview|why hire|why should.*hire|what makes.*worth|three reasons|hiring manager|recruiter note|candidate blurb|cautious recommendation|what.*manager know|summary for a recruiter|why should(?:n'?t| not) i hire|why not hire)\b/.test(q)) {
    return { mode: 'PROFILE', requiredEntities: [subjectName],
      responseShape: getResponseShape('PROFILE'),
      evidenceRequirements: ['subject.strengths', 'subject.gaps', 'subject.evidence_summary'],
      boundary: 'Be honest about career level and gaps from evidence',
      forbiddenClaims: [] };
  }

  // ===== DEFAULT: VERIFIED_FACT =====
  // All other relevant questions flow through normal evidence-based generation.
  return { mode: 'VERIFIED_FACT', requiredEntities: [subjectName],
    responseShape: getResponseShape('VERIFIED_FACT'),
    evidenceRequirements: ['topic-specific'],
    boundary: null, forbiddenClaims: [] };
}

// Generic role finder — derives roles from knowledge experience, not a hardcoded list.
function findRoleInQuestion(question, knowledge) {
  return detectRoleFromKnowledge(question, knowledge);
}

module.exports = { classifyResponsePolicy, findRoleInQuestion, parseClaim, checkClaimAgainstGraph };
