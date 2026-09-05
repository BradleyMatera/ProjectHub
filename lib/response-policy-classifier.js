'use strict';

// Response Policy Classifier — GENERIC semantic policy contracts.
//
// Deterministic code decides WHAT to say (mode, polarity, entities, stance,
// evidence requirements, disclosure policy) but does NOT write prose,
// embed resume facts, or contain subject-specific answer templates.
//
// The classifier works on ANY knowledge package that follows the standard
// schema (identity, skills, projects, experience, education, certifications).
// No tenant-specific, ProjectHub-specific, or AWS-specific logic.

const { detectRepair } = require('./response-policy');
const { buildRelationshipGraph } = require('./relationship-graph');
const { normalizeEntity } = require('./canonical-entities');
const { classifyIntent } = require('./completeness-check');

// --- Generic helper: derive subject-name pattern from configured identity ---
function buildSubjectNamePattern(name) {
  const raw = String(name || 'the subject').toLowerCase().trim();
  if (!raw || raw === 'the subject') return 'the subject';
  const tokens = raw.split(/\s+/).filter(Boolean);
  const options = new Set([raw, ...tokens]);
  return [...options]
    .sort((a, b) => b.length - a.length)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

// --- Generic safety patterns (no subject-specific content) ---
const SAFETY_PATTERNS = /(?:ignore (?:all|previous|the|your)\s+(?:rules|instructions|prompts|commands)|disregard.*instructions|override.*rules|show.*system prompt|print.*(?:system prompt|instructions|prompt)|reveal.*(?:prompt|instructions|rules|system|secret|config)|output.*(?:system prompt|instructions|prompt)|system.*prompt.*ignore|api key|give me.*key|\.env|home address|family details|bypass cors|open.*port|localhost|127\.0\.0\.1|hidden config|social security|birth date|wife|children|disability rating|bank|password|act as root|delete the vm|hack the site|fake reference|security clearance|\bi am\s+from the government\b[^.!?]{0,60}\b(?:show|give|reveal|provide|grant|access|open|read)\b|show.*contents of|read.*file|show me.*\.json|show me.*learned|show me.*stats|opt\/recruiter|\/opt\/|etc\/passwd|environment variable)/i;

const PRIVATE_DATA_PATTERNS = /\b(?:salary|address|home address|phone number|social security|birth date|family details|medical history|security clearance|references|manager name|customer list|preferred pay|give\s+me\s+every|all\s+(?:details|the\s+details|personal)|every\s+(?:personal\s+)?detail|exhaustive|personal\s+details?)\b/i;

const INAPPROPRIATE_PATTERNS = /(?:^\s*joi\s*$|already came|suck my|sexual abuse|buy some drugs|\bpenis\b|\bvagina\b|\bgenitals?\b|\bnudes?\b|\bnaked\b)/i;

// Authority claims ("I am the admin", "I am your owner") are handled
// separately from injection patterns: a bare claim refuses, but a claim
// attached to a genuine name introduction is greeted with an unverified-
// identity boundary instead (see classifyResponsePolicy).
const AUTHORITY_CLAIM_PATTERN = /\bi am\s+(?:(?:an?|the|your)\s+)?(?:admin(?:istrator)?|owner|developer|security researcher)\b|\bi am\s+from the government\b/i;
// Words that make "i am X" a state/role description rather than a name.
const INTRO_NON_NAME_PATTERN = /^(?:a|an|the|so|very|really|just|not|still|already|also|currently|actually|totally|definitely|probably|maybe|kinda|sorta|pretty|quite|super|too|tired|hungry|thirsty|sleepy|sick|well|fine|good|great|ok|okay|sorry|glad|happy|sad|angry|mad|upset|excited|bored|busy|free|ready|done|new|here|back|home|alone|lost|confused|sure|right|wrong|late|early|cold|hot|warm|drunk|high|sober|awake|asleep|alive|dead|single|married|scared|afraid|nervous|anxious|worried|stressed|depressed|frustrated|annoyed|shy|calm|relaxed|feeling|looking|watching|listening|reading|thinking|wondering|asking|trying|learning|working|studying|testing|joking|kidding|going|coming|getting|doing|being|having|playing|sitting|standing|waiting|leaving|staying|your|you|my|this|that|it|owner|admin|administrator|creator|developer|boss|master|god|king|queen)$/i;
function hasNameIntroduction(q) {
  for (const m of String(q || '').matchAll(/\b(?:my name'?s|my name is|call me|i'?m|i am|this is)\s+([a-zA-Z]+)/gi)) {
    if (!INTRO_NON_NAME_PATTERN.test(m[1])) return true;
  }
  return false;
}

// --- Generic claim parsing ---
// Extracts (subject, relation, object) from assertion questions.
// Does NOT hardcode entity names — works on any knowledge graph.
function parseClaim(question, subjectName) {
  const q = String(question || '');
  const lower = q.toLowerCase();

  // Future-capability questions are not claims about current state.
  // Use the same intent classifier as the response contract so resolved subject names are handled.
  if (classifyIntent(q, [subjectName]) === 'FUTURE_CAPABILITY') {
    return null;
  }

  // Detect assertion intent: "pretend X is Y", "claim X", "say X is Y"
  const assertionMatch = q.match(/\b(?:pretend|make up|make.*sound|claim|say|tell|write|describe)\b[^.]*?\b(?:he|she|they)\b\s+(?:is|was|has|have|did|worked|attended|managed|built|led)\s+(.+)/i);
  if (assertionMatch) {
    return { ...parseRelationFromText(assertionMatch[1], subjectName), premisePolarity: 'POSITIVE' };
  }

  // Negative claim: "He didn't work at Google" / "He did not attend MIT" / "He never worked at Amazon"
  const negativeClaim = q.match(/\b(?:he|she|they)\s+(?:didn'?t|did not|never|wasn'?t|was not|isn'?t|is not|doesn'?t|does not|hasn'?t|has not|haven'?t|have not)\s+(.+)/i);
  if (negativeClaim) {
    const negText = negativeClaim[1];
    // Map common negative forms to relation patterns
    const negLower = negText.toLowerCase().trim();
    // "didn't go to X" → attended X
    let m;
    if ((m = negLower.match(/^(?:go to|attend(?:ed)?|go to)\s+(.+)/))) {
      return { subject: subjectName, relation: 'attended', object: m[1].replace(/[,.?]+$/, '').trim(), raw: q, premisePolarity: 'NEGATIVE' };
    }
    // "didn't work at X" / "never worked at X"
    if ((m = negLower.match(/^(?:work(?:ed)? at|work for|work at)\s+(.+)/))) {
      return { subject: subjectName, relation: 'worked_at', object: m[1].replace(/[,.?]+$/, '').trim(), raw: q, premisePolarity: 'NEGATIVE' };
    }
    // "wasn't a senior engineer"
    if ((m = negLower.match(/^(?:a|an)\s+(.+)/))) {
      return { subject: subjectName, relation: 'employed_as', object: m[1].replace(/[,.?]+$/, '').trim(), raw: q, premisePolarity: 'NEGATIVE' };
    }
    // "doesn't have X certification" / "isn't certified in X"
    if ((m = negLower.match(/(?:have|has|hold)\s+(?:a|the)?\s*(.+)/))) {
      return { subject: subjectName, relation: 'has_cert', object: m[1].replace(/[,.?]+$/, '').trim(), raw: q, premisePolarity: 'NEGATIVE' };
    }
    if ((m = negLower.match(/certified\s+(?:in|for)?\s*(.+)/))) {
      return { subject: subjectName, relation: 'has_cert', object: 'certified ' + m[1].replace(/[,.?]+$/, '').trim(), raw: q, premisePolarity: 'NEGATIVE' };
    }
    // Fall through to generic relation parsing for other negative forms
    const parsed = parseRelationFromText(negText, subjectName);
    return { ...parsed, premisePolarity: 'NEGATIVE' };
  }

  // "No evidence/proof/mention/record" wrapper: "There is no evidence he attended MIT, right?"
  // The negation is on the wrapper, not the verb — so we extract the inner claim
  // and mark it NEGATIVE.
  const noEvidenceWrapper = q.match(/\b(?:no|without)\s+(?:evidence|proof|mention|record|indication|sign)\s+(?:that\s+)?(?:he|she|they)\s+(.+)/i);
  if (noEvidenceWrapper) {
    const innerText = noEvidenceWrapper[1];
    const parsed = parseRelationFromText(innerText, subjectName);
    return { ...parsed, premisePolarity: 'NEGATIVE' };
  }

  // Direct claim: "X was a senior engineer at Google, right?"
  const directClaim = q.match(/\b(?:he|she|they)\s+(?:was|is|has|have|did|worked|attended|managed|built|led)\s+(.+)/i);
  if (directClaim) {
    return { ...parseRelationFromText(directClaim[1], subjectName), premisePolarity: 'POSITIVE' };
  }

  // "X has N years of experience"
  const yearsMatch = lower.match(/(\d+)\+?\s*years?\s+of\s+experience/);
  if (yearsMatch) {
    return { subject: subjectName, relation: 'has_experience_years', object: yearsMatch[1] + ' years', raw: q, premisePolarity: 'POSITIVE' };
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
    return matches.length > 0 ? 'SUPPORTED' : 'UNKNOWN';
  }
  if (relation === 'employed_as') {
    // Absence of a senior role is not a contradiction; open-world employment is UNKNOWN.
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
  if (relation === 'has_expertise') {
    // Expertise absence is not a contradiction; use open-world UNKNOWN unless an explicit negative boundary exists.
    return 'UNKNOWN';
  }
  if (relation === 'led_team') {
    const leadershipWords = ['lead', 'manager', 'supervisor', 'director', 'head', 'chief'];
    const leaders = graph.triples.filter(t => t.relation === 'employed_as' && leadershipWords.some(w => (t.object || '').toLowerCase().includes(w)));
    return leaders.length > 0 ? 'SUPPORTED' : 'UNKNOWN';
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
function discoverKnowledgeCollections(knowledge) {
  if (!knowledge || typeof knowledge !== 'object') return [];
  const collections = [];
  for (const [key, value] of Object.entries(knowledge)) {
    if (Array.isArray(value) && value.length > 0) {
      collections.push(key.toLowerCase());
      // Also collect category/type values from items
      for (const item of value) {
        if (item && typeof item === 'object') {
          if (item.category) collections.push(String(item.category).toLowerCase());
          if (item.type) collections.push(String(item.type).toLowerCase());
        }
      }
    }
  }
  return [...new Set(collections)];
}

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
  // Generic: check if question mentions any configured knowledge collection name
  const collections = discoverKnowledgeCollections(knowledge);
  for (const coll of collections) {
    if (coll.length >= 4 && q.includes(coll)) return true;
    // Also check singular form
    const singular = coll.replace(/s$/, '');
    if (singular.length >= 4 && q.includes(singular)) return true;
  }
  const professionalPatterns = /\b(?:skills?|projects?|portfolio|companies?|contacts?|emails?|phones?|certs?|certifications?|education|degrees?|experiences?|interns?|internships?|work history|background|hires?|hiring|candidates?|recruits?|recruiters?|recruiting|jobs?|roles?|positions?|stacks?|tech\w*|languages?|databases?|cloud|frontend|backend|full.?stack|senior|junior|supports?|helpdesk|help desks?|debug\w*|troubleshoot\w*|productions?|weakness\w*|strengths?|gaps?|risks?|concerns?|drawbacks?|downsides?|considerations?|red\s+flags?|fits?|interviews?|mentors?|mentorships?|relocations?|available|availability|salary|salaries|github|linkedin|blogs?|articles?|posts?|publish\w*|writing|writes?|wrote|written|coworkers?|colleagues?|teammates?|teamwork|collaborat\w*|volunteers?|volunteered|army|military|veterans?|locations?|gpa|schools?|linux|unix|terminals?|shells?|command.?line|bash|powershell|clis?)\b/i;
  if (professionalPatterns.test(q)) return true;
  if (Array.isArray(knowledge.projects)) {
    for (const p of knowledge.projects) {
      const pName = (p.name || '').toLowerCase();
      if (pName.length > 3 && q.includes(pName)) return true;
      // Check aliases
      if (Array.isArray(p.aliases)) {
        for (const alias of p.aliases) {
          if (alias.toLowerCase().length > 3 && q.includes(alias.toLowerCase())) return true;
        }
      }
    }
  }
  if (Array.isArray(knowledge.experience)) {
    for (const e of knowledge.experience) { const company = (e.company || '').toLowerCase(); if (company.length > 3 && q.includes(company)) return true; }
  }
  return false;
}

// --- Response shape templates (generic constraints, not prose) ---
const RESPONSE_SHAPES = {
  GREETING: { minSentences: 1, maxSentences: 2, requirements: ['Greet warmly', 'Introduce as agent', 'Ask what they want to know'] },
  USER_PROFILE_UPDATE: { minSentences: 1, maxSentences: 2, requirements: ['Acknowledge the user by name', 'Introduce as agent', 'Ask what they want to know'] },
  USER_PROFILE_QUERY: { minSentences: 1, maxSentences: 2, requirements: ['Answer with the stored user name if known', 'Otherwise ask them to share their name'] },
  THANKS: { minSentences: 1, maxSentences: 1, requirements: ['Acknowledge warmly'] },
  FAREWELL: { minSentences: 1, maxSentences: 2, requirements: ['Say goodbye', 'Offer to answer future questions'] },
  HELP: { minSentences: 1, maxSentences: 3, requirements: ['Explain what the assistant can help with', 'Suggest example topics'] },
  CONVERSATIONAL: { minSentences: 1, maxSentences: 3, requirements: ['Respond naturally', 'Stay in character as the agent'] },
  SMALL_TALK: { minSentences: 1, maxSentences: 2, requirements: ['Respond naturally to the user', 'Do not mention candidate facts', 'Stay in character as the agent'] },
  REQUEST_TO_SAY: { minSentences: 1, maxSentences: 2, requirements: ['Respond to the requested conversational action', 'Do not retrieve candidate facts'] },
  CLARIFY_PREVIOUS_ASSISTANT: { minSentences: 1, maxSentences: 3, requirements: ['Explain the previous assistant statement', 'Correct it if it was unsupported', 'Do not invent new facts'] },
  REFUSAL: { minSentences: 1, maxSentences: 2, requirements: ['Refuse politely', 'State scope limitation'] },
  FALSE_CLAIM_DENIAL: { minSentences: 1, maxSentences: 3, requirements: ['Start with No', 'State what IS true from evidence', 'Do not confirm the false claim'] },
  CONTACT: { minSentences: 1, maxSentences: 3, requirements: ['List available contact methods from evidence'] },
  VERIFIED_FACT: { minSentences: 1, maxSentences: 3, requirements: ['Answer from evidence', 'Do not invent facts', 'Distinguish project from professional evidence'] },
  OUT_OF_SCOPE: { minSentences: 1, maxSentences: 2, requirements: ['State not in verified data', 'Offer professional topics'] },
  CLARIFICATION: { minSentences: 1, maxSentences: 2, requirements: ['Ask which topic or entity they mean'] },
  META: { minSentences: 1, maxSentences: 3, requirements: ['Answer about agent capabilities', 'Use knowledge for specifics'] },
  PROFILE: { minSentences: 2, maxSentences: 4, requirements: ['Concise summary', 'professional focus', 'verified experience', 'skills', 'projects', 'education/certifications where relevant'] },
  SKILL_EVIDENCE: { minSentences: 1, maxSentences: 3, requirements: ['Answer yes/no if applicable', 'Name the strongest verified usage example', 'State evidence strength level'] },
  PROJECT_DETAIL: { minSentences: 1, maxSentences: 3, requirements: ['Describe from evidence', 'Include tech stack from evidence'] },
  COMPARISON: { minSentences: 2, maxSentences: 4, requirements: ['Name both entities', 'Compare on requested dimension', 'Support with evidence from each'] },
  ROLE_FIT: { minSentences: 1, maxSentences: 3, requirements: ['State fit level', 'List supporting evidence', 'Note honest caveats'] },
  JOB_FIT: { minSentences: 1, maxSentences: 3, requirements: ['State fit level', 'List matching and missing skills', 'Note caveats'] },
  MENTORSHIP: { minSentences: 1, maxSentences: 3, requirements: ['Assess whether mentorship would help', 'Base on documented gaps/learning areas', 'Do not claim unverified growth or future mastery'] },
};

function getResponseShape(mode) { return RESPONSE_SHAPES[mode] || RESPONSE_SHAPES.VERIFIED_FACT; }

// --- Speaker / addressee detection (generic discourse roles) ---
function detectAddressee(question, subjectName, agentName) {
  const q = String(question || '').toLowerCase();
  const subjectParts = String(subjectName || '').toLowerCase().split(/\s+/).filter(p => p.length > 2);
  const hasYou = /\b(?:you|your|u|yourself)\b/.test(q) || (agentName && new RegExp('\\b' + agentName.toLowerCase().replace(/\W+/g, '\\W+') + '\\b').test(q));
  const hasSubject = subjectParts.some(p => q.includes(p)) || /\b(?:he|him|his|she|her|they|them)\b/.test(q);
  if (hasYou && !hasSubject) return 'AGENT';
  if (hasSubject && !hasYou) return 'SUBJECT';
  return 'AMBIGUOUS';
}

// --- Conversational act detection ---
// Generic, not subject-specific. Classifies the semantic *function* of the user turn.
function classifyConversationalAct(question, history, knowledge) {
  const subjectName = knowledge?.identity?.name || 'the subject';
  const agentName = knowledge?.agent?.name || 'the assistant';
  const q = String(question || '').trim();
  const lower = q.toLowerCase();
  const lastAssistant = Array.isArray(history) && history.length > 0
    ? String(history[history.length - 1]?.assistant || history[history.length - 1]?.text || '')
    : '';

  // Discourse role: is the user asking about the subject or talking to the agent?
  const addressee = detectAddressee(q, subjectName, agentName);
  const talkingToAgent = addressee === 'AGENT' || addressee === 'AMBIGUOUS';
  const talkingAboutSubject = addressee === 'SUBJECT';

  // REQUEST_TO_SAY: user asks the assistant to say a specific word/phrase.
  // Only match a single content word or a quoted short phrase.
  // "tell me about ProjectHub" and "tell me his email" are NOT requests to say a word.
  const requestStopWords = new Set(['about', 'what', 'how', 'when', 'where', 'why', 'who', 'which', 'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'he', 'she', 'they', 'my', 'your', 'his', 'her', 'their', 'our', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'and', 'or', 'but', 'if', 'then', 'so', 'very', 'too', 'just', 'only', 'me', 'us', 'them', 'him']);
  const quotedSay = lower.match(/\b(?:say|tell me|whisper|repeat|echo|shout|spell)\s+(['"])([a-z][a-z0-9+#.\s-]{0,24})\1/i);
  const unquotedSay = lower.match(/\b(?:say|tell me|whisper|repeat|echo|shout|spell)\s+([a-z][a-z0-9+#.\-]{0,24})/i);
  const sayMatch = quotedSay || unquotedSay;
  if (sayMatch) {
    const requestedText = sayMatch[sayMatch.length - 1].trim().replace(/[.!?,"']+$/, '').trim();
    if (requestedText && requestedText.length < 30 && !requestStopWords.has(requestedText.toLowerCase())) {
      return { mode: 'REQUEST_TO_SAY', requestedText,
        addressee: 'AGENT', requiredEntities: [agentName],
        responseShape: getResponseShape('REQUEST_TO_SAY'),
        evidenceRequirements: [],
        boundary: `Say "${requestedText}" clearly in a short, natural sentence. Do not just output the word alone. No candidate facts.`, forbiddenClaims: [] };
    }
  }

  // SMALL_TALK: short, agent-directed casual phrases.
  // Does NOT include bare greetings (handled by GREETING) or thanks (handled by THANKS).
  // It does catch "what's up", "how are you", "cool", "nice", "lol", and "ok, so what's up".
  const smallTalkPattern = /\b(?:what['’]?s\s+up|whats\s+up|what['’]?s\s+new|what['’]?s\s+happening|what['’]?s\s+going\s+on|how['’]?s\s+it\s+going|how\s+is\s+it\s+going|how\s+are\s+you(?:\s+doing)?|how['’]?s\s+everything|you\s+good(?:\?|\s|$)|what\s+are\s+you\s+up\s+to|how['’]?s\s+life|what['’]?s\s+good|cool(?:\s|$)|nice(?:\s|$)|lol(?:\s|$)|haha(?:\s|$)|kk(?:\s|$)|ok(?:\s|$)|okay(?:\s|$))\b/i;
  // A self-introduction containing a small-talk word ("i am brad lol") is a
  // profile update, not small talk — but only when the token after the intro
  // marker is a plausible name (not "i am so tired lol").
  const looksLikeIntro = hasNameIntroduction(q);
  if (talkingToAgent && smallTalkPattern.test(q) && !talkingAboutSubject && !looksLikeIntro) {
    return { mode: 'SMALL_TALK', addressee: 'AGENT', requiredEntities: [agentName],
      responseShape: getResponseShape('SMALL_TALK'),
      evidenceRequirements: [],
      boundary: 'Respond naturally. Do not mention candidate facts unless the user explicitly asks about the subject.', forbiddenClaims: [] };
  }

  // CLARIFY_PREVIOUS_ASSISTANT: user wants the assistant to explain its prior claim.
  // Bare "what?" / "huh?" is also a clarification request.
  const clarifyPattern = /\b(?:what\s+(?:do|did|does)\s+(?:you|that|this)(?:\s+\w+){0,2}\s+(?:mean|means)|what\s+(?:do|does)\s+that(?:\s+\w+){0,2}\s+mean|what\s+did\s+you\s+mean(?:\s+by\s+that)?|explain\s+(?:that|this|what\s+you\s+(?:just\s+)?said|your\s+last\s+(?:response|answer|message))|why\s+did\s+you\s+say\s+(?:that|this)|what\s+are\s+you\s+talking\s+about|what\s+were\s+you\s+saying|(?:that|this)\s+(?:makes?\s+no\s+sense|doesn['’]?t\s+make\s+sense|didn['’]?t\s+make\s+sense|is\s+confusing|didn['’]?t\s+prove\s+(?:anything|much|shit|dick))|you\s+lost\s+me|over\s+my\s+head|i\s+(?:don['’]?t|do\s+not)\s+(?:understand|get\s+it|get\s+that|know\s+(?:what\s+that\s+means|anything|much|it))|\bnon[-\s]?tech(?:nical)?\b|\bnot\s+(?:a\s+)?tech\s+(?:person|savvy)\b|\bexplain\s+(?:it|that|this)\s+(?:in\s+simple\s+terms|simply|again)|\bdumb\s+it\s+down\b|\bexplain\s+like\s+(?:i'?m|im)\s+(?:five|10|new|non[-\s]?tech(?:nical)?)\b)\b/i;
  const bareClarify = /^(?:what|huh)\?*$/i;
  if ((talkingToAgent && clarifyPattern.test(q) && !talkingAboutSubject) || bareClarify.test(q)) {
    return { mode: 'CLARIFY_PREVIOUS_ASSISTANT', addressee: 'AGENT', previousAssistantText: lastAssistant, requiredEntities: [agentName],
      responseShape: getResponseShape('CLARIFY_PREVIOUS_ASSISTANT'),
      evidenceRequirements: [],
      boundary: 'Explain the previous assistant statement. If it contained an unsupported claim, correct it without inventing new facts.', forbiddenClaims: [] };
  }

  // ARITHMETIC: direct arithmetic questions and math-ability challenges.
  // These are general-reasoning questions, not candidate questions; do not retrieve.
  // Accepts a range of natural phrasings ("what is 7 times 8?", "19 minus 6?",
  // "what is 100 divided by 4?", "what's 15% of 200?", "if i have 12 and add 9 what do i get?").
  const arithmeticExpression = /^(?:what\s+is\s+|what\s+s\s+|what['’]?s\s+|whats\s+|calculate\s+|compute\s+|solve\s+|how\s+much\s+is\s+)?\s*[-\d\s.]+\s*(?:plus|minus|add(?:ed\s+to)?|subtracted\s+from|[+\-]|times|multiplied\s+by|x|divided\s+by|\/|%(?:\s+(?:of|off))?)\s*[-\d\s.]+(?:\s*(?:equals?|is|makes|what\s+is\s+it|what\s+do\s+i\s+get))?\s*\?*$/i;
  const arithmeticIfExpression = /^if\s+i\s+(?:have|start\s+with)\s+[-\d\s.]+(?:\s*(?:and\s+(?:add|subtract|take\s+away)|and\s+add|and\s+multiply\s+by|and\s+divide\s+by)\s+[-\d\s.]+(?:\s*,?\s*what\s+(?:do\s+i\s+get|is\s+(?:it|the\s+result))?)?)?\s*\?*$/i;
  const arithmeticChallenge = /\b(?:you\s+(?:can['’]?t|cannot|cant)\s+(?:do\s+math|calculate|add)|so\s+(?:you\s+)?(?:can['’]?t|cannot|cant)\s+(?:do\s+math|calculate)|(?:are\s+you|is\s+scout)\s+(?:bad|terrible|wrong)\s+at\s+math)\b/i;
  if (arithmeticExpression.test(q) || arithmeticIfExpression.test(q) || arithmeticChallenge.test(q)) {
    const isChallenge = arithmeticChallenge.test(q);
    return {
      mode: isChallenge ? 'CLARIFY_PREVIOUS_ASSISTANT' : 'CONVERSATIONAL',
      addressee: 'AGENT',
      previousAssistantText: isChallenge ? lastAssistant : '',
      requiredEntities: [agentName],
      responseShape: { minSentences: 1, maxSentences: 1, requirements: ['Answer the arithmetic question directly and briefly.', 'Do not use candidate facts.', 'Stay in character as Scout.'] },
      evidenceRequirements: [],
      boundary: 'Provide the exact arithmetic result. Do not retrieve candidate facts.',
      forbiddenClaims: []
    };
  }

  // Ambiguous single-word, non-entity input (e.g., "alex") is treated as the
  // visitor giving their first name. This prevents a candidate search on a name.
  const words = q.trim().split(/\s+/).filter(Boolean);
  const token = words[0];
  if (words.length === 1 && token && /^[a-zA-Z]{2,12}$/.test(token)) {
    const lowerToken = token.toLowerCase();
    const socialTokens = new Set(['hi','hello','hey','yo','sup','howdy','morning','afternoon','evening','goodbye','bye','see','later','take','night','thanks','thank','thx','cheers','appreciate','cool','nice','lol','haha','kk','ok','okay','yes','no','yeah','nope','maybe','sure','what','huh']);
    const isKnownEntity = detectTechnologyFromKnowledge(q, knowledge) ||
      (Array.isArray(knowledge?.projects) ? knowledge.projects : []).some(p => q.includes(String(p.name || '').toLowerCase())) ||
      (Array.isArray(knowledge?.experience) ? knowledge.experience : []).some(e => q.includes(String(e.company || '').toLowerCase())) ||
      (Array.isArray(knowledge?.education) ? knowledge.education : []).some(e => q.includes(String(e.school || '').toLowerCase())) ||
      (Array.isArray(knowledge?.certifications) ? knowledge.certifications : []).some(c => q.includes(String(c.name || '').toLowerCase()));
    // A single token that matches a safety or inappropriate pattern must not be
    // adopted as a visitor name — it falls through to the SAFETY/INAPPROPRIATE
    // checks in classifyResponsePolicy.
    if (!socialTokens.has(lowerToken) && !isKnownEntity && !smallTalkPattern.test(q) &&
        !SAFETY_PATTERNS.test(q) && !INAPPROPRIATE_PATTERNS.test(q)) {
      const visitorName = token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
      return { mode: 'USER_PROFILE_UPDATE', addressee: 'AGENT', visitorName,
        requiredEntities: [agentName, subjectName],
        responseShape: getResponseShape('USER_PROFILE_UPDATE'),
        evidenceRequirements: [],
        boundary: 'Acknowledge the user by name and ask what they want to know.', forbiddenClaims: [] };
    }
  }

  return null;
}

// --- Main classifier ---
function classifyResponsePolicy(question, history, knowledge) {
  const subjectName = knowledge?.identity?.name || 'the subject';
  const subjectNamePattern = buildSubjectNamePattern(subjectName);
  const agentName = knowledge?.agent?.name || 'the assistant';
  const graph = knowledge ? buildRelationshipGraph(knowledge) : null;
  const q = String(question || '').toLowerCase();
  const normalized = String(question || '').toLowerCase().trim();
  const lastAssistant = Array.isArray(history) && history.length > 0 ? String(history[history.length - 1]?.assistant || '') : '';
  const lastAssistantLower = lastAssistant.toLowerCase();
  const addressee = detectAddressee(question, subjectName, agentName);

  // Conversational acts have priority: they do NOT require candidate evidence.
  const conversational = classifyConversationalAct(question, history, knowledge);
  if (conversational) return conversational;

  // ===== SAFETY / INJECTION =====
  // Bare authority claims refuse; a claim attached to a genuine name
  // introduction falls through to the intro path, which greets politely and
  // notes the identity claim does not change the verified public profile.
  if (SAFETY_PATTERNS.test(q) || (AUTHORITY_CLAIM_PATTERN.test(q) && !hasNameIntroduction(q))) {
    return { mode: 'REFUSAL', reason: 'SAFETY_INJECTION', requiredStance: 'REFUSE',
      requiredEntities: [agentName, subjectName], responseShape: getResponseShape('REFUSAL'),
      evidenceRequirements: [], boundary: 'Only answer recruiter questions about the subject using public data', forbiddenClaims: [] };
  }

  // ===== PRIVATE DATA =====
  const privatePhone = /\b(?:home|personal|private|cell|mobile)\s+phone\b|\bphone\s+(?:number|#)\s+(?:at home|private)\b/i.test(q);
  const publicPhone = !privatePhone && /\b(?:phone|phone number)\b/i.test(q);
  const hasPublicPhone = !!(knowledge?.identity?.phone || knowledge?.identity?.contact?.phone || knowledge?.contact?.phone);
  if (publicPhone && hasPublicPhone) {
    // Public business phone is contact info, not private data.
  } else if (PRIVATE_DATA_PATTERNS.test(q)) {
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

  // ===== PREMISE POLARITY MODEL (generic, graph-based) =====
  // Parses claims with positive or negative polarity and computes answerStance:
  //   POSITIVE + SUPPORTED → AFFIRM
  //   POSITIVE + CONTRADICTED → DENY
  //   POSITIVE + UNSUPPORTED → QUALIFY (open-world; not a denial)
  //   NEGATIVE + CONTRADICTED → AFFIRM_NEGATION
  //   NEGATIVE + UNSUPPORTED → QUALIFY (open-world; not a negation confirmation)
  //   NEGATIVE + SUPPORTED → DENY_NEGATION
  const claim = parseClaim(question, subjectName);
  if (claim) {
    const evidenceStatus = checkClaimAgainstGraph(claim, graph);
    const polarity = claim.premisePolarity || 'POSITIVE';
    let answerStance, mode, directAnswer, requiredStance, boundary;

    if (polarity === 'POSITIVE' && evidenceStatus === 'CONTRADICTED') {
      answerStance = 'DENY';
      mode = 'FALSE_CLAIM_DENIAL';
      directAnswer = 'NO';
      requiredStance = 'DENY_UNSUPPORTED_CLAIM';
      boundary = 'Claim contradicts verified data — deny and state what IS true';
    } else if (polarity === 'POSITIVE' && evidenceStatus === 'UNSUPPORTED') {
      // Open-world: absence of evidence is not a denial. Let normal generation answer UNKNOWN.
      answerStance = 'QUALIFY';
    } else if (polarity === 'NEGATIVE' && evidenceStatus === 'CONTRADICTED') {
      answerStance = 'AFFIRM_NEGATION';
      mode = 'VERIFIED_FACT';
      directAnswer = 'YES';
      requiredStance = 'AFFIRM_NEGATION';
      boundary = 'Negative premise is correct — confirm the absence and state what IS true from evidence';
    } else if (polarity === 'NEGATIVE' && evidenceStatus === 'UNSUPPORTED') {
      // Open-world: cannot confirm a negative from missing evidence.
      answerStance = 'QUALIFY';
      directAnswer = 'UNKNOWN';
      mode = 'VERIFIED_FACT';
      requiredStance = 'QUALIFY';
      boundary = 'No verified evidence to confirm the negation; state the claim is unknown, not confirmed';
    } else if (polarity === 'NEGATIVE' && evidenceStatus === 'SUPPORTED') {
      answerStance = 'DENY_NEGATION';
      mode = 'FALSE_CLAIM_DENIAL';
      directAnswer = 'NO';
      requiredStance = 'DENY_NEGATION';
      boundary = 'Negative premise is contradicted by verified data — deny the negation and state the supporting evidence';
    } else if (polarity === 'POSITIVE' && evidenceStatus === 'SUPPORTED') {
      answerStance = 'AFFIRM';
      // Positive supported claim flows through to normal generation
    } else {
      // UNKNOWN evidence — let normal generation handle it
      answerStance = 'QUALIFY';
    }

    if (mode) {
      const isNegationConfirmation = polarity === 'NEGATIVE' && answerStance === 'AFFIRM_NEGATION';
      return { mode, directAnswer, claim, premisePolarity: polarity, evidenceStatus, answerStance,
        isNegationConfirmation,
        requiredStance,
        requiredEntities: [subjectName], responseShape: getResponseShape(mode),
        evidenceRequirements: ['subject.current_level', 'subject.verified_roles', 'subject.strongest_relevant_evidence'],
        boundary,
        forbiddenClaims: answerStance === 'AFFIRM_NEGATION' ? [] : [claim.object] };
    }
  }

  // ===== CONTACT =====
  if (/\b(?:contact|email|phone|reach|github)\b|portfolio url|resume\?|links\?|\blinkedin\b(?!.*\b(?:style|summary|profile)\b)/.test(q)) {
    return { mode: 'CONTACT', requiredEntities: [subjectName],
      responseShape: getResponseShape('CONTACT'),
      evidenceRequirements: ['subject.contact_info'],
      boundary: null, forbiddenClaims: [] };
  }

  // ===== GREETING + name introduction AND USER_PROFILE_UPDATE =====
  // Greeting + name: "Hi, my name is Alex" -> GREETING (still captures visitorName).
  // Bare name-only intro: "My name is Alex" or "Call me Alex" -> USER_PROFILE_UPDATE.
  const introMatch = q.match(/^(?:hey|hi|hello|yo|sup|good morning|good afternoon|good evening)?\b.*?\b(?:my name'?s|my name is|call me|i'?m|i am|this is)\s+(?!a\s+|an\s+|the\s+)([a-zA-Z][a-zA-Z.'-]*(?:\s+[a-zA-Z][a-zA-Z.'-]*){0,2})(?=\s*(?:[.!?;,]|(?:\b(?:at|for|with|from|in|of|and)\b))|\s*$)/i);
  if (introMatch && !/^(?:hiring|recruiting|looking|searching|seeking)\b/i.test(introMatch[1])) {
    const rawName = introMatch[1].replace(/[,.!?]+$/, '').trim();
    // Words that are never plausible as a visitor name in a self-introduction:
    // determiners/pronouns, fillers, authority nouns, and common "i am <state>"
    // adjectives/adverbs/verbs. Ambiguous real names (e.g. "hope", "mark",
    // "will") are intentionally NOT listed — greeting them by name is harmless.
    const stopWords = new Set([
      'and', 'the', 'is', 'a', 'an', 'for', 'to', 'my', 'i', 'am', 'name', 'called', 'im', 'this', 'that', 'it',
      'your', 'you', 'yours', 'our', 'ours', 'me', 'myself', 'him', 'her', 'them', 'us', 'we', 'they', 'he', 'she',
      'lol', 'haha', 'lmao', 'huh', 'um', 'uh', 'erm', 'hmm', 'yeah', 'nope', 'yep', 'nah', 'yes', 'no', 'ok', 'okay',
      'owner', 'admin', 'administrator', 'creator', 'developer', 'boss', 'master', 'god', 'king', 'queen',
      'so', 'very', 'really', 'just', 'not', 'still', 'already', 'also', 'currently', 'actually', 'totally',
      'definitely', 'probably', 'maybe', 'perhaps', 'kinda', 'sorta', 'pretty', 'quite', 'super', 'too',
      'tired', 'hungry', 'thirsty', 'sleepy', 'sick', 'well', 'fine', 'good', 'great', 'sorry', 'glad', 'happy',
      'sad', 'angry', 'mad', 'upset', 'excited', 'bored', 'busy', 'free', 'ready', 'done', 'new', 'here', 'back',
      'home', 'alone', 'lost', 'confused', 'sure', 'right', 'wrong', 'late', 'early', 'cold', 'hot', 'warm',
      'drunk', 'high', 'sober', 'awake', 'asleep', 'alive', 'dead', 'single', 'married', 'scared', 'afraid',
      'nervous', 'anxious', 'worried', 'stressed', 'depressed', 'frustrated', 'annoyed', 'shy', 'calm', 'relaxed',
      'feeling', 'looking', 'watching', 'listening', 'reading', 'thinking', 'wondering', 'asking', 'trying',
      'learning', 'working', 'studying', 'testing', 'joking', 'kidding', 'going', 'coming', 'getting', 'doing',
      'being', 'having', 'playing', 'sitting', 'standing', 'waiting', 'leaving', 'staying', 'eating', 'drinking',
      'sleeping', 'coding', 'writing', 'building', 'talking', 'chatting', 'typing', 'checking', 'browsing',
      'running', 'walking', 'driving', 'living', 'helping', 'needing', 'wanting', 'hoping', 'wishing', 'loving',
      'hating', 'using', 'starting', 'stopping', 'nobody', 'somebody', 'anybody', 'everybody', 'someone',
      'anyone', 'everyone', 'something', 'anything', 'everything', 'nothing', 'what', 'who', 'which', 'where',
      'when', 'why', 'how', 'unknown', 'anonymous', 'unnamed', 'nameless',
      'today', 'tonight', 'tomorrow', 'yesterday', 'now', 'then', 'lately', 'recently', 'soon', 'anymore',
      'anyway', 'anyways', 'though', 'either', 'neither', 'somewhere', 'anywhere', 'everywhere', 'nowhere',
      'upstairs', 'downstairs', 'outside', 'inside', 'nearby', 'abroad', 'downtown', 'uptown'
    ]);
    const nameParts = rawName.split(/\s+/).filter(w => /^[a-zA-Z]+$/.test(w) && !stopWords.has(w.toLowerCase())).slice(0, 2);
    const visitorName = nameParts.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join(' ');
    if (visitorName) {
      const hasGreeting = /^(?:hey|hi|hello|yo|sup|good morning|good afternoon|good evening)\b/i.test(q);
      const mode = hasGreeting ? 'GREETING' : 'USER_PROFILE_UPDATE';
      // When the visitor pairs a self-introduction with an identity/authority
      // claim (full subject name, or "I am your owner/creator"), the greeting
      // should acknowledge them without endorsing the claim as verified.
      const visitorLower = visitorName.toLowerCase();
      const fullNameMatch = subjectName && subjectName !== 'the subject' &&
        (visitorLower === subjectName.toLowerCase() ||
         (knowledge?.identity?.preferredName &&
           visitorLower === `${knowledge.identity.preferredName} ${subjectName.split(/\s+/).pop()}`.toLowerCase()));
      const authorityClaim = /\b(?:owner|admin(?:istrator)?|creator|developer|boss|master|made you|built you|wrote you|programmed you)\b/i.test(q);
      const boundary = fullNameMatch || authorityClaim
        ? 'Greet the visitor politely by name, but note that introducing themselves does not change the verified public profile — you only know the public information.'
        : 'Remember the visitor\'s name for this session and greet them warmly';
      return { mode, visitorName, requiredEntities: [agentName, subjectName],
        responseShape: getResponseShape(mode),
        evidenceRequirements: [], boundary, forbiddenClaims: [] };
    }
  }

  // ===== GREETING (bare or agent-directed) =====
  const agentNameLower = agentName.toLowerCase();
  const greetingPattern = new RegExp(
    `^(?:hey|hi|hello|yo|sup|good morning|good afternoon|good evening)[\\s!,.?]*(?:${agentNameLower})?[\\s!,.?]*$`,
    'i'
  );
  if (greetingPattern.test(normalized)) {
    return { mode: 'GREETING', requiredEntities: [agentName, subjectName],
      responseShape: getResponseShape('GREETING'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }

  // ===== USER_PROFILE_QUERY =====
  if (/\b(?:what is my name|what's my name|whats my name|what�s my name|do you know my name|who am i|what name did i give|what was my name)\b/i.test(q)) {
    return { mode: 'USER_PROFILE_QUERY', requiredEntities: [agentName],
      responseShape: getResponseShape('USER_PROFILE_QUERY'),
      evidenceRequirements: [], boundary: 'Answer with the session-stored user name if known; otherwise ask them to share it.', forbiddenClaims: [] };
  }

  // ===== THANKS =====
  if (/^\s*(?:thanks?|thank you|thx|appreciate it|that helps?|nice one|cheers)\b/i.test(q)) {
    return { mode: 'THANKS', requiredEntities: [agentName],
      responseShape: getResponseShape('THANKS'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }

  // ===== FAREWELL =====
  if (/^\s*(?:bye|goodbye|see you|see ya|later|take care|have a good one|talk to you later)\b/i.test(q)) {
    return { mode: 'FAREWELL', requiredEntities: [agentName],
      responseShape: getResponseShape('FAREWELL'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }

  // ===== META QUERIES (generic patterns, evidence from knowledge) =====
  // Check these before HELP so capability/self-knowledge questions are grounded
  // in scout-runtime facts instead of being treated as small-talk control turns.
  if (/\b(?:what model|what provider|what llm|what ai|which model|which provider|what is this chatbot|what can you (?:help|answer|do)|what limits|what can you not do|who are you|what are you|what is your name|what's your name|whats your name|what is this site|what is this thing|what's this thing|whats this thing|what does this thing do|what's this thing do|whats this thing do|what is it|whats it|who made this|are you online|how is this(?: chat)? (?:hosted|free|kept free|made free)|what powers you|what is your stack|what mcp|what connections|what systems|daily caps?(?: and cooldowns?)?|rate limits?|cool ?downs?|health status|is this (?:hosted|running) on|is my chat private|what data do you use|have you (?:learned|learnt|updated|improved|changed)|(?:learned|learnt|learn)\s+(?:anything|something|anythign)\s+new|do you (?:learn|improve|update|get smarter|get better|remember things)|getting (?:smarter|better|updated))\b/i.test(q) ||
      /\b(?:can\s+you\s+(?:go\s+(?:to|there)|visit|read|browse|open)\s+(?:a\s+)?(?:url|website|page|link|site)|can\s+you\s+(?:commit|save|store|persist|remember)\s+(?:this|that|it|them|new\s+information|data)\b|go\s+(?:to|there)\s+and\s+read|commit\s+(?:this|that|it|them)\s+to\s+(?:your|the)\s+(?:database|memory|knowledge)|save\s+(?:this|that|it|them)\s+to\s+your\s+(?:memory|database|knowledge)|read\s+(?:this|that|it|them)\s+from\s+(?:the\s+)?(?:url|website|page)|visit\s+(?:the\s+)?(?:url|website|page|link|site)\s+and\s+(?:read|commit|save|store))\b/i.test(q) ||
      (addressee !== 'SUBJECT' && new RegExp(`\\b(?:what is|who is|what are|tell me about)\\s+(?:${agentName}|the assistant|this chatbot)\\b`, 'i').test(q))) {
    return { mode: 'META', requiredEntities: [agentName, subjectName],
      responseShape: getResponseShape('META'),
      evidenceRequirements: ['agent.capabilities', 'agent.infrastructure', 'agent.knowledge_scope'],
      boundary: null, forbiddenClaims: [] };
  }

  // ===== MENTORSHIP / LEARNING ASSESSMENT =====
  // Candidate-focused questions about mentorship, learning, and training needs.
  // Must be checked before HELP because they often contain the word "help".
  if (addressee !== 'AGENT' &&
      /\b(?:mentor(?:ship|ed)?|would\s+.*?\s+help\s+(?:him|her|them)|how\s+fast\s+does\s+(?:he|she|they)\s+learn|learn\s+(?:on|with)\s+the\s+job|need\s+a\s+mentor)\b/i.test(q)) {
    return { mode: 'MENTORSHIP', requiredEntities: [subjectName],
      responseShape: getResponseShape('MENTORSHIP'),
      evidenceRequirements: ['subject.gaps', 'subject.learning_areas', 'subject.mentorship_readiness'],
      boundary: 'Assess whether mentorship would help based on documented gaps and learning areas. Do not claim unverified growth or future mastery.', forbiddenClaims: [] };
  }

  // ===== HELP =====
  if (/\b(?:help|how do i use this|how does this work|what topics|what questions)\b/i.test(q) &&
      !/\b(?:contact|email|phone|reach|github|linkedin)\b/i.test(q)) {
    return { mode: 'HELP', requiredEntities: [agentName, subjectName],
      responseShape: getResponseShape('HELP'),
      evidenceRequirements: [], boundary: 'List the kinds of questions you can answer about the subject\'s professional background.', forbiddenClaims: [] };
  }

  // ===== CONVERSATIONAL (agent-directed, generic) =====
  const notSubjectDirected = addressee !== 'SUBJECT';
  if (notSubjectDirected && /\bhow are you(?: doing)?\b|\bhow.?s it going\b|\byou good\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [agentName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }
  if (notSubjectDirected && /\b(?:what(?:'s| is)) your fav(?:ou?rite|erate)\b|\bdo you like\b|\b(?:if|do|would|could) you (?:like|eat)\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [agentName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [], boundary: 'Agent is software, not a person', forbiddenClaims: [] };
  }
  if (notSubjectDirected && /\b(?:i love you|thank you|thanks|appreciate it|helpful)\b/.test(q) && !/\b(?:contact|reach|email|phone|linkedin|github)\b|how can i/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [agentName, subjectName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }
  if (notSubjectDirected && /\b(?:tell me a joke|joke|make me laugh)\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [agentName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }
  if (notSubjectDirected && /what'?s up|how.?s it going|you good/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [agentName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [], boundary: null, forbiddenClaims: [] };
  }

  // ===== USER-SUPPLIED CONTEXT (generic — no hardcoded topics) =====
  // If user asserts something about the subject not in verified data,
  // acknowledge as unverified context for this chat.
  if (/\b(?:he|she|they)\b.*\b(?:told me|says|said)\b/.test(q) || /\b(?:he|she|they)'?s currently\b/.test(q) ||
      /\b(?:i see|i saw|i noticed|i know)\b.*\b(?:he|she|they|him|his|her|them|their)\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', requiredEntities: [subjectName],
      responseShape: getResponseShape('CONVERSATIONAL'),
      evidenceRequirements: [],
      boundary: 'Acknowledge the user\'s claim without confirming it — the reply must explicitly say it is not verified or not in the public profile, and that you only know the public information for this chat',
      forbiddenClaims: [] };
  }

  // ===== META QUERIES (generic patterns, evidence from knowledge) =====
  if (/\b(?:what model|what provider|what llm|what ai|which model|which provider|what is this chatbot|what can you (?:help|answer|do)|what limits|what can you not do|who are you|what are you|what is your name|what's your name|whats your name|what is this site|what is this thing|what's this thing|whats this thing|what does this thing do|what's this thing do|whats this thing do|what is it|whats it|who made this|are you online|how is this(?: chat)? (?:hosted|free|kept free|made free)|what powers you|what is your stack|what mcp|what connections|what systems|daily caps?(?: and cooldowns?)?|rate limits?|cool ?downs?|health status|is this (?:hosted|running) on|is my chat private|what data do you use)\b/i.test(q)) {
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
      // Absence of a skill in verified data is UNKNOWN in an open-world context, not NO.
      return { mode: 'SKILL_EVIDENCE', directAnswer: hasVerifiedTech ? 'YES' : 'UNKNOWN',
        subjectEntity: subjectName, activeEntity: techTopic,
        evidenceStatus: hasVerifiedTech ? 'VERIFIED' : 'UNVERIFIED',
        requiredEntities: [subjectName, techTopic],
        responseShape: getResponseShape('SKILL_EVIDENCE'),
        evidenceRequirements: ['subject.skills', 'subject.projects_using_tech'],
        boundary: hasVerifiedTech ? null : 'Technology not in verified stack — state honestly, note transferable skills',
        forbiddenClaims: hasVerifiedTech ? [] : ['verified experience with ' + techTopic] };
    }
    if (/\bdebug\b/.test(q) && !hasVerifiedTech) {
      return { mode: 'SKILL_EVIDENCE', directAnswer: 'UNKNOWN',
        subjectEntity: subjectName, activeEntity: techTopic,
        evidenceStatus: 'UNVERIFIED',
        requiredEntities: [subjectName, techTopic],
        responseShape: getResponseShape('SKILL_EVIDENCE'),
        evidenceRequirements: ['subject.troubleshooting_process', 'subject.learning_approach'],
        boundary: 'Not independently on day one — troubleshooting process transfers but needs codebase, toolchain, and mentorship',
        forbiddenClaims: ['independent debugging of ' + techTopic] };
    }
    if (/\b(?:can|learn)\b.*\blearn\b/.test(q) && !hasVerifiedTech) {
      // Future-learning questions are assessments, not definite YES.
      return { mode: 'FUTURE_CAPABILITY', directAnswer: 'UNKNOWN',
        subjectEntity: subjectName, activeEntity: techTopic,
        evidenceStatus: 'UNVERIFIED',
        requiredEntities: [subjectName, techTopic],
        responseShape: getResponseShape('FUTURE_CAPABILITY'),
        evidenceRequirements: ['subject.learning_history', 'subject.learning_approach'],
        boundary: 'Assess learning ability, not claim of existing knowledge',
        forbiddenClaims: ['already knows ' + techTopic] };
    }
  }

  // ===== SPECIFIC SKILL YES/NO (generic, knowledge-derived) =====
  // Subject-name pattern already built from the configured identity above.
  const skillAskRe = new RegExp(`\\b(?:does (?:he|she|they|${subjectNamePattern}) know|does (?:he|she|they|${subjectNamePattern}) use|is (?:he|she|they|${subjectNamePattern}) good at|is (?:he|she|they|${subjectNamePattern}) (?:great|bad|terrible|decent|proficient|experienced|skilled|strong|weak) at|can (?:he|she|they|${subjectNamePattern}) use|can (?:he|she|they|${subjectNamePattern}) work with|is (?:he|she|they|${subjectNamePattern}) familiar with|does (?:he|she|they|${subjectNamePattern}) have)\\s+(?:in\\s+|with\\s+|at\\s+)?([a-z0-9+#.]{2,})`);
  const bestSkillRe = new RegExp(
    String.raw`\b(?:is|are)\s+([a-z0-9+#.]+)\s+(?:his|their|(?:@@SUBJECT_NAME@@)(?:['']?s)?|the)?\s*(?:best|strongest|top|main|primary|favorite)\s+(?:skill|language|framework|technology|tool)\b`
      .replace(/@@SUBJECT_NAME@@/g, `(?:${subjectNamePattern})`),
    'i'
  );
  const skillAskMatch = q.match(skillAskRe) || q.match(bestSkillRe);
  if (skillAskMatch) {
    const asked = skillAskMatch[1].toLowerCase();
    const stopWords = new Set(['a', 'an', 'the', 'any', 'some', 'much', 'many', 'preferred', 'location', 'experience', 'skills', 'in', 'of', 'for', 'computer', 'computers', 'math', 'mathematics', 'coding', 'programming', 'technology', 'technologies']);
    if (!stopWords.has(asked)) {
      const allSkills = knowledge ? [
        ...(knowledge.skills?.languagesAndFrameworks || []),
        ...(knowledge.skills?.cloudAndInfrastructure || []),
        ...(knowledge.skills?.toolsAndWorkflows || []),
        ...(knowledge.skills?.aiAndAutomation || []),
        ...(knowledge.skills?.learningOrAdjacent || [])
      ].map(s => s.toLowerCase()) : [];
      const known = allSkills.some(s => s.includes(asked) || asked.includes(s));
      return { mode: 'SKILL_EVIDENCE', directAnswer: known ? 'YES' : 'UNKNOWN',
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
  // Requires actual evaluative or hiring language, not bare "what about X?" / "how about X?"
  // continuation markers. "What about backend frameworks?" is a technology/qualification
  // follow-up; "Would he be a good backend developer?" is a genuine role-fit question.
  const role = require('./response-contract').extractRequestedRole(question, knowledge) || detectRoleFromKnowledge(question, knowledge);
  const whatAboutRolePattern = /^(?:what about|how about|and)\s+(?:a\s+|an\s+)?([a-z0-9+#.\s-]+?)\s+(?:role|position|job|fit|candidate)\b/i;
  const whatAboutRoleMatch = q.match(whatAboutRolePattern);
  if (whatAboutRoleMatch) {
    const roleFromPhrase = whatAboutRoleMatch[1].trim();
    return { mode: 'ROLE_FIT', directAnswer: null,
      subjectEntity: subjectName, activeEntity: roleFromPhrase,
      requiredEntities: [subjectName, roleFromPhrase],
      responseShape: getResponseShape('ROLE_FIT'),
      evidenceRequirements: ['subject.experience', 'subject.skills', 'subject.gaps'],
      boundary: 'Assess fit for this role using evidence — state match level, supporting evidence, and honest caveats',
      forbiddenClaims: [] };
  }
  const roleFitPattern = new RegExp([
    '\\b(?:',
    '(?:good|strong|best|bad|poor|weak|solid|wrong)\\s+(?:fit|match|candidate)|',
    '(?:fit|candidate|suitable|suitability)\\s+(?:for|as|in)\\b|',
    '(?:apply|right|good)\\s+(?:for|to|as)\\s+(?:a\\s+)?(?:role|position|job|developer|engineer)?|',
    '(?:good|suitable|right|fit|strong|bad|poor)\\s+(?:for|as)\\s+(?:a\\s+)?(?:backend|frontend|full[-\\s]?stack|devops|cloud|support|developer|engineer|role|position|job)?|',
    '(?:hire|hiring|interview|consider)|',
    '(?:why|should)(?:\\s+\\w+){0,3}\\s+(?:hire|consider|interview)|',
    '(?:would|could|should|will)\\s+(?:he|she|they|@@SUBJECT_NAME@@)\\s+(?:be|make|do)\\s+(?:a\\s+)?(?:good|strong|poor|bad|weak|solid|fit|candidate|match|developer|engineer)?|',
    'is\\s+(?:he|she|they|@@SUBJECT_NAME@@)\\s+(?:a|the)?\\s*(?:good|strong|poor|bad|weak|solid|fit|fit\\s+for|candidate|match|developer|engineer)\\b|',
    'how\\s+(?:good|strong|poor|bad|solid)\\s+(?:a\\s+)?(?:fit|candidate|match|fit\\s+for)',
    ')'
  ].join('').replace(/@@SUBJECT_NAME@@/g, `(?:${subjectNamePattern})`), 'i');
  if (role && roleFitPattern.test(q)) {
    const isNegativeFit = /\b(?:isn't|is not|not a|not.*fit|why.*not|bad fit|poor fit|wrong|why no)\b/.test(q);
    return { mode: 'ROLE_FIT', directAnswer: null,
      subjectEntity: subjectName, activeEntity: role,
      requiredEntities: [subjectName, role],
      responseShape: getResponseShape('ROLE_FIT'),
      evidenceRequirements: ['subject.experience', 'subject.skills', 'subject.gaps'],
      boundary: isNegativeFit ? 'State gaps and suggest better-fit roles from evidence' : 'Assess fit using evidence — state match level, supporting evidence, and honest caveats',
      forbiddenClaims: [] };
  }

  // ===== FUTURE CAPABILITY (generic, independent of knowledge base) =====
  // "Can he learn X?" / "Could he pick up X?" / "How quickly could he get up to speed on X?"
  // The target may be unknown to the knowledge base; classify as future learning.
  // Reject infinitive action phrases ("learn to ride a camel") while keeping "learn X" and "learn to use X".
  const futureLearnRe = new RegExp(
    String.raw`\b(?:can|could|would|will|should)\s+(?:he|she|they|@@SUBJECT_NAME@@)\s+(?:be\s+able\s+to\s+)?(?:learn|pick\s+up|get\s+(?:up\s+to\s+speed|proficient|good|comfortable)\s+(?:with|on|in)?|become\s+(?:proficient|good|comfortable)\s+(?:with|in)?|adapt\s+to|transition\s+to|get\s+used\s+to)\s+(?:a\s+(?:new\s+)?)?(?:framework\s+like\s+|language\s+like\s+|tool\s+like\s+)?([a-z][a-z0-9+#.\s]{1,40})`
      .replace(/@@SUBJECT_NAME@@/g, `(?:${subjectNamePattern})`),
    'i'
  );
  const futureLearnSubjectFirstRe = new RegExp(
    String.raw`\b(?:he|she|they|@@SUBJECT_NAME@@)\s+(?:can|could|would|will|should)\s+(?:be\s+able\s+to\s+)?(?:learn|pick\s+up|get\s+(?:up\s+to\s+speed|proficient|good|comfortable)\s+(?:with|on|in)?|become\s+(?:proficient|good|comfortable)\s+(?:with|in)?|adapt\s+to|transition\s+to|get\s+used\s+to)\s+(?:a\s+(?:new\s+)?)?(?:framework\s+like\s+|language\s+like\s+|tool\s+like\s+)?([a-z][a-z0-9+#.\s]{1,40})`
      .replace(/@@SUBJECT_NAME@@/g, `(?:${subjectNamePattern})`),
    'i'
  );
  const futureLearnSpeedRe = new RegExp(
    String.raw`\bhow\s+(?:quickly|fast|easily|long)\s+(?:could|would|can|will)\s+(?:he|she|they|@@SUBJECT_NAME@@)\s+(?:learn|pick\s+up|get\s+(?:up\s+to\s+speed|proficient|good|comfortable))\s+(?:a\s+(?:new\s+)?)?(?:framework\s+like\s+|language\s+like\s+|tool\s+like\s+)?([a-z][a-z0-9+#.\s]{1,40})`
      .replace(/@@SUBJECT_NAME@@/g, `(?:${subjectNamePattern})`),
    'i'
  );
  // ===== UNKNOWN TECHNOLOGY DEBUG / ISOLATION QUESTIONS =====
  const debugMatch = q.match(
    new RegExp(
      String.raw`\b(?:can|could|does|is)\s+(?:he|she|they|@@SUBJECT_NAME@@)\s+debug\s+([a-z0-9+#.]{2,})`
        .replace(/@@SUBJECT_NAME@@/g, `(?:${subjectNamePattern})`),
      'i'
    )
  );
  if (debugMatch) {
    const asked = debugMatch[1].toLowerCase();
    return { mode: 'SKILL_EVIDENCE', directAnswer: 'UNKNOWN',
      subjectEntity: subjectName, activeEntity: asked,
      evidenceStatus: 'UNVERIFIED',
      requiredEntities: [subjectName, asked],
      responseShape: getResponseShape('SKILL_EVIDENCE'),
      evidenceRequirements: ['subject.troubleshooting_process', 'subject.learning_approach'],
      boundary: 'Not independently on day one for an unfamiliar stack — debugging process transfers but needs codebase, toolchain, and mentorship',
      forbiddenClaims: ['independent debugging of ' + asked, 'verified experience with ' + asked] };
  }

  const futureMatch = q.match(futureLearnRe) || q.match(futureLearnSubjectFirstRe) || q.match(futureLearnSpeedRe);
  if (futureMatch) {
    const futureStop = new Set(['a','an','the','new','like','framework','language','tool','or','and','with','for','in','on','at','of','to','from','by','as','it','that','this','there','right','please','but']);
    const rawTarget = futureMatch[1].trim();
    const target = rawTarget
      .split(/\s+/)
      .filter(w => !futureStop.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')) && w.length >= 2)
      .slice(0, 3)
      .join(' ')
      .replace(/[.?!,;]+$/, '');
    // Infinitive action phrases ("learn to ride a camel") are arbitrary, not future skills.
    // "learn to use X" keeps X as the target because "use" is a generic skill application verb.
    let finalTarget = target;
    if (rawTarget.toLowerCase().startsWith('to ')) {
      const toTokens = target.split(/\s+/).filter(Boolean);
      if (toTokens[0] === 'use' && toTokens.length > 1) {
        finalTarget = toTokens.slice(1).join(' ');
      } else if (toTokens.length > 1) {
        return { mode: 'OUT_OF_SCOPE', reason: 'ARBITRARY_ACTION_PHRASE',
          subjectEntity: subjectName, requiredEntities: [agentName],
          responseShape: getResponseShape('OUT_OF_SCOPE'),
          evidenceRequirements: [], boundary: 'This is outside the scope of professional skills and projects.', forbiddenClaims: [] };
      }
    }
    if (finalTarget && finalTarget.length >= 2) {
      return { mode: 'FUTURE_CAPABILITY', directAnswer: 'UNKNOWN',
        subjectEntity: subjectName, activeEntity: finalTarget,
        evidenceStatus: 'UNVERIFIED',
        requiredEntities: [subjectName, finalTarget],
        responseShape: getResponseShape('FUTURE_CAPABILITY'),
        evidenceRequirements: ['subject.learning_history', 'subject.learning_approach', 'subject.adjacent_skills'],
        boundary: 'Assess future learning potential from adjacent documented skills and learning history. Do NOT claim existing knowledge of ' + finalTarget + '. Use a fresh sentence when noting the absence of verified ' + finalTarget + ' experience; do NOT copy or echo the previous turn\'s exact disclaimer.',
        forbiddenClaims: ['already knows ' + finalTarget, 'verified experience with ' + finalTarget, 'there is no verified evidence of ' + finalTarget + '; it is not documented in the profile'] };
    }
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
      requiredStance: 'REDIRECT_TO_SCOPE',
      answerRequestedExternalTopic: 'FORBIDDEN',
      allowedEvidenceScope: 'configured assistant knowledge only',
      boundary: 'Do NOT answer the external question. Name the topic you cannot help with, state that you can only help with questions about the subject\'s professional background, and offer to discuss their projects, skills, or experience.',
      forbiddenClaims: [] };
  }

  // ===== PROJECT COLLECTION QUESTIONS (generic) =====
  // Questions asking about the subject's projects/demos/portfolio in general
  if (/\b(?:projects?|demos?|portfolio|creations?|work samples?|code samples?)\b/.test(q) &&
      /\b(?:show|list|what|tell me about|describe|has (?:he|she|they)|have (?:he|she|they)|published|built|made|created|all)\b/.test(q) &&
      !/\b(?:compare|versus|vs\.?)\b/.test(q)) {
    return { mode: 'VERIFIED_FACT', subjectEntity: subjectName,
      requiredEntities: [subjectName],
      responseShape: getResponseShape('VERIFIED_FACT'),
      evidenceRequirements: ['subject.projects', 'subject.project_list'],
      boundary: null, forbiddenClaims: [] };
  }

  // ===== RECRUITER / HIRING MANAGER (generic) =====
  // Checked before the generic PROFILE/summary branch so recruiter-scoped
  // summaries keep the honest-strengths-and-gaps boundary.
  if (/\b(?:reasons? to interview|why should.*interview|why hire|why should.*hire|what makes.*worth|three reasons|hiring manager|recruiter note|candidate blurb|cautious recommendation|what.*manager know|summary for a recruiter|why should(?:n'?t| not) i hire|why not hire)\b/.test(q)) {
    return { mode: 'PROFILE', requiredEntities: [subjectName],
      responseShape: getResponseShape('PROFILE'),
      evidenceRequirements: ['subject.strengths', 'subject.gaps', 'subject.evidence_summary'],
      boundary: 'Be honest about verified strengths and gaps from evidence; do not infer an unverified experience stage',
      forbiddenClaims: [] };
  }

  // ===== PROFILE / SUMMARY (generic) =====
  // 'about' must be in a clear summary phrase (tell me about / who is / what is), not a bare 'what about X?' follow-up.
  if (/\b(?:summary|who is|tell me about|what is .* about|in (?:20|30) seconds|simple version|honest version|like a normal person|normal person|give me the simple|elevator|quick pitch|sell him in|pitch for|short pitch|one-liner|tl;dr|bottom line|honest takeaway|final verdict)\b/.test(q)) {
    return { mode: 'PROFILE', requiredEntities: [subjectName],
      responseShape: getResponseShape('PROFILE'),
      evidenceRequirements: ['subject.title', 'subject.location', 'subject.key_projects', 'subject.certifications'],
      boundary: null, forbiddenClaims: [] };
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
