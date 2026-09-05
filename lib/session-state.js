'use strict';

// Server-owned structured conversation state.
//
// The browser is NOT authoritative for conversation state. The server owns a
// structured per-session state object that tracks:
//   * currentTopic         — what the conversation is about
//   * currentProjects      — project names mentioned/resolved
//   * currentJob           — last pasted job description (compact)
//   * currentCompany       — company mentioned
//   * activeComparison     — projects being compared
//   * intent               — last detected intent
//   * unresolvedReference  — a referent the model should resolve
//   * userName             — visitor's supplied name for this session
//   * recentTurns          — last N turns (compact)
//
// This state is what lets Ollama resolve "that project", "the AWS one",
// "compare that to Voice Ops", etc. without re-sending the full raw history.
//
// Storage is in-memory with a TTL, capped per session count. Persistence beyond
// the process lifetime is not required for the public widget; analytics are
// recorded separately.

const {
  extractEntitiesFromText,
  extractContinuation,
  extractCorrection,
  extractRemoval,
  extractExplicitSet
} = require('./conversation-resolver');

const STATE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const STATE_MAX_SESSIONS = 250;
const STATE_MAX_TURNS = 5;
const MAX_JOB_CHARS = 600;
const MAX_PROJECTS = 4;

const sessionStateStore = new Map();

function cleanText(value, max) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function now() { return Date.now(); }

function pruneExpired() {
  const cutoff = now() - STATE_TTL_MS;
  for (const [id, entry] of sessionStateStore) {
    if (entry.updatedAt < cutoff) sessionStateStore.delete(id);
  }
}

function getState(sessionId) {
  if (!sessionId) return freshState();
  pruneExpired();
  const entry = sessionStateStore.get(sessionId);
  if (!entry) return freshState();
  return entry.state;
}

function freshState() {
  return {
    currentTopic: null,
    currentProjects: [],
    currentJob: null,
    currentCompany: null,
    activeComparison: null,
    intent: null,
    unresolvedReference: null,
    userName: null,
    discourseFrame: null,
    turnCounter: 0,
    recentTurns: []
  };
}

function setState(sessionId, state) {
  if (!sessionId) return state;
  sessionStateStore.set(sessionId, { state, updatedAt: now() });
  while (sessionStateStore.size > STATE_MAX_SESSIONS) {
    sessionStateStore.delete(sessionStateStore.keys().next().value);
  }
  return state;
}

function clearState(sessionId) {
  if (!sessionId) return;
  sessionStateStore.delete(sessionId);
}

function addTurn(state, user, assistant) {
  const turns = (state.recentTurns || []).slice(-STATE_MAX_TURNS + 1);
  turns.push({
    user: cleanText(user, 200),
    assistant: cleanText(assistant, 240)
  });
  state.recentTurns = turns;
  return state;
}

// Detect topic from a question using lightweight normalization (not a giant
// regex engine — the model resolves ambiguity; this is just a hint).
const TOPIC_HINTS = [
  { topic: 'aws', re: /\b(?:aws|amazon web services)\b/i },
  { topic: 'projects', re: /\bproject|portfolio\b/i },
  { topic: 'skills', re: /\bskill|javascript|typescript|react|node|sql|python|debug\b/i },
  { topic: 'experience', re: /\bexperience|work|career|job at|internship\b/i },
  { topic: 'education', re: /\beducation|degree|school|gpa|college\b/i },
  { topic: 'job-fit', re: /\bfit|role|position|hire|candidate|job description|requirements\b/i },
  { topic: 'comparison', re: /\bcompare|versus|\bvs\b|difference|better\b/i },
  { topic: 'contact', re: /\bcontact|email|linkedin|github|reach\b/i }
];

function detectTopic(question) {
  const q = String(question || '');
  for (const hint of TOPIC_HINTS) {
    if (hint.re.test(q)) return hint.topic;
  }
  return null;
}

// Detect project names mentioned in a question, using the knowledge base.
function detectProjects(question, knowledge) {
  const q = String(question || '').toLowerCase();
  const projects = knowledge?.projects || [];
  const found = [];
  for (const project of projects) {
    const name = String(project.name || '').toLowerCase();
    if (!name) continue;
    if (q.includes(name)) {
      found.push(project.name);
      continue;
    }
    // Match on distinctive multi-word tokens
    const tokens = name.split(/\s+/).filter(w => w.length > 4);
    if (tokens.length && tokens.some(w => q.includes(w))) {
      found.push(project.name);
    }
  }
  return found.slice(0, MAX_PROJECTS);
}

// Detect a pasted job description (longer text with requirement-like keywords).
function detectJobDescription(question) {
  const text = String(question || '').trim();
  if (text.length < 120) return null;
  if (/\b(require|requirements|responsibilities|qualifications|must have|nice to have|years of experience|bachelor|degree|certification)\b/i.test(text)) {
    return cleanText(text, MAX_JOB_CHARS);
  }
  return null;
}

// Extract a visitor name from user-supplied intros like "My name is Kevin".
// Rejects article-led statements ("I am a recruiter at Microsoft") and stops at
// prepositions so only the actual name is captured.
function extractUserName(question) {
  const q = String(question || '').trim();
  if (!q) return null;
  const re = /\b(?:my name is|call me|i am|i['']?m|this is)\s+(?!a\s+|an\s+|the\s+)([a-zA-Z][a-zA-Z.'-]*(?:\s+[a-zA-Z][a-zA-Z.'-]*){0,2})(?=\s*(?:[.,!?;]|(?:\b(?:at|for|with|from|in|of)\b))|\s*$)/i;
  const m = q.match(re);
  if (!m) return null;
  const raw = m[1].replace(/[.,!?;]/g, ' ').trim();
  const stop = new Set(['and', 'the', 'is', 'a', 'an', 'for', 'to', 'my', 'i', 'am', 'name', 'called', 'im', 'this', 'of', 'in', 'on', 'at', 'with', 'from', 'that', 'it', 'but']);
  const parts = raw.split(/\s+/)
    .filter(w => /^[a-zA-Z]+$/.test(w) && !stop.has(w.toLowerCase()))
    .slice(0, 2);
  if (!parts.length) return null;
  return parts.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join(' ');
}

// Apply a conversational control intent to session state BEFORE generation so
// user facts (name, active topic, projects) are already committed when the
// model is asked to respond.
function applyControlIntent(sessionId, question, knowledge, detectedIntent) {
  let state = getState(sessionId);
  state = { ...state };

  const userName = extractUserName(question);
  if (userName) state.userName = userName;

  const topic = detectTopic(question);
  if (topic) state.currentTopic = topic;

  const projects = detectProjects(question, knowledge);
  if (projects.length) {
    state.currentProjects = [...new Set([...projects, ...state.currentProjects])].slice(0, MAX_PROJECTS);
  }

  const job = detectJobDescription(question);
  if (job) state.currentJob = job;

  if (detectedIntent) state.intent = detectedIntent;

  return setState(sessionId, state);
}

// Update structured state from a new user message + the reply we produced.
function updateState(sessionId, question, reply, knowledge, detectedIntent) {
  let state = getState(sessionId);
  state = { ...state };
  const topic = detectTopic(question);
  if (topic) state.currentTopic = topic;
  if (detectedIntent) state.intent = detectedIntent;
  const projects = detectProjects(question, knowledge);
  if (projects.length) {
    state.currentProjects = [...new Set([...projects, ...state.currentProjects])].slice(0, MAX_PROJECTS);
  }
  const job = detectJobDescription(question);
  if (job) state.currentJob = job;
  if (topic === 'comparison' && projects.length >= 2) {
    state.activeComparison = projects.slice(0, 4);
  }
  // Detect comparison follow-up: "compare that to X"
  const compareMatch = String(question || '').match(/\bcompare\b.*\b(?:to|with|and|vs)\b/i);
  if (compareMatch && state.currentProjects.length) {
    // Merge existing projects with any new ones from this turn
    const allProjects = [...new Set([...projects, ...state.currentProjects])].slice(0, 4);
    state.activeComparison = allProjects;
  }
  // Detect unresolved references ("that project", "the other one", "what about the backend")
  if (/\b(that|this|the other|the aws|the backend|it|one)\b/i.test(question) && !projects.length) {
    state.unresolvedReference = cleanText(question, 80);
  } else {
    state.unresolvedReference = null;
  }
  // Preserve any userName already committed by applyControlIntent.
  state.userName = state.userName || extractUserName(question) || null;
  state = addTurn(state, question, reply);
  return setState(sessionId, state);
}

// --- Generic discourse frame ------------------------------------------------
// The frame records the active conversational RELATION (the classified intent)
// plus the ordered user-introduced alternatives being discussed. Frame intent
// and entity type are independent: membership proves only that the user raised
// the alternative, never what kind of entity it is.
//
//   discourseFrame = {
//     intent,            // policy mode that created the frame
//     subject,           // evaluated subject entity, if any
//     createdAtTurn, updatedAtTurn,
//     alternatives: [{ name, type, source: 'user', turnIndex,
//                      confidence: 'explicit'|'contextual'|'corrected',
//                      active }]
//   }

const FRAME_INERT_MODES = new Set([
  'GREETING', 'USER_PROFILE_UPDATE', 'USER_PROFILE_QUERY', 'THANKS', 'FAREWELL',
  'HELP', 'CONVERSATIONAL', 'SMALL_TALK', 'REQUEST_TO_SAY',
  'CLARIFY_PREVIOUS_ASSISTANT', 'CLARIFICATION', 'REFUSAL', 'OUT_OF_SCOPE', 'META'
]);

const FRAME_MAX_GAP_TURNS = 3;

function knowledgeEntityType(name, knowledge) {
  const found = extractEntitiesFromText(String(name || ''), knowledge || {});
  return found.length ? found[0].type : 'unknown';
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function commitDiscourseTurn(sessionId, question, policy, knowledge) {
  const state = { ...getState(sessionId) };
  const turn = (state.turnCounter || 0) + 1;
  state.turnCounter = turn;
  let frame = state.discourseFrame
    ? { ...state.discourseFrame, alternatives: (state.discourseFrame.alternatives || []).map(a => ({ ...a })) }
    : null;

  const q = String(question || '').trim();
  const correction = extractCorrection(q);
  const removal = !correction && extractRemoval(q);
  const continuation = !correction && !removal && extractContinuation(q);
  const explicitSet = !correction && !removal ? extractExplicitSet(q) : null;

  const subjectName = String(knowledge?.identity?.name || '').toLowerCase();
  const agentName = String(knowledge?.agent?.name || '').toLowerCase();
  const policyIsInert = !policy || FRAME_INERT_MODES.has(policy.mode);

  function policyEntityNames() {
    if (!policy) return [];
    const raw = []
      .concat(policy.activeEntity ? [policy.activeEntity] : [])
      .concat(Array.isArray(policy.requiredEntities) ? policy.requiredEntities : [])
      .map(n => String(n || '').trim())
      .filter(n => n && n.length <= 60 && n.toLowerCase() !== subjectName && n.toLowerCase() !== agentName);
    return [...new Set(raw.map(n => n.toLowerCase()))]
      .map(lower => raw.find(n => n.toLowerCase() === lower));
  }

  function seedFrame(intent, names, subject) {
    return {
      intent,
      subject: subject || null,
      createdAtTurn: turn,
      updatedAtTurn: turn,
      alternatives: names.map(n => ({
        name: n,
        type: knowledgeEntityType(n, knowledge),
        source: 'user', turnIndex: turn, confidence: 'explicit', active: true
      }))
    };
  }

  function appendAlternatives(targetFrame, names, confidence) {
    for (const n of names) {
      const name = String(n || '').trim();
      if (!name) continue;
      const existing = targetFrame.alternatives.find(a => sameName(a.name, name));
      if (existing) {
        existing.active = true;
        existing.turnIndex = turn;
      } else {
        targetFrame.alternatives.push({
          name,
          type: knowledgeEntityType(name, knowledge),
          source: 'user', turnIndex: turn, confidence, active: true
        });
      }
    }
    targetFrame.updatedAtTurn = turn;
  }

  // Frame expiry: untouched for several committed turns -> drop it.
  if (frame && turn - (frame.updatedAtTurn || frame.createdAtTurn || turn) > FRAME_MAX_GAP_TURNS) {
    frame = null;
  }

  if (correction) {
    if (frame) {
      const target = correction.notName
        ? frame.alternatives.find(a => a.active !== false && sameName(a.name, correction.notName))
        : [...frame.alternatives].reverse().find(a => a.active !== false);
      if (target) target.active = false;
      if (!frame.alternatives.some(a => sameName(a.name, correction.name))) {
        frame.alternatives.push({
          name: correction.name,
          type: knowledgeEntityType(correction.name, knowledge),
          source: 'user', turnIndex: turn, confidence: 'explicit', active: true, corrected: true
        });
      } else {
        const existing = frame.alternatives.find(a => sameName(a.name, correction.name));
        if (existing) existing.active = true;
      }
      frame.updatedAtTurn = turn;
    }
  } else if (removal) {
    if (frame) {
      if (/^(?:that|this|it|those|them|everything|all|it all)$/i.test(removal.name)) {
        frame = null;
      } else {
        const target = frame.alternatives.find(a => a.active !== false && sameName(a.name, removal.name));
        if (target) {
          target.active = false;
          frame.updatedAtTurn = turn;
        }
      }
    }
  } else if (continuation && !continuation.referential && frame) {
    // Elliptical continuation under an active frame: the user is extending the
    // current discussion. Policy-confirmed continuations (contextualInheritance,
    // or a fresh classification that landed on the same relation) extend the
    // ordered set; a different substantive intent with its own entities is a
    // genuine topic change and replaces the frame.
    const continuationNames = String(policy?.activeEntity || continuation.name)
      .split(/\s+(?:and|or|vs\.?|versus)\s+/i)
      .map(s => s.trim()).filter(Boolean);
    const names = (policy && policy.contextualInheritance)
      ? continuationNames
      : (policyEntityNames().length ? policyEntityNames() : continuationNames);
    const sameRelation = !policyIsInert && policy.mode === frame.intent;
    if (policy?.contextualInheritance || sameRelation) {
      appendAlternatives(frame, names, policy?.contextualInheritance ? 'contextual' : 'explicit');
    } else if (!policyIsInert && policyEntityNames().length) {
      frame = seedFrame(policy.mode, policyEntityNames(), policy.subjectEntity);
    }
  } else if (explicitSet && explicitSet.length) {
    // The user explicitly introduced a choice/comparison set ("compare A and
    // B", "choosing between A and B") — seed a frame even when the turn's own
    // policy mode is inert; the discourse record is user truth.
    frame = seedFrame(policyIsInert ? 'COMPARISON' : policy.mode, explicitSet, policy?.subjectEntity);
  } else if (policy && !policyIsInert && !policy.contextualInheritance && !continuation) {
    // A full substantive turn seeds or replaces the frame only when it names
    // its own entities; an entity-less question leaves the frame alone.
    const names = policyEntityNames();
    if (names.length) {
      frame = seedFrame(policy.mode, names, policy.subjectEntity);
    }
  }

  state.discourseFrame = frame;
  return setState(sessionId, state);
}

// Resolve a referent using current state — returns project names the model
// should consider when the user says "that project" etc.
function resolveReferents(state) {
  if (!state) return { projects: [], topic: null };
  return {
    projects: state.currentProjects || [],
    topic: state.currentTopic,
    job: state.currentJob,
    comparison: state.activeComparison
  };
}

function storeSize() {
  return sessionStateStore.size;
}

module.exports = {
  STATE_TTL_MS,
  STATE_MAX_SESSIONS,
  STATE_MAX_TURNS,
  freshState,
  getState,
  setState,
  clearState,
  addTurn,
  detectTopic,
  detectProjects,
  detectJobDescription,
  extractUserName,
  applyControlIntent,
  commitDiscourseTurn,
  updateState,
  resolveReferents,
  storeSize
};
