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
//   * recentTurns          — last N turns (compact)
//
// This state is what lets Ollama resolve "that project", "the AWS one",
// "compare that to Voice Ops", etc. without re-sending the full raw history.
//
// Storage is in-memory with a TTL, capped per session count. Persistence beyond
// the process lifetime is not required for the public widget; analytics are
// recorded separately.

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
  { topic: 'aws', re: /\baws|amazon web services|lambda|dynamodb|s3|cloudfront|serverless\b/i },
  { topic: 'projects', re: /\bproject|portfolio|pokedex|cheesemath|projecthub|smokebuddy|ciris|codepen\b/i },
  { topic: 'skills', re: /\bskill|javascript|typescript|react|node|sql|python|debug\b/i },
  { topic: 'experience', re: /\bexperience|work|career|job at|internship|army|military\b/i },
  { topic: 'education', re: /\beducation|degree|school|gpa|full sail|college\b/i },
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
    state.activeComparison = projects.slice(0, 2).join(' vs ');
  }
  // Detect comparison follow-up: "compare that to X"
  const compareMatch = String(question || '').match(/\bcompare\b.*\b(?:to|with|and|vs)\b/i);
  if (compareMatch && state.currentProjects.length) {
    state.activeComparison = state.currentProjects.slice(0, 2).join(' vs ');
  }
  // Detect unresolved references ("that project", "the other one", "what about the backend")
  if (/\b(that|this|the other|the aws|the backend|it|one)\b/i.test(question) && !projects.length) {
    state.unresolvedReference = cleanText(question, 80);
  } else {
    state.unresolvedReference = null;
  }
  state = addTurn(state, question, reply);
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
  updateState,
  resolveReferents,
  storeSize
};
