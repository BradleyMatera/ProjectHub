'use strict';

// Query understanding: normalization, typo correction, intent classification,
// and contextual query rewriting (anaphora/ellipsis resolution).
// Pure JS, no dependencies. Used before retrieval to improve chunk matching.

// ============ TYPO MAP ============
const TYPO_MAP = {
  'recruter': 'recruiter', 'recruitr': 'recruiter',
  'certifcation': 'certification', 'certifcate': 'certificate',
  'experiance': 'experience', 'experence': 'experience',
  'educaton': 'education', 'eduction': 'education',
  'projct': 'project', 'porject': 'project',
  'skils': 'skills', 'sklls': 'skills',
  'javscript': 'javascript', 'javascrpt': 'javascript',
  'typescript': 'typescript',
  'engineer': 'engineer',
  'developr': 'developer',
  'intren': 'intern', 'intership': 'internship',
  'comunicat': 'communicate',
  'comunication': 'communication', 'communcation': 'communication',
  'reliab': 'reliable',
  'avaliable': 'available', 'availble': 'available',
  'strenght': 'strength', 'strenghts': 'strengths',
  'weaknes': 'weakness', 'weakneses': 'weaknesses',
  'qualifed': 'qualified', 'qulified': 'qualified',
  'collaberate': 'collaborate', 'collabrate': 'collaborate',
  'managment': 'management', 'documantation': 'documentation',
  'portfolo': 'portfolio',
  'contact': 'contact',
};

// Technology names may be valid query subjects even when the subject's verified
// profile does not mention them. Do not "correct" COBOL into a nearby corpus
// word such as "cool" merely because the technology is absent from the index.
const PROTECTED_TERMS = new Set([
  'cobol', 'fortran', 'rust', 'golang', 'ruby', 'rails', 'java', 'php',
  'swift', 'kotlin', 'salesforce', 'sap', 'mainframe', 'mainframes', 'delphi',
  'elixir', 'erlang', 'haskell', 'scala', 'perl', 'lua', 'dart', 'flutter',
  'angular', 'vue', 'svelte', 'terraform', 'ansible', 'kubernetes', 'jenkins',
]);

// Configurable subject name filter for word extraction
let _subjectNameFilter = [];
function configureSubjectNames(names = []) {
  _subjectNameFilter = names.filter(Boolean).map(n => n.toLowerCase());
}

// ============ INTENT CLASSIFICATION ============
const INTENT_RULES = [
  { intent: 'safety', re: /^(ignore|inject|system prompt|\.env|api key|password|hack|bypass|social security|birth date)/i },
  { intent: 'frustration', re: /\b(making me mad|making me angry|real feedback|generic answer|stop repeating|not listening)\b/i },
  { intent: 'contact', re: /\b(email|phone|reach|linkedin|github|contact)\b/i },
  { intent: 'role-fit', re: /\b(fit|role|candidate|hire|position|target|looking for|suitable|qualified)\b/i },
  { intent: 'weaknesses', re: /\b(weakness|weaknesses|gap|gaps|risk|concern|shortcoming)\b/i },
  { intent: 'strengths', re: /\b(strength|strengths|best at|good at|standout)\b/i },
  { intent: 'work-style', re: /\b(work style|feedback|collaborat|communicat|team|documentation|organized|learn|debug|problem.solv)\w*\b/i },
  { intent: 'experience-detail', re: /\b(experience|intern|work|job|career)\b/i },
  { intent: 'factual-lookup', re: /\b(skills?|certification|education|degree|gpa|project|tech|stack|language|location|based)\b/i },
  { intent: 'smalltalk', re: /^(hi|hello|hey|thanks|thank you|bye|goodbye|sup|howdy)\b/i },
  { intent: 'meta', re: /\b(scout|assistant|chatbot|widget|how do you work|what can you do)\b/i },
];

const QUERY_EXPANSIONS = [
  { re: /\btech stack\b/i, terms: 'skills languages frameworks databases tools' },
  { re: /\bavailability|available to start|start date\b/i, terms: 'start immediately notice period relocation remote target roles' },
  { re: /\bgood with people\b/i, terms: 'communication customer service teamwork' },
  { re: /\blearn(s|ing)? (fast|quickly)|quick learner|pick things up\b/i, terms: 'learning adaptability unfamiliar code feedback' },
  { re: /\bworth (an )?interview|should (we|i) interview\b/i, terms: 'role fit strengths gaps evidence' },
  { re: /\bwork (from home|remotely)|remote work\b/i, terms: 'remote hybrid location availability' },
  { re: /\bdeal with pressure|under pressure\b/i, terms: 'work style problem solving reliability' },
  { re: /\bfigure things out|solve problems\b/i, terms: 'debug troubleshooting problem solving methodology' },
  { re: /\bcan he learn\b|\blearn\b.*\bright\b/i, terms: 'learning adaptability unfamiliar code documentation mentorship hands-on practice' },
  { re: /\bdebug\b.*\b[a-z][a-z0-9+#.-]+\b/i, terms: 'debugging troubleshooting logs documentation codebase toolchain' },
  { re: /\bwhat.?s he like|personality\b/i, terms: 'work style communication collaboration reliability' },
  { re: /\b(what model|what provider|what llm|what ai|which model|what can you|what can i|what is scout|what is projecthub|who are you|what are you|what is your name|what's your name|what is this chatbot|what is this site|what is this thing|what powers you|what is your stack|how is this chat free|how is this hosted|daily cap|cooldown|rate limit|what data do you use)\b/i, terms: 'scout runtime projecthub' },
  { re: /\b(weakness|weaknesses|weak at|bad at|not good at|documented gap|documented gaps|area of improvement|learning area|learning areas)\b/i, terms: 'documented gaps learning areas' }
];

function expandQueryAliases(query) {
  const source = String(query || '').trim();
  const additions = QUERY_EXPANSIONS.filter(item => item.re.test(source)).map(item => item.terms);
  return additions.length ? `${source} ${additions.join(' ')}` : source;
}

// ============ DAMERAU-LEVENSHTEIN ============
function damerauLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// ============ NORMALIZATION ============
function normalizeQuery(query, knowledge) {
  let q = String(query || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Apply typo map
  const words = q.split(/\s+/);
  const corrected = words.map(w => TYPO_MAP[w] || w);
  let out = corrected.join(' ');
  // Apply KB-driven custom typos if available
  const typos = knowledge?.commonPatterns?.typos;
  if (typos && typeof typos === 'object') {
    for (const [bad, good] of Object.entries(typos)) {
      if (!bad || !good) continue;
      out = out.replace(new RegExp(`\\b${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), good);
    }
  }
  return out;
}

// ============ TYPO CORRECTION ============
function correctTypos(query, vocabulary, maxDistance = 2) {
  const words = query.split(/\s+/);
  const corrected = words.map(w => {
    if (w.length <= 3) return w;
    if (PROTECTED_TERMS.has(w)) return w;
    if (vocabulary.has(w)) return w;
    // Find closest vocabulary term within maxDistance
    let best = w;
    let bestDist = maxDistance + 1;
    for (const term of vocabulary) {
      if (Math.abs(term.length - w.length) > maxDistance) continue;
      const dist = damerauLevenshtein(w, term);
      if (dist < bestDist) {
        bestDist = dist;
        best = term;
      }
    }
    return best;
  });
  return corrected.join(' ');
}

// Build vocabulary from knowledge chunks for typo correction
function buildVocabulary(chunks) {
  const vocab = new Set();
  for (const chunk of chunks) {
    const words = String(chunk.text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);
    for (const w of words) vocab.add(w);
  }
  return vocab;
}

// ============ INTENT CLASSIFICATION ============
function classifyIntent(query) {
  const q = String(query || '').toLowerCase();
  for (const rule of INTENT_RULES) {
    if (rule.re.test(q)) return rule.intent;
  }
  return 'factual-lookup'; // default
}

// ============ CONTEXTUAL QUERY REWRITING ============
// Resolve pronouns and ellipsis from conversation history.
// "What about his time as a medic?" → "[subject] medic experience relevance to [previous topic]"
function rewriteQuery(query, history) {
  const q = String(query || '').trim();
  const qLower = q.toLowerCase();

  if (!Array.isArray(history) || history.length === 0) return q;

  let lastUser = '', lastAssistant = '';
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.role === 'user' && !lastUser) lastUser = String(turn.text || '');
    if (turn.role === 'assistant' && !lastAssistant) lastAssistant = String(turn.text || '');
    if (turn.user && !lastUser) lastUser = String(turn.user || '');
    if (turn.assistant && !lastAssistant) lastAssistant = String(turn.assistant || '');
  }

  if (!lastUser && !lastAssistant) return q;

  const lastUserLower = lastUser.toLowerCase();
  const lastAssistantLower = lastAssistant.toLowerCase();

  // Detect anaphora/ellipsis patterns
  const isBareFollowup = /^(\s*)(what about|how about|and his|also what|tell me about his|his|that|it|he|more about)\b/i.test(qLower);
  const isShortQuery = qLower.split(/\s+/).length < 8;

  if (!isBareFollowup && !isShortQuery) return q;

  // Extract salient nouns from the previous user question
  const lastUserWords = lastUser
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !['about', 'what', 'how', 'tell', 'does', 'would', 'could', 'should', ..._subjectNameFilter].includes(w));

  // Extract topic keywords from the previous assistant reply
  const lastAssistantWords = lastAssistant
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !['about', 'what', 'how', 'tell', 'does', 'would', 'could', 'should', ..._subjectNameFilter, 'based'].includes(w));

  // Combine: keep the new query's content words + salient nouns from prior context
  const queryWords = qLower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !['what', 'about', 'how', 'and', 'also', 'tell', 'more', 'his', 'her', 'that', 'this', 'it', 'he', 'she'].includes(w));

  // Merge unique words: query first, then context
  const merged = [...new Set([...queryWords, ...lastUserWords.slice(0, 3), ...lastAssistantWords.slice(0, 3)])];

  if (merged.length < 3) return q;

  // Build rewritten query
  const rewritten = merged.slice(0, 10).join(' ');
  return rewritten;
}

// ============ FULL QUERY UNDERSTANDING PIPELINE ============
function understandQuery(query, history, chunks, knowledge) {
  // 1. Normalize
  let normalized = normalizeQuery(query, knowledge);

  // 2. Correct typos against vocabulary
  if (chunks && chunks.length > 0) {
    const vocab = buildVocabulary(chunks);
    normalized = correctTypos(normalized, vocab);
  }

  // 3. Expand common natural-language phrasing into locally retrievable concepts.
  const expanded = expandQueryAliases(normalized);

  // 4. Classify intent
  const intent = classifyIntent(expanded);

  // 5. Contextual rewrite
  const rewritten = rewriteQuery(expanded, history);

  return {
    original: String(query || '').trim(),
    normalized,
    expanded,
    rewritten,
    intent,
  };
}

// ============ TOPIC CLASSIFICATION (generic abstract labels only) ============
const GENERIC_TOPIC_RULES = [
  { topic: 'projects', re: /project|portfolio|shipped|github repo/ },
  { topic: 'skills', re: /skill|stack|tech/ },
  { topic: 'experience', re: /experience|intern|work history|background|freelance|volunteer/ },
  { topic: 'writing', re: /\bblog\b|\bblogs\b|article|writing|publication|write about|writes about|written about/ },
  { topic: 'education', re: /education|degree|school|gpa|graduat|certif/ },
  { topic: 'contact', re: /contact|email|phone|reach|linkedin|portfolio link|github profile/ },
  { topic: 'resume', re: /resume|cv|cover letter/ },
  { topic: 'salary', re: /salary|pay|compensation|rate|hourly|annual|budget/ },
  { topic: 'benefits', re: /benefit|health insurance|pto|vacation|time off|401k|retirement|equity|bonus/ },
  { topic: 'remote', re: /remote|work from home|wfh|hybrid|on.?site|office|relocation|relocate|move|location/ },
  { topic: 'availability', re: /availability|start date|notice|available|ready to start|part.?time|full.?time/ },
  { topic: 'interview', re: /interview|screening|phone screen|technical interview|behavioral|prep/ },
  { topic: 'methodology', re: /methodology|workflow|process|approach|problem.?solving|debugging|troubleshoot|root cause/ },
  { topic: 'motivation', re: /motivation|passion|interested in|excited about|career goal/ },
  { topic: 'references', re: /reference|recommendation|referral|previous manager|colleague/ },
  { topic: 'role-fit', re: /role|fit|hire|candidate|job|position/ },
  { topic: 'strengths', re: /strength|strongest|greatest|best at|good at|standout|impressive|excellent/ },
  { topic: 'weaknesses', re: /weakness|weak at|concern|gap|limitation|red flag|worried|hesitant/ },
  { topic: 'interpersonal', re: /team|people|interpersonal|social|customer service|communication|collaborat/ },
  { topic: 'work-style', re: /work style|coding style|management style|feedback|preferred|work ethic|organized/ },
  { topic: 'out-of-scope', re: /not in|out of scope|favorite|food|weather|sports|politic|religion|hobby|personal|joke|write me (a|some)|who won|sky blue|world series|video game|code for me|translate|recipe|movie|music|song|dance|horoscope|zodiac|dream|astrology|who is on first|what.?s on first|who.?s on first|tell me a (joke|story|poem)|do you have a (mom|mother|family|feelings)|are you (alive|sentient|conscious)/ },
];

function classifyTopic(query, knowledge) {
  const q = normalizeQuery(query);
  const subjectAlt = knowledge?.identity?.preferredName || knowledge?.identity?.name || '';
  // Check specific topics first, then summary as a fallback for open-ended "who is X" questions
  for (const { topic, re } of GENERIC_TOPIC_RULES) {
    if (re.test(q)) return topic;
  }
  if (subjectAlt && new RegExp(`who is ${subjectAlt}|about ${subjectAlt}|summary|bio|overview|elevator|pitch`).test(q)) return 'summary';
  if (/tell me about|who is the candidate|what can you tell me/.test(q)) return 'summary';
  return 'uncategorized';
}

// ============ RELEVANCE CHECK (KB-driven) ============
function isRelevant(query, knowledge) {
  const normalized = normalizeQuery(query);
  const preferredName = knowledge?.identity?.preferredName || knowledge?.identity?.name || '';
  if (preferredName && normalized.includes(preferredName.toLowerCase())) return true;

  // Check KB entities
  const entities = [];
  if (Array.isArray(knowledge?.experience)) {
    for (const exp of knowledge.experience) {
      if (exp.company) entities.push(String(exp.company).toLowerCase());
    }
  }
  if (knowledge?.skills && typeof knowledge.skills === 'object') {
    for (const vals of Object.values(knowledge.skills)) {
      if (Array.isArray(vals)) entities.push(...vals.map(v => String(v).toLowerCase()));
    }
  }
  if (Array.isArray(knowledge?.projects)) {
    for (const p of knowledge.projects) {
      if (p.name) entities.push(String(p.name).toLowerCase());
    }
  }
  if (Array.isArray(knowledge?.certifications)) {
    for (const c of knowledge.certifications) {
      if (c.name) entities.push(String(c.name).toLowerCase());
    }
  }
  if (knowledge?.education?.school) entities.push(String(knowledge.education.school).toLowerCase());

  for (const entity of entities) {
    if (entity.length > 2 && normalized.includes(entity)) return true;
  }

  // Generic abstract recruiter concepts (not specific technologies)
  const genericConcepts = [
    'candidate', 'recruiter', 'skill', 'project', 'portfolio',
    'contact', 'email', 'phone', 'role', 'job', 'education',
    'cert', 'resume', 'work', 'experience', 'hire', 'strength',
    'weakness', 'feedback', 'team', 'communication', 'reference',
    'interview', 'availability', 'salary', 'remote', 'relocation',
  ];
  for (const concept of genericConcepts) {
    if (new RegExp(`\\b${concept}\\b`).test(normalized)) return true;
  }

  return false;
}

module.exports = {
  normalizeQuery,
  correctTypos,
  buildVocabulary,
  classifyIntent,
  classifyTopic,
  isRelevant,
  rewriteQuery,
  understandQuery,
  damerauLevenshtein,
  TYPO_MAP,
  INTENT_RULES,
  QUERY_EXPANSIONS,
  PROTECTED_TERMS,
  expandQueryAliases,
  configureSubjectNames
};
