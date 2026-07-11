require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'gemini'; // gemini | openai | ollama
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:1b';

// Free multi-provider network keys
const XAI_API_KEY = process.env.XAI_API_KEY || '';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.3';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const GITHUB_MODELS_TOKEN = process.env.GITHUB_MODELS_TOKEN || '';
const GITHUB_MODELS_MODEL = process.env.GITHUB_MODELS_MODEL || 'openai/gpt-4o-mini';
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CLOUDFLARE_MODEL = process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.2-3b-instruct';
const PROVIDER_ORDER = (process.env.PROVIDER_ORDER || 'groq,cloudflare,github,gemini,grok')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .filter(s => s !== 'ollama');

const KNOWLEDGE_URL = process.env.KNOWLEDGE_URL || 'https://raw.githubusercontent.com/BradleyMatera/ProjectHub/master/data/recruiter-knowledge.json';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://bradleymatera.dev,https://www.bradleymatera.dev,https://bradleymatera.github.io').split(',').map(s => s.trim()).filter(Boolean);

let knowledgeCache = null;
let knowledgeCacheAt = 0;
const KNOWLEDGE_CACHE_MS = 5 * 60 * 1000;
const RESPONSE_CACHE_MS = 10 * 60 * 1000;
const RESPONSE_CACHE_LIMIT = 120;
const GEMINI_TIMEOUT_MS = 7000;
const MAX_ACTIVE_GENERATIONS = 1;
const responseCache = new Map();
let activeGenerations = 0;

// Circuit breaker for the free LLM provider network.
// When the last several network calls all failed, skip the network for a cooldown
// and return the fast grounded fallback instead.
const networkHealth = { failures: [], successes: [], lastSuccessAt: Date.now() };
const CIRCUIT_BREAKER_WINDOW = 5; // look at last 5 outcomes
const CIRCUIT_BREAKER_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 0.8; // skip if >=80% of recent calls failed

function recordNetworkOutcome(success) {
  const now = Date.now();
  if (success) {
    networkHealth.successes.push(now);
    networkHealth.lastSuccessAt = now;
  } else {
    networkHealth.failures.push(now);
  }
  // Trim old entries
  const cutoff = now - 5 * 60 * 1000;
  networkHealth.failures = networkHealth.failures.filter(t => t > cutoff);
  networkHealth.successes = networkHealth.successes.filter(t => t > cutoff);
}

function isNetworkCircuitOpen() {
  const total = networkHealth.failures.length + networkHealth.successes.length;
  if (total < CIRCUIT_BREAKER_WINDOW) return false;
  const failureRate = networkHealth.failures.length / total;
  const recentlySuccessful = (Date.now() - networkHealth.lastSuccessAt) < CIRCUIT_BREAKER_COOLDOWN_MS;
  return failureRate >= CIRCUIT_BREAKER_FAILURE_THRESHOLD && !recentlySuccessful;
}

// ============ LEARNING SYSTEM ============
const LEARNED_FILE = path.join(__dirname, 'learned.json');
const THINK_INTERVAL_MS = 10 * 60 * 1000;
let thinkRunning = false;
const GITHUB_API_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || GITHUB_MODELS_TOKEN || '';
const GITHUB_REPO_OWNER = 'BradleyMatera';
const GITHUB_REPO_NAME = 'ProjectHub';
const GITHUB_KNOWLEDGE_PATH = 'data/recruiter-knowledge.json';

const defaultLearned = { stashed: [], learned: [], learnedCount: 0, lastThinkAt: 0, scoredHistory: [] };
let learnedData;
try {
  const raw = fs.readFileSync(LEARNED_FILE, 'utf8');
  learnedData = { ...defaultLearned, ...JSON.parse(raw) };
} catch {
  learnedData = { ...defaultLearned };
}

function saveLearned() {
  try { fs.writeFileSync(LEARNED_FILE, JSON.stringify(learnedData, null, 2)); }
  catch (e) { console.error('Failed to save learned.json:', e.message); }
}

// ============ FREE MULTI-PROVIDER LLM NETWORK ============
const PROVIDER_DEFS = {
  grok: {
    type: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    apiKey: XAI_API_KEY,
    model: XAI_MODEL,
    dailyLimit: parseInt(process.env.XAI_DAILY_LIMIT || '1000', 10)
  },
  groq: {
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: GROQ_API_KEY,
    model: GROQ_MODEL,
    dailyLimit: parseInt(process.env.GROQ_DAILY_LIMIT || '1000', 10)
  },
  cloudflare: {
    type: 'cloudflare',
    accountId: CLOUDFLARE_ACCOUNT_ID,
    apiToken: CLOUDFLARE_API_TOKEN,
    model: CLOUDFLARE_MODEL,
    dailyLimit: parseInt(process.env.CLOUDFLARE_DAILY_LIMIT || '300', 10)
  },
  github: {
    type: 'openai',
    baseUrl: 'https://models.github.ai/inference',
    apiKey: GITHUB_MODELS_TOKEN,
    model: GITHUB_MODELS_MODEL,
    dailyLimit: parseInt(process.env.GITHUB_DAILY_LIMIT || '150', 10)
  },
  gemini: {
    type: 'gemini',
    apiKey: GEMINI_API_KEY,
    model: GEMINI_MODEL,
    dailyLimit: parseInt(process.env.GEMINI_DAILY_LIMIT || '1500', 10)
  },
  ollama: {
    type: 'ollama',
    model: process.env.GEN_MODEL || 'smollm2:135m',
    dailyLimit: Infinity
  },
  openai: {
    type: 'openai',
    baseUrl: OPENAI_BASE_URL,
    apiKey: OPENAI_API_KEY,
    model: OPENAI_MODEL,
    dailyLimit: parseInt(process.env.OPENAI_DAILY_LIMIT || '200', 10)
  }
};

const providerState = new Map();

function getProviderState(slug) {
  if (!providerState.has(slug)) {
    providerState.set(slug, { count: 0, exhaustedUntil: 0, day: new Date().getUTCDate() });
  }
  return providerState.get(slug);
}

function resetDailyIfNeeded(state) {
  const today = new Date().getUTCDate();
  if (state.day !== today) {
    state.count = 0;
    state.day = today;
  }
}

function isProviderEnabled(slug) {
  const def = PROVIDER_DEFS[slug];
  if (!def) return false;
  if (def.type === 'openai') return def.apiKey.length > 10;
  if (def.type === 'cloudflare') return def.apiToken.length > 10 && def.accountId.length > 10;
  if (def.type === 'gemini') return def.apiKey.length > 10;
  if (def.type === 'ollama') return GEN_ENABLED;
  return false;
}

function isProviderAvailable(slug) {
  const state = getProviderState(slug);
  resetDailyIfNeeded(state);
  if (Date.now() < state.exhaustedUntil) return false;
  const def = PROVIDER_DEFS[slug];
  if (state.count >= def.dailyLimit) return false;
  return true;
}

function recordProviderAttempt(slug) {
  const state = getProviderState(slug);
  resetDailyIfNeeded(state);
  state.count += 1;
}

function markProviderExhausted(slug, durationMs = 60 * 1000) {
  const state = getProviderState(slug);
  state.exhaustedUntil = Math.max(state.exhaustedUntil, Date.now() + durationMs);
}

function providerStatus() {
  return Object.keys(PROVIDER_DEFS).map(slug => {
    const state = getProviderState(slug);
    resetDailyIfNeeded(state);
    return {
      slug,
      enabled: isProviderEnabled(slug),
      available: isProviderAvailable(slug),
      exhausted: Date.now() < state.exhaustedUntil,
      usedToday: state.count,
      limit: PROVIDER_DEFS[slug].dailyLimit,
      model: PROVIDER_DEFS[slug].model
    };
  });
}

app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    if (ALLOWED_ORIGINS.includes('https://*.codepen.io') && /^https:\/\/[^/]+\.codepen\.io$/.test(origin)) return callback(null, true);
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use('/api/chat', rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many chat requests. Please slow down.' }
}));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Bradley Matera Recruiter Chat API', status: 'online', backend: 'free-multi-provider-llm-network' });
});

const DEPLOYED_AT = Date.now();
app.get('/health', async (req, res) => {
  const providers = providerStatus();
  const totalFreeUsedToday = providers.reduce((sum, p) => sum + (p.usedToday || 0), 0);
  res.json({
    ok: true,
    status: 'online',
    deployedAt: DEPLOYED_AT,
    uptimeSeconds: Math.floor(process.uptime()),
    // This-restart stats
    totalRequestsServed,
    lastReplyProvider,
    totalFreeUsedToday,
    // Persistent all-time stats
    allTimeRequests: persistentStats.totalRequestsAllTime,
    groundedCount: persistentStats.groundedCount,
    llmCount: persistentStats.llmCount,
    cachedCount: persistentStats.cachedCount,
    providerBreakdown: persistentStats.providerBreakdown,
    deployCount: persistentStats.deployCount,
    firstDeployAt: persistentStats.firstDeployAt,
    recentRequests: persistentStats.recentRequests,
    referrerBreakdown: persistentStats.referrerBreakdown,
    topicBreakdown: persistentStats.topicBreakdown,
    hourlyRequests: persistentStats.hourlyRequests,
    lastPipeline: persistentStats.lastPipeline || [],
    providerHealth: persistentStats.providerHealth,
    recentSessions: getRecentSessions(),
    // Provider table
    providerOrder: PROVIDER_ORDER,
    providers,
    genModel: process.env.GEN_MODEL || 'smollm2:135m',
    genTimeoutMs: parseInt(process.env.GEN_TIMEOUT_MS || '13000', 10),
    knowledgeUrl: KNOWLEDGE_URL,
    mode: 'rag-generative-with-grounded-fallback',
    // Learning system stats
    learning: {
      stashedCount: learnedData.stashed.length,
      learnedCount: learnedData.learnedCount,
      pendingLearned: learnedData.learned.length,
      lastThinkAt: learnedData.lastThinkAt,
      thinkRunning,
      hasGitHubToken: GITHUB_API_TOKEN.length >= 10,
      nextThinkIn: Math.max(0, THINK_INTERVAL_MS - (Date.now() - (learnedData.lastThinkAt || 0))),
      learnedScores: [...(learnedData.learned || []), ...(learnedData.scoredHistory || [])].map(l => ({ q: l.q, score: l.score, groundedScore: l.groundedScore, provider: l.provider })),
      avgLearnedScore: [...(learnedData.learned || []), ...(learnedData.scoredHistory || [])].length > 0 ? Math.round([...learnedData.learned, ...(learnedData.scoredHistory || [])].reduce((s, l) => s + (l.score || 0), 0) / [...learnedData.learned, ...(learnedData.scoredHistory || [])].length) : 0,
      avgGroundedScore: [...(learnedData.learned || []), ...(learnedData.scoredHistory || [])].length > 0 ? Math.round([...learnedData.learned, ...(learnedData.scoredHistory || [])].reduce((s, l) => s + (l.groundedScore || 0), 0) / [...learnedData.learned, ...(learnedData.scoredHistory || [])].length) : 0
    }
  });
});

app.get('/api/diagnose', async (req, res) => {
  try {
    const knowledge = await fetchKnowledge();
    if (!knowledge) return res.json({ ok: false, error: 'Knowledge not loaded' });

    const testQuestion = 'What is Bradley Matera\'s tech stack?';
    const results = [];

    for (const slug of PROVIDER_ORDER) {
      const def = PROVIDER_DEFS[slug];
      if (!def) continue;
      if (!isProviderEnabled(slug)) {
        results.push({ slug, enabled: false, available: false, error: 'not configured' });
        continue;
      }

      const providerStart = Date.now();
      let outcome = { slug, enabled: true, available: isProviderAvailable(slug) };
      try {
        let raw = '';
        if (def.type === 'openai') {
          raw = await callOpenAICompatibleProvider(def.baseUrl, def.apiKey, def.model, knowledge, testQuestion, []);
        } else if (def.type === 'cloudflare') {
          raw = await callCloudflareWorkersAI(def.accountId, def.apiToken, def.model, knowledge, testQuestion, []);
        } else if (def.type === 'gemini') {
          raw = await callGeminiWithPrompt(buildPrompt(knowledge, testQuestion, [], 'gemini'), def.model);
        } else if (def.type === 'ollama') {
          const grounded = buildGroundedFallbackPayload(knowledge, testQuestion, []);
          raw = await callGenerativeRag(knowledge, testQuestion, grounded.reply, [], Math.min(GEN_TIMEOUT_MS, 8000));
        }

        const cleaned = removeSlop(String(raw || '').trim().replace(/\s+/g, ' '));
        const sourceText = buildPrompt(knowledge, testQuestion, [], 'openai').replace(/\s+/g, ' ').toLowerCase();
        const valid = cleaned && cleaned.length >= 15 && validateNetworkReply(cleaned, sourceText);
        outcome.latencyMs = Date.now() - providerStart;
        outcome.validated = valid;
        outcome.replyPreview = cleaned.slice(0, 160);
        if (!valid) outcome.error = 'validation failed';
      } catch (err) {
        outcome.latencyMs = Date.now() - providerStart;
        outcome.error = String(err.message || err).slice(0, 200);
      }
      results.push(outcome);
    }

    res.json({ ok: true, testQuestion, results, circuitOpen: isNetworkCircuitOpen() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/knowledge-health', async (req, res) => {
  try {
    const knowledge = await fetchKnowledge();
    if (!knowledge) return res.json({ ok: false, error: 'Knowledge not loaded' });

    // Field coverage
    const fields = {};
    const checkField = (obj, prefix = '') => {
      for (const [key, val] of Object.entries(obj || {})) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
          fields[path] = { hasData: false };
        } else if (typeof val === 'object' && !Array.isArray(val)) {
          checkField(val, path);
        } else {
          fields[path] = { hasData: true, type: Array.isArray(val) ? 'array' : typeof val, length: Array.isArray(val) ? val.length : String(val).length };
        }
      }
    };
    checkField(knowledge);

    const totalFields = Object.keys(fields).length;
    const populatedFields = Object.values(fields).filter(f => f.hasData).length;
    const emptyFields = Object.entries(fields).filter(([, f]) => !f.hasData).map(([k]) => k);

    // Gap clustering — group stashed questions by keyword overlap
    const stashed = learnedData.stashed || [];
    const clusters = {};
    for (const item of stashed) {
      const words = String(item.q || '').toLowerCase().split(/\s+/).filter(w => w.length > 3 && !/bradley|brad|matera|about|what|does|know|tell|please|would|could|should/.test(w));
      const key = words.slice(0, 2).sort().join('+') || 'misc';
      if (!clusters[key]) clusters[key] = { count: 0, questions: [] };
      clusters[key].count++;
      clusters[key].questions.push(item.q);
    }
    const gapClusters = Object.entries(clusters)
      .map(([key, data]) => ({ topic: key, count: data.count, examples: data.questions.slice(0, 3) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Topic analytics — which topics have the most questions
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayTopics = persistentStats.topicBreakdown[todayKey] || {};
    const allTopics = {};
    for (const day of Object.values(persistentStats.topicBreakdown || {})) {
      for (const [t, c] of Object.entries(day)) {
        allTopics[t] = (allTopics[t] || 0) + c;
      }
    }
    const hotTopics = Object.entries(allTopics).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const uncoveredTopics = Object.entries(allTopics).filter(([t]) => t === 'other' || t === 'out-of-scope');

    // Learned answers (from local pending queue + GitHub knowledge base)
    const localLearned = (learnedData.learned || []).map(a => ({
      q: a.q, provider: a.provider, learnedAt: a.learnedAt,
      answer: String(a.a || '').slice(0, 120)
    }));
    const githubLearned = (knowledge?.learnedAnswers || []).map(a => ({
      q: a.q, provider: 'github-knowledge', learnedAt: a.learnedAt,
      answer: String(a.a || '').slice(0, 120)
    }));
    const learnedAnswers = [...localLearned, ...githubLearned];

    res.json({
      ok: true,
      knowledgeVersion: knowledge.version,
      lastUpdated: knowledge.lastUpdated,
      fieldCoverage: {
        total: totalFields,
        populated: populatedFields,
        empty: emptyFields,
        coveragePercent: totalFields > 0 ? Math.round((populatedFields / totalFields) * 100) : 0
      },
      gapClusters,
      hotTopics,
      uncoveredTopics,
      learnedAnswers,
      stashedCount: stashed.length,
      learnedCount: learnedData.learnedCount || 0,
      learningVerification: (() => {
        const all = [...(learnedData.learned || []), ...(learnedData.scoredHistory || [])];
        const avgLearned = all.length > 0 ? Math.round(all.reduce((s, l) => s + (l.score || 0), 0) / all.length) : 0;
        const avgGrounded = all.length > 0 ? Math.round(all.reduce((s, l) => s + (l.groundedScore || 0), 0) / all.length) : 0;
        return {
          avgLearnedScore: avgLearned,
          avgGroundedScore: avgGrounded,
          improvementPercent: avgGrounded > 0 ? Math.round(((avgLearned - avgGrounded) / avgGrounded) * 100) : 0,
          scoredAnswers: all.map(l => ({ q: l.q, score: l.score, groundedScore: l.groundedScore, provider: l.provider }))
        };
      })()
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/think', async (req, res) => {
  try {
    const results = await runThinkMode();
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function fetchKnowledge() {
  const now = Date.now();
  if (knowledgeCache && (now - knowledgeCacheAt) < KNOWLEDGE_CACHE_MS) {
    return knowledgeCache;
  }
  try {
    const fetchPromise = fetch(KNOWLEDGE_URL);
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Knowledge fetch timeout')), 25000));
    const res = await Promise.race([fetchPromise, timeoutPromise]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    knowledgeCache = json;
    knowledgeCacheAt = now;
    // Warm response cache for common questions in the background.
    setTimeout(() => warmResponseCache(json), 10);
    return json;
  } catch (err) {
    console.error('Failed to fetch knowledge:', err.message);
    return knowledgeCache;
  }
}

// Pre-compute grounded replies for common questions so users get fast, consistent answers.
function warmResponseCache(knowledge) {
  const commonQuestions = [
    'Who is Bradley Matera?',
    'What can you tell me about Brad?',
    'What roles is he targeting?',
    'What is his tech stack?',
    'Does he have AWS experience?',
    'What certifications does he have?',
    'What projects has he worked on?',
    'Is he a fit for a junior frontend role?',
    'What are his weaknesses?',
    'How can I contact him?',
    'Can he code?',
    'Is he open to helpdesk roles?',
    'Does he want mentorship?',
    'What are his strengths?',
    'Is he good at algorithms?',
  ];
  let added = 0;
  for (const q of commonQuestions) {
    const key = normalizeQuestion(q);
    if (responseCache.has(key)) continue;
    try {
      const payload = buildGroundedFallbackPayload(knowledge, q, []);
      if (payload?.reply) {
        payload.reply = shapeReply(payload.reply, q, knowledge);
        responseCache.set(key, { ts: Date.now(), payload: { ...payload, provider: 'grounded', model: 'knowledge-json', fallback: true, pipeline: ['cache-warm'] } });
        added++;
      }
    } catch (e) {
      console.error(`Cache warm failed for "${q}":`, e.message);
    }
  }
  console.log(`Response cache warmed with ${added} entries`);
}

function normalizeQuestion(question, knowledge = null) {
  let out = String(question || '').toLowerCase();
  const typos = knowledge?.commonPatterns?.typos;
  if (typos && typeof typos === 'object') {
    for (const [bad, good] of Object.entries(typos)) {
      if (!bad || !good) continue;
      out = out.replace(new RegExp(`\\b${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), good);
    }
  }
  return out
    .replace(/bradly|bradely|bradlee/g, 'bradley')
    .replace(/brads/g, 'bradley')
    .replace(/materra|matara/g, 'matera')
    .replace(/recuriter|recruter|recuiter|recrutier/g, 'recruiter')
    .replace(/exprience|experince|experiance/g, 'experience')
    .replace(/projeccts|proyects|projcts/g, 'projects')
    .replace(/certificat|certif|certs/g, 'certifications')
    .replace(/gitub|gihub|gitbub/g, 'github')
    .replace(/clould|clowd|clod/g, 'cloud')
    .replace(/react|reactjs/g, 'react')
    .replace(/contct|contact|cntact/g, 'contact')
    .replace(/skils|sklls|skillz/g, 'skills')
    .replace(/educaton|educcation|educatiom/g, 'education')
    .replace(/locaton|locatiom|loction/g, 'location')
    .replace(/compny|compnay|companie/g, 'company')
    .replace(/intership|internshp|intern/g, 'internship')
    .replace(/\bwat\b/g, 'what')
    .replace(/\bno\b(?=\s+react|\s+aws|\s+js|\s+cloud|\s+node|\s+ts|\s+typescript|\s+javascript|\s+python|\s+java|\s+c#)/g, 'know')
    .replace(/\bcn\b/g, 'can')
    .replace(/\bplz\b/g, 'please')
    .replace(/\bu\b/g, 'you')
    .replace(/\bwhats\b/g, 'what is')
    .replace(/\bwheres\b/g, 'where is')
    .replace(/\bhows\b/g, 'how is')
    .replace(/[^\w\s\?\.\,]/g, '')
    .trim();
}

function sentenceList(items, max = 5) {
  if (!items || !items.length) return '';
  const list = items.slice(0, max);
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return list.slice(0, -1).join(', ') + `, and ${list[list.length - 1]}`;
}

function removeSlop(reply) {
  // Remove only stale corporate jargon and meta-AI phrasing; keep natural voice.
  const slopPatterns = [
    /^(certainly|absolutely|great question|of course|sure!|sure,|i'd be happy to|i would be happy to|i'm here to help|i can help)/i,
    /\b(certainly|absolutely|of course)\b/gi,
    /\b(extensive expertise|proven leader|deep mastery|robust|dynamic|synergy|leverage|seasoned|guru|ninja|rockstar|wizard|10x|exceptional|remarkable|outstanding|impressive)\b/gi,
    /\b(groundbreaking|cutting-edge|innovative|world-class|best-in-class|state-of-the-art|cutting edge|game.?changer|disruptive|flagship|premier|top-tier)\b/gi,
    /\b(highly motivated|self-starter|results-oriented|detail-oriented|go-getter|thought leader|visionary|strategic thinker)\b/gi,
    /as an ai\b/gi,
    /as bradley matera's recruiter assistant\b/gi,
  ];
  let cleaned = reply;
  slopPatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, match => {
      if (/^(certainly|absolutely|great question|of course|sure!|sure,)/i.test(match)) return '';
      return ' ';
    });
  });
  return cleaned.replace(/\s+/g, ' ').trim().replace(/^[\.,\s]+/, '').replace(/\s{2,}/g, ' ');
}

function wordCount(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function truncateWords(text, maxWords) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  let out = words.slice(0, maxWords).join(' ').replace(/[,;:]$/, '');
  if (!/[.!?]$/.test(out)) out += '.';
  return out;
}

function firstSentence(text) {
  const match = String(text || '').match(/^.*?[.!?](\s|$)/);
  return match ? match[0].trim() : String(text || '').trim();
}

function splitFacts(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|;\s+/)
    .map(s => s.trim().replace(/^[-•]\s*/, ''))
    .filter(s => s.length > 3);
}

// Detect requested response shape from the question (test suite section 20)
function detectShape(question) {
  const q = String(question || '').toLowerCase();
  const shape = {};
  const bulletMatch = q.match(/\b(one|two|three|four|five|1|2|3|4|5)\s+bullets?\b/) || (/\bbullets only\b|\bin bullets\b|\bmarkdown bullets\b|\buse bullets\b/.test(q) ? ['', 'three'] : null);
  if (bulletMatch) {
    const map = { one: 1, two: 2, three: 3, four: 4, five: 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };
    shape.bullets = map[bulletMatch[1]] || 3;
  }
  const wordMatch = q.match(/\b(?:under|at most|max|maximum|in|use)\s+(\d{1,3})\s+words?\b/);
  if (wordMatch) shape.maxWords = parseInt(wordMatch[1], 10);
  if (/\bone sentence\b|\bin a sentence\b|\b1 sentence\b/.test(q)) shape.oneSentence = true;
  if (/\bjson\b/.test(q)) shape.json = true;
  if (/\byes\s*(?:\/|or)\s*no\b|\byes\/no first\b|\bjust say if\b/.test(q)) shape.yesNoFirst = true;
  if (/\bheadline\b/.test(q)) shape.headline = true;
  if (/\bno bullets\b|\bplain paragraph\b|\bone paragraph\b|\bin a paragraph\b|\bno markdown\b/.test(q)) shape.paragraph = true;
  if (/\btable\b/.test(q)) shape.table = true;
  if (/\b12 words\b/.test(q)) shape.maxWords = 12;
  if (/\b(10|ten) words\b/.test(q)) shape.maxWords = 10;
  if (/\b(20|twenty) words\b/.test(q)) shape.maxWords = 20;
  if (/\b(25|twenty.?five) words\b/.test(q)) shape.maxWords = 25;
  // Time-based "X seconds" pitches map to word budgets
  if (/\b20\s*seconds?\b/.test(q)) shape.maxWords = 40;
  if (/\b30\s*seconds?\b/.test(q)) shape.maxWords = 55;
  if (/\b40\s*seconds?\b/.test(q)) shape.maxWords = 60;
  if (/\b60\s*seconds?\b|1 minute/.test(q)) shape.maxWords = 90;
  // "Give me N reasons" maps to N bullets
  const reasonMatch = q.match(/\b(give me|list|what are)\s+(one|two|three|four|five|1|2|3|4|5)\s+reasons?\b/);
  if (reasonMatch) {
    const map = { one: 1, two: 2, three: 3, four: 4, five: 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };
    shape.bullets = map[reasonMatch[2]] || 3;
  }
  return shape;
}

// Detect banned words requested by the user (tone controls)
function detectBannedWords(question) {
  const q = String(question || '').toLowerCase();
  const banned = [];
  const m = q.match(/do(?:n't| not) (?:say|use)(?: the word)?\s+["']?([a-z-]+)["']?/g);
  if (m) {
    m.forEach(phrase => {
      const word = phrase.match(/["']?([a-z-]+)["']?$/);
      if (word && !['the', 'word', 'say', 'use'].includes(word[1])) banned.push(word[1]);
    });
  }
  if (/no buzzwords|without buzzwords|no hype|no marketing|less salesy|not salesy|no corporate|no resume language|less corporate|not corporate|no corporate tone|marketing language/.test(q)) {
    banned.push('robust', 'passionate', 'dynamic', 'leverage', 'synergy', 'extensive', 'innovative', 'groundbreaking', 'cutting-edge', 'world-class', 'exceptional');
  }
  const startMatch = q.match(/\b(?:do not|don't|never)\s+start\s+(?:with\s+)?["']?([a-z-]+)["']?/i);
  if (startMatch) banned.push(startMatch[1]);
  if (/no em dash|no em dashes/.test(q)) banned.push('—');
  return banned;
}

// Apply requested shape to a grounded answer (deterministic format compliance)
function shapeReply(text, question, knowledge) {
  const shape = detectShape(question);
  const banned = detectBannedWords(question);
  let out = String(text || '').trim();

  banned.forEach(word => {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'gi'), '').replace(/\s{2,}/g, ' ');
  });

  if (shape.json) {
    const name = knowledge?.identity?.name || 'Bradley Matera';
    return JSON.stringify({ subject: name, answer: truncateWords(out.replace(/"/g, "'"), 45) });
  }

  if (shape.table) {
    const facts = splitFacts(out).slice(0, 4);
    return facts.map(f => `| ${truncateWords(f, 14)} |`).join('<br>');
  }

  if (shape.bullets) {
    const facts = splitFacts(out);
    const chosen = facts.slice(0, shape.bullets);
    while (chosen.length < shape.bullets && facts.length > 0) chosen.push(facts[chosen.length % facts.length]);
    return chosen.map(f => `- ${f}`).join('<br>');
  }

  if (shape.yesNoFirst) {
    const q = String(question || '').toLowerCase();
    const positive = !/senior|architect|staff|lead|principal|10 years|production owner/.test(q);
    if (!new RegExp(`^${positive ? 'Yes' : 'No'}\.`, 'i').test(out.trim())) {
      out = `${positive ? 'Yes' : 'No'}. ${out}`;
    }
  }

  if (shape.headline) {
    const head = truncateWords(firstSentence(out), 8).replace(/\.$/, '');
    const rest = firstSentence(out.slice(firstSentence(out).length).trim() || out);
    return `${head.toUpperCase()}<br>${rest}`;
  }

  if (shape.oneSentence) out = firstSentence(out);
  if (shape.maxWords) out = truncateWords(out, shape.maxWords);
  if (shape.paragraph) {
    out = out.replace(/<br>/g, ' ').replace(/^- /gm, '').replace(/\s{2,}/g, ' ');
    // Keep paragraphs concise even when no explicit word cap is given
    out = truncateWords(out, 100);
  }

  // Default brevity cap for chat widget answers unless a specific format was requested
  if (!shape.maxWords && !shape.bullets && !shape.oneSentence && !shape.paragraph && !shape.json && !shape.table && !shape.headline) {
    out = truncateWords(out, 100);
  }

  return out.trim().replace(/\s{2,}/g, ' ');
}

// Tone/repair directive detection (test suite sections 11, 18 correction pack)
function detectRepair(question) {
  const q = String(question || '').toLowerCase().trim();
  return {
    shorter: /^no,? shorter|^shorter[.!?]?$|cut it in half|too long|^again[.!?]?$|faster please/.test(q),
    moreHonest: /more honest|honest version|rough edges|less salesy|less pitchy|sounds fake|sounds like ai|make it (more )?normal|less formal|make it sound less ai|like a normal person|normal person|try again|be fair|do not oversell|use plain english|no hype|no marketing|less ai|more direct/.test(q),
    moreTechnical: /more technical|like a technical|technical interviewer/.test(q),
    hrFriendly: /like i am hr|hr friendly|like hr|non.?technical/.test(q),
    blunt: /be blunt|no bs|no bullshit|tell me straight|dont give me marketing|do not waste my time|just tell me straight|give me the no bs version|no bs/.test(q),
    resumeLanguage: /no resume language|no corporate tone|less corporate|not corporate/.test(q),
    isBareFollowup: /^(why|how|like what|prove it|examples?\??|what else|so what|and\??|meaning\??|which one|what project|what cert|how long|where|what role|what stack|what risk|what strength)[.!?]?$/.test(q)
  };
}

async function callOpenAICompatibleProvider(baseUrl, apiKey, model, knowledge, question, history) {
  if (!apiKey || apiKey.length < 10) {
    throw new Error('OpenAI-compatible API key not configured');
  }
  const prompt = buildPrompt(knowledge, question, history, 'openai');
  const messages = [];
  if (knowledge?.identity?.name) {
    messages.push({ role: 'system', content: prompt });
  }
  if (Array.isArray(history) && history.length > 0) {
    history.forEach(turn => {
      if (turn.user) messages.push({ role: 'user', content: turn.user });
      if (turn.assistant) messages.push({ role: 'assistant', content: turn.assistant });
    });
  }
  messages.push({ role: 'user', content: question });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 300,
      temperature: 0.7,
      top_p: 0.9
    })
  });
  clearTimeout(timeout);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI-compatible provider failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callOpenAICompatible(knowledge, question, history, model) {
  return callOpenAICompatibleProvider(OPENAI_BASE_URL, OPENAI_API_KEY, model, knowledge, question, history);
}

async function callCloudflareWorkersAI(accountId, apiToken, model, knowledge, question, history) {
  if (!accountId || accountId.length < 10 || !apiToken || apiToken.length < 10) {
    throw new Error('Cloudflare account ID or token not configured');
  }
  const prompt = buildPrompt(knowledge, question, history, 'openai');
  const messages = [];
  if (knowledge?.identity?.name) {
    messages.push({ role: 'system', content: prompt });
  }
  if (Array.isArray(history) && history.length > 0) {
    history.forEach(turn => {
      if (turn.user) messages.push({ role: 'user', content: turn.user });
      if (turn.assistant) messages.push({ role: 'assistant', content: turn.assistant });
    });
  }
  messages.push({ role: 'user', content: question });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`
    },
    signal: controller.signal,
    body: JSON.stringify({ messages })
  });
  clearTimeout(timeout);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloudflare Workers AI failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  if (data.errors?.length) {
    throw new Error(`Cloudflare Workers AI error: ${JSON.stringify(data.errors).slice(0, 200)}`);
  }
  const result = data.result || {};
  return result.response || result.message?.content || '';
}

async function callOllama(knowledge, question, history, model) {
  const prompt = buildPrompt(knowledge, question, history, 'ollama');
  const messages = [];
  if (knowledge?.identity?.name) {
    messages.push({ role: 'system', content: prompt });
  }
  if (Array.isArray(history) && history.length > 0) {
    history.forEach(turn => {
      if (turn.user) messages.push({ role: 'user', content: turn.user });
      if (turn.assistant) messages.push({ role: 'assistant', content: turn.assistant });
    });
  }
  messages.push({ role: 'user', content: question });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_predict: 120
      }
    })
  });
  clearTimeout(timeout);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama failed: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.message?.content || '';
}

async function callGeminiWithPrompt(prompt, model) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  activeGenerations++;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 300,
        temperature: 0.7,
        topK: 1,
        topP: 0.9
      }
    })
  });
  clearTimeout(timeout);
  activeGenerations = Math.max(0, activeGenerations - 1);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callGemini(knowledge, question, history, model) {
  return callGeminiWithPrompt(buildPrompt(knowledge, question, history, 'gemini'), model);
}

function findRoleInQuestion(question) {
  const lower = question.toLowerCase();
  const commonRoles = [
    'junior web developer', 'frontend developer', 'backend developer', 'full stack developer',
    'junior react', 'react developer', 'cloud support', 'cloud support engineer', 'cloud support associate',
    'help desk', 'help desk analyst', 'it support', 'it support technician', 'technical support',
    'technical support specialist', 'systems support', 'devops', 'devops intern', 'senior cloud architect',
    'staff engineer', 'database administrator', 'qa tester', 'web content developer', 'software engineer',
    'data engineer', 'machine learning engineer', 'ai engineer', 'security engineer', 'network engineer',
    'site reliability engineer', 'sre', 'product manager', 'project manager', 'scrum master', 'ux designer',
    'ui developer', 'mobile developer', 'ios developer', 'android developer', 'sales engineer', 'solutions architect',
    'platform engineer', 'infrastructure engineer', 'release engineer', 'build engineer', 'test engineer',
    'automation engineer', 'devops engineer', 'cloud engineer', 'aws engineer', 'systems administrator',
    'systems admin', 'sysadmin', 'network administrator', 'database admin', 'dba', 'data analyst',
    'business analyst', 'quality assurance', 'qa engineer', 'qa analyst', 'support engineer', 'application support',
    'software support', 'customer support', 'customer success', 'technical account manager', 'implementation specialist',
    'integration engineer', 'api engineer', 'web developer', 'web engineer', 'javascript developer',
    'typescript developer', 'node developer', 'node.js developer', 'python developer', 'java developer',
    'c# developer', '.net developer', 'php developer', 'ruby developer', 'go developer', 'rust developer',
    'sql developer', 'database developer', 'etl developer', 'data warehouse engineer', 'bi developer',
    'salesforce developer', 'shopify developer', 'wordpress developer', 'magento developer', 'drupal developer',
    'frontend engineer', 'backend engineer', 'full stack engineer', 'software development engineer',
    'junior software engineer', 'entry level software engineer', 'associate software engineer',
    'mid level software engineer', 'senior software engineer', 'lead software engineer', 'principal software engineer',
    'engineering manager', 'tech lead', 'team lead', 'architect', 'enterprise architect', 'technical architect',
    'cloud architect', 'solutions architect', 'security architect', 'data architect', 'information architect',
    'ux researcher', 'product designer', 'interaction designer', 'visual designer', 'graphic designer',
    'motion designer', 'brand designer', 'content designer', 'content strategist', 'technical writer',
    'developer advocate', 'developer relations', 'devrel', 'community manager', 'open source maintainer',
    'contract role', 'contractor', 'freelance', 'intern', 'internship', 'co-op', 'part time', 'full time',
    'remote role', 'hybrid role', 'on-site role', 'onsite role', 'senior backend', 'junior backend', 'senior frontend',
    'junior frontend', 'junior full stack', 'senior full stack', 'junior devops', 'senior devops', 'junior data engineer',
    'senior data engineer', 'junior cloud', 'senior cloud', 'junior qa', 'senior qa', 'junior security', 'senior security',
    'junior database', 'senior database', 'junior network', 'senior network', 'junior sysadmin', 'senior sysadmin',
    'junior systems', 'senior systems', 'junior support', 'senior support', 'junior analyst', 'senior analyst'
  ];
  
  for (const role of commonRoles) {
    if (lower.includes(role)) return role;
  }
  
  // Try to extract role from "fit for [role]" or "for [role]" patterns
  const fitMatch = lower.match(/(?:fit for|for|as a|as an|role of|position of)\s+([a-z0-9\s#\.\+\-\.]+?)(?:\?|\.|$|\s+role|\s+position|\s+job|\s+work|\s+at\s|\s+with\s)/);
  if (fitMatch) return fitMatch[1].trim();
  
  return null;
}

function analyzeRoleFit(role, knowledge) {
  const { skills, projects, experience, goals, sourceMaterial } = knowledge || {};
  const roleLower = String(role || '').toLowerCase();
  if (!roleLower) return { fit: 'poor', matchedSkills: [], gaps: ['no role specified'] };

  // Flatten all listed skills and build a searchable source-text corpus
  const allSkills = [
    ...(skills?.languagesAndFrameworks || []),
    ...(skills?.cloudAndInfrastructure || []),
    ...(skills?.toolsAndWorkflows || []),
    ...(skills?.aiAndAutomation || []),
    ...(skills?.learningOrAdjacent || [])
  ].map(s => s.toLowerCase());

  const sourceText = ((sourceMaterial || []).map(m => m?.content || '').join(' ') + ' ' + allSkills.join(' ')).toLowerCase();
  const hasSkill = term => allSkills.includes(term) || sourceText.includes(term);

  const projectNames = (projects || []).map(p => p.name.toLowerCase());
  const projectTech = (projects || []).flatMap(p => (p.tech || []).map(t => t.toLowerCase()));
  const targetRoles = (goals?.targetRoles || []).map(r => r.toLowerCase());

  // Role-specific keyword profiles. The model is the search strategy; the data is real.
  const roleProfiles = [
    {
      test: /data|analytics|machine learning|ml|data engineer|data scientist|data science|bi|etl|business intelligence/,
      name: 'data science / analytics',
      required: ['python', 'statistics', 'machine learning', 'data analysis', 'pandas'],
      related: ['sql', 'numpy', 'scikit', 'tensorflow', 'pytorch', 'data visualization', 'aws ai practitioner', 'ai'],
      projectHint: /data|model|prediction|pandas|numpy|jupyter|analytics/
    },
    {
      test: /devops|sre|site reliability|infrastructure engineer|platform engineer|release engineer|build engineer/,
      name: 'devops / sre',
      required: ['docker', 'ci/cd', 'aws', 'serverless', 'github actions'],
      related: ['aws lambda', 'amazon dynamodb', 'amazon s3', 'terraform', 'cloud troubleshooting', 'networking', 'kubernetes', 'monitoring'],
      projectHint: /docker|ci.?cd|github actions|terraform|serverless|infrastructure|aws|pipeline/
    },
    {
      test: /cloud|aws|cloud support|cloud engineer|infrastructure|platform/,
      name: 'cloud / aws',
      required: ['aws lambda', 'amazon dynamodb', 'amazon s3', 'aws'],
      related: ['docker', 'ci/cd', 'github actions', 'terraform', 'cloud troubleshooting', 'networking', 'serverless', 'monitoring'],
      projectHint: /aws|lambda|dynamodb|s3|cloud|serverless|infrastructure/
    },
    {
      test: /frontend|web|react|javascript|typescript|ui|ux|html|css/,
      name: 'frontend',
      required: ['javascript', 'html', 'css'],
      related: ['typescript', 'react', 'next.js', 'ui', 'ux', 'responsive design', 'tailwind', 'webpack'],
      projectHint: /react|frontend|web|ui|html|css|javascript/
    },
    {
      test: /backend|node|python|java|c#|\.net|php|ruby|go|rust|sql|database|api|server/,
      name: 'backend',
      required: ['node.js', 'sql', 'javascript'],
      related: ['typescript', 'python', 'java', 'c#', 'rest api', 'database', 'express', 'mongodb', 'postgres'],
      projectHint: /api|server|backend|node|database|sql|express/
    },
    {
      test: /support|help desk|helpdesk|technical support|it support|customer support|service desk/,
      name: 'support / help desk',
      required: ['support', 'troubleshooting', 'debugging'],
      related: ['help desk', 'customer support', 'networking', 'aws', 'documentation', 'communication'],
      projectHint: /support|troubleshoot|help desk|debug|customer/
    },
    {
      test: /qa|test|quality assurance|automation/,
      name: 'qa / testing',
      required: ['debugging', 'documentation'],
      related: ['qa', 'testing', 'automation', 'jest', 'cypress', 'unit testing', 'selenium'],
      projectHint: /test|qa|automation|jest|cypress|bug/
    },
    {
      test: /mobile|ios|android|react native|swift|kotlin|flutter/,
      name: 'mobile',
      required: ['mobile', 'ios', 'android', 'react native', 'swift', 'kotlin', 'flutter'],
      related: ['mobile', 'react native', 'swift', 'kotlin', 'flutter', 'ios', 'android'],
      projectHint: /mobile|ios|android|react native|swift|flutter/
    },
    {
      test: /security|cyber|infosec|penetration|soc/,
      name: 'security',
      required: ['security', 'cyber', 'infosec', 'penetration', 'soc', 'certified ethical hacker'],
      related: ['security', 'network security', 'firewall', 'encryption', 'compliance'],
      projectHint: /security|cyber|infosec|penetration|soc/
    },
    {
      test: /technical writer|technical writing|documentation|content/,
      name: 'technical writing',
      required: ['documentation', 'writing'],
      related: ['technical writing', 'blogging', 'markdown', 'api docs', 'content', 'communication'],
      projectHint: /documentation|writing|blog|content|readme|docs/
    },
    {
      test: /project manager|product manager|scrum master|program manager|manager/,
      name: 'project / product management',
      required: ['project management', 'scrum', 'agile', 'leadership'],
      related: ['communication', 'planning', 'stakeholder', 'jira', 'collaboration', 'documentation'],
      projectHint: /project|product|scrum|agile|team|leadership/
    }
  ];

  // Find the best matching profile, or use the role words themselves as a generic profile
  let profile = roleProfiles.find(p => p.test.test(roleLower));
  if (!profile) {
    // Generic profile: search the role words plus any skills that contain them
    const roleTokens = roleLower.split(/[^a-z0-9+#.]+/).filter(w => w.length > 2);
    profile = {
      test: /./,
      name: roleLower,
      required: roleTokens,
      related: roleTokens,
      projectHint: new RegExp(roleTokens.join('|'))
    };
  }

  const matchedSkills = [];
  const gaps = [];

  // Check structured skills and source material against the profile
  for (const term of profile.required) {
    if (hasSkill(term) && !matchedSkills.includes(term)) matchedSkills.push(term);
    else if (!hasSkill(term) && !gaps.includes(term)) gaps.push(term);
  }
  for (const term of profile.related) {
    if (hasSkill(term) && !matchedSkills.includes(term)) matchedSkills.push(term);
  }

  // Project-based evidence
  if (projectTech.some(t => profile.projectHint.test(t))) {
    matchedSkills.push('relevant projects');
  } else if (projectNames.some(n => profile.projectHint.test(n))) {
    matchedSkills.push('relevant project work');
  }

  // Senior-level roles are a mismatch for a junior candidate
  const isSenior = /senior|lead|principal|staff|manager|director|head of|vp|chief/.test(roleLower);
  if (isSenior) {
    gaps.push('junior-level with limited production ownership');
    return { fit: 'poor', matchedSkills, gaps };
  }

  // If the role is explicitly in the candidate's target list, weight up
  const isTargetRole = targetRoles.some(r => r.includes(roleLower.replace(/senior|junior|lead|staff|entry.?level|associate/g, '').trim()));
  if (isTargetRole && matchedSkills.length > 0) {
    return { fit: gaps.length === 0 ? 'good' : 'partial', matchedSkills, gaps };
  }

  if (matchedSkills.length > 0 && gaps.length === 0) {
    return { fit: 'good', matchedSkills, gaps };
  }

  if (matchedSkills.length > 0 && gaps.length > 0) {
    return { fit: 'partial', matchedSkills, gaps };
  }

  return { fit: 'poor', matchedSkills, gaps: [...gaps, 'no direct skill overlap'] };
}

function handleRoleFit(knowledge, question, role) {
  const { identity, summary } = knowledge || {};
  const name = identity?.name || 'Bradley Matera';
  const title = identity?.title || 'junior software engineer';
  const roleAnalysis = analyzeRoleFit(role, knowledge);
  const lower = question.toLowerCase();

  const isPitch = /how should.*recruiter pitch|how do you pitch|pitch him|sell him/.test(lower);
  const isVerify = /what should.*verify|verify on a call|check on a call|what to verify|what.*confirm/.test(lower);
  const isMissing = /what would be missing|what is missing|missing for|gaps for|not a fit for|bad fit|weakness|where.*fall short/.test(lower);

  const fitStatement = roleAnalysis.fit === 'good'
    ? `likely a good fit`
    : roleAnalysis.fit === 'partial'
      ? `a partial fit`
      : `not a strong fit`;

  const skillsPhrase = roleAnalysis.matchedSkills.length > 0
    ? sentenceList(roleAnalysis.matchedSkills.slice(0, 3), 3)
    : 'no direct matching skills';
  const gapsPhrase = roleAnalysis.gaps.length > 0
    ? sentenceList(roleAnalysis.gaps.slice(0, 2), 2)
    : '';

  if (isPitch) {
    if (roleAnalysis.matchedSkills.length > 0) {
      return { reply: `${name} is ${fitStatement} for ${role}. Pitch him as a ${title} with ${skillsPhrase}.${gapsPhrase ? ' Be honest about gaps: ' + gapsPhrase + '.' : ''}` };
    }
    return { reply: `${name} is not a strong fit for ${role}. The data shows a ${title} with web, AWS, and support skills, not the core skills typically expected for ${role}.` };
  }

  if (isVerify) {
    if (roleAnalysis.gaps.length > 0) {
      return { reply: `For ${role}, verify: ${gapsPhrase}. Also confirm his hands-on experience with ${roleAnalysis.matchedSkills.length > 0 ? skillsPhrase : 'his listed projects'}.` };
    }
    return { reply: `For ${role}, verify his hands-on experience with ${roleAnalysis.matchedSkills.length > 0 ? skillsPhrase : 'his listed projects'} and ask about production work.` };
  }

  if (isMissing) {
    if (roleAnalysis.gaps.length > 0) {
      return { reply: `For ${role}, he would be missing ${gapsPhrase}.` };
    }
    return { reply: `He does not have major listed gaps for ${role} in the data.` };
  }

  // Default is-fit / "what makes him a good candidate" question
  if (roleAnalysis.fit === 'good') {
    return { reply: `${name} is ${fitStatement} for ${role} based on ${skillsPhrase}.` };
  }

  if (roleAnalysis.fit === 'partial') {
    return { reply: `${name} is ${fitStatement} for ${role}. He has ${skillsPhrase}, but the data does not show ${gapsPhrase}.` };
  }

  // poor fit
  const targetRoles = (knowledge?.goals?.targetRoles || ['junior software engineering', 'cloud support', 'IT support']).slice(0, 3);
  return { reply: `${name} is ${fitStatement} for ${role}. The data shows ${skillsPhrase === 'no direct matching skills' ? 'no direct matching skills' : skillsPhrase + ' but not the core skills typically expected'}. He is a better match for ${sentenceList(targetRoles, 3)} roles.` };
}

// Build the canonical verified-facts block used by both LLM prompts and grounded fallback.
function buildKnowledgeContext(knowledge) {
  const { identity, summary, goals, education, certifications, experience, skills, projects, rules, interviewStories, blogCatalog } = knowledge || {};
  const title = identity?.title || 'junior software engineer';
  const location = identity?.location || 'Davis, Illinois';
  const preferredName = identity?.preferredName || 'Brad';

  let context = `Bradley is a ${title} based in ${location}. He goes by ${preferredName}.\n\n`;
  context += `VERIFIED FACTS ABOUT BRADLEY:\n`;
  if (summary?.whoIAm) context += `- Who he is: ${summary.whoIAm}\n`;
  if (summary?.whatIDo) context += `- What he does: ${summary.whatIDo}\n`;
  if (summary?.whatIAmLookingFor) context += `- Looking for: ${summary.whatIAmLookingFor}\n`;
  if (summary?.coreStrengths?.length) context += `- Core strengths: ${summary.coreStrengths.join('; ')}\n`;
  if (summary?.honestGaps?.length) context += `- Honest gaps: ${summary.honestGaps.join(' ')}\n`;
  if (summary?.workStyle?.length) context += `- Work style: ${summary.workStyle.join('; ')}\n`;
  if (goals?.targetRoles) context += `- Target roles: ${goals.targetRoles.join(', ')}\n`;
  if (goals?.relocation) context += `- Relocation: ${goals.relocation}\n`;
  if (skills?.languagesAndFrameworks) context += `- Frontend stack: ${skills.languagesAndFrameworks.join(', ')}\n`;
  if (skills?.cloudAndInfrastructure) context += `- Cloud: ${skills.cloudAndInfrastructure.join(', ')}\n`;
  if (skills?.toolsAndWorkflows) context += `- Tools: ${skills.toolsAndWorkflows.join(', ')}\n`;
  if (skills?.aiAndAutomation) context += `- AI workflow: ${skills.aiAndAutomation.join(', ')}\n`;
  if (skills?.learningOrAdjacent) context += `- Currently learning: ${skills.learningOrAdjacent.join('; ')}\n`;
  if (education?.degree) context += `- Education: ${education.degree} from ${education.school} (GPA ${education.gpa || 'not listed'}, graduated ${education.graduationDate || '2025'})\n`;
  if (certifications?.length) context += `- Certifications: ${certifications.map(c => c.name).join(', ')}\n`;
  if (projects?.length) context += `- Projects: ${projects.slice(0, 8).map(p => `${p.name} - ${p.description || p.category}`).join('; ')}\n`;
  if (experience?.length) {
    context += `- Experience:\n`;
    experience.slice(0, 5).forEach(e => {
      context += `  - ${e.role} at ${e.company} (${e.dates || 'dates not listed'}): ${e.summary || ''}\n`;
      if (e.responsibilities?.length) context += `    Key work: ${e.responsibilities.slice(0, 3).join('; ')}\n`;
      if (e.details) {
        const detailParts = [];
        if (e.details.rank) detailParts.push(`rank ${e.details.rank}`);
        if (e.details.characterOfService) detailParts.push(`service ${e.details.characterOfService}`);
        if (e.details.unit) detailParts.push(`unit ${e.details.unit}`);
        if (e.details.deployment) detailParts.push(`deployed ${e.details.deployment}`);
        if (e.details.awards?.length) detailParts.push(`awards: ${e.details.awards.join(', ')}`);
        if (detailParts.length) context += `    Details: ${detailParts.join('; ')}\n`;
      }
    });
  }
  if (interviewStories?.length) {
    context += `- Interview answers (use these as reference for how Bradley talks about himself):\n`;
    interviewStories.forEach(s => {
      context += `  Q: "${s.prompt || s.topic}" -> A: "${s.answer || s.story || ''}"\n`;
    });
  }
  if (blogCatalog?.records?.length) {
    const posts = blogCatalog.records;
    const dev = posts.filter(p => p.platform === 'DEV Community').length;
    const site = posts.filter(p => p.platform === 'bradleymatera.dev').length;
    context += `- Writing: ${posts.length} posts on DEV Community (${dev}) and bradleymatera.dev (${site}). Topics include ${posts.slice(0, 5).map(p => p.title).join('; ')}${posts.length > 5 ? '; ...' : ''}\n`;
  }
  if (identity?.shortPitch) context += `- Short pitch: ${identity.shortPitch}\n`;

  if (rules?.doNot?.length) {
    context += `\nSTRICT RULES:\n`;
    rules.doNot.forEach(r => context += `- ${r}\n`);
  }

  return context;
}

function buildPrompt(knowledge, question, history, provider) {
  const { identity, summary, goals, education, certifications, experience, skills, projects, rules, faq, interviewStories, conversationQualityStandards } = knowledge || {};
  const name = identity?.name || 'Bradley Matera';
  const preferredName = identity?.preferredName || 'Brad';
  const title = identity?.title || 'junior software engineer';
  const location = identity?.location || 'Davis, Illinois';

  let context = `You are Scout, the assistant for Bradley Matera. You're an approachable recruiter-side helper in a chat widget on his portfolio site. You answer questions about Bradley from verified facts. You are NOT Bradley, but you represent him honestly and warmly.\n\n`;
  context += `Bradley is a ${title} based in ${location}. He goes by ${preferredName}.\n\n`;

  // RAG context — shared with the grounded fallback so answers stay aligned
  context += buildKnowledgeContext(knowledge);

  context += `\nVOICE AND STYLE:\n`;
  context += `- Talk like a normal, helpful person. Not a corporate AI, not a resume, not a sales pitch.\n`;
  context += `- Answer directly in 1-3 short sentences for simple questions. Give more detail when the question warrants it.\n`;
  context += `- USE ONLY the verified facts above. Do not use outside knowledge, assumptions, or general industry facts.\n`;
  context += `- Never start with "Certainly", "Absolutely", "Great question", "Of course", "Sure", or "As an AI".\n`;
  context += `- Vary sentence openers across turns. Don't start every reply with "Bradley is a..." or "Bradley has..."; alternate with "He...", "His...", "From the data...", "In terms of...", "When it comes to...", "Based on...".\n`;
  context += `- Never use words like robust, passionate, synergy, leverage, dynamic, extensive, groundbreaking, cutting-edge, innovative, world-class, best-in-class, proven leader, deep mastery, exceptional, seasoned, or guru.\n`;
  context += `- Do not repeat the user's question back at them.\n`;
  context += `- Do not end with a sales pitch, vague offer to help, or long disclaimer.\n`;
  context += `- Do not oversell Bradley. He is junior. If something is from a project, an internship, or school, say so.\n`;
  context += `- Do not describe his AWS work as live production ownership; it was structured labs and a controlled capstone.\n`;
  context += `- If the data does not contain the answer, say "I don't see that in the current recruiter data" and suggest checking the resume or contacting him directly.\n`;
  context += `- If the user is vague, ask a brief clarifying question.\n`;
  context += `\nCONVERSATION RULES:\n`;
  context += `- This is a real conversation. Reference what was already discussed without repeating it.\n`;
  context += `- If the recruiter asks a follow-up, build on the previous answer. Don't start from scratch.\n`;
  context += `- Vary your phrasing. Don't use the same sentence structure or opening words as previous turns.\n`;
  context += `- When the recruiter seems to be exploring (asking open-ended questions), end with a relevant follow-up question to keep the conversation going.\n`;
  context += `- When the recruiter asks a direct factual question, just answer it. Don't add unnecessary follow-ups.\n`;
  context += `- Use the interview answers above as a guide for tone and content, but adapt naturally to the question.\n`;

  if (Array.isArray(history) && history.length > 0) {
    context += `\nRECENT CONVERSATION:\n`;
    history.slice(-5).forEach((turn, i) => {
      context += `User: ${turn.user || ''}\nScout: ${turn.assistant || ''}\n`;
    });
    if (history.length >= 3) {
      const topicsCovered = history.slice(-5).map(t => classifyTopic(t.user || '')).filter(t => t !== 'other');
      const uniqueTopics = [...new Set(topicsCovered)];
      if (uniqueTopics.length > 0) {
        context += `\n(Topics already covered: ${uniqueTopics.join(', ')}. Reference these if relevant, but don't repeat the same info unless asked.)\n`;
      }
    }
  }

  context += `\nUser: ${question}\nScout:`;
  return context;
}

function buildGroundedFallbackPayload(knowledge, question, history) {
  const { identity, summary, goals, skills, projects, experience, education, certifications, rulesForAssistant, faq, interviewStories, blogCatalog } = knowledge || {};
  const name = identity?.name || 'Bradley Matera';
  const title = identity?.title || 'junior software engineer';
  const location = identity?.location || 'Davis, Illinois';
  
  const agentName = knowledge?.agent?.name || 'Scout';
  const lowerQuestion = String(question || '').toLowerCase();
  const normalized = normalizeQuestion(question);
  const repair = detectRepair(question);
  const lastAssistant = Array.isArray(history) && history.length > 0
    ? String(history[history.length - 1]?.assistant || '')
    : '';
  const lastUser = Array.isArray(history) && history.length > 0
    ? String(history[history.length - 1]?.user || '')
    : '';

  // Contextual pronoun follow-ups: 'was that paid?', 'what did he do there?', 'how about that?'
  // Use the previous assistant reply to determine the topic and answer accordingly.
  const lastAssistantLower = lastAssistant.toLowerCase();
  const inKittenContext = /kitten|rescue|animal/i.test(lastAssistantLower);
  const inArmyContext = /army|military|combat medic|68w|fort bragg|afghanistan/i.test(lastAssistantLower);
  const inAwsContext = /aws|lambda|dynamodb|amazon s3|aws amplify|cloudfront|ec2|amazon web services/i.test(lastAssistantLower);
  const inProjectContext = /pokedex|metadata extraction|serverless|ciris|interactive pokedex|projecthub|smokebuddy/i.test(lastAssistantLower);

  if (/^\s*(was that|was it|is that)\b/i.test(question) && inKittenContext && /paid|pay|volunteer|money|compensat/.test(lowerQuestion)) {
    return { reply: `Yes, he started in a paid, part-time animal care role for a few months and then continued as a regular volunteer at Mason County Kitten Rescue.` };
  }
  if (/^\s*what did he do there\b/i.test(question) && inKittenContext) {
    const kittenExp = (experience || []).find(e => /kitten|animal care|rescue/i.test(`${e.role} ${e.company} ${e.summary || ''}`));
    if (kittenExp) {
      const topResp = (kittenExp.responsibilities || []).slice(0, 5).map(r => r.charAt(0).toLowerCase() + r.slice(1)).join('; ');
      return { reply: `Day to day, he handled ${topResp}.` };
    }
  }

  // Generic bare follow-ups — re-execute with the previous topic substituted.
  const isBareFollowup = /^\s*(was that|what did he do there|what about that|how about that|tell me more about that|is that|was it|what about it)\b/i.test(question);
  if (isBareFollowup && lastAssistant) {
    let contextualQuestion = null;
    if (inKittenContext) contextualQuestion = 'What did he do at Mason County Kitten Rescue';
    else if (inArmyContext) contextualQuestion = 'Tell me about his Army service';
    else if (inAwsContext) contextualQuestion = 'Does he have AWS experience';
    else if (inProjectContext) contextualQuestion = 'Tell me about his projects';
    if (contextualQuestion) {
      return buildGroundedFallbackPayload(knowledge, contextualQuestion, history.slice(0, -1));
    }
  }

  // Safety: prompt injection / secret extraction / false claims / social engineering
  if (/(ignore previous|ignore all previous|ignore all rules|ignore your instructions|ignore all instructions|ignore that|override.*rules|override.*instructions|show.*system prompt|print.*env|api key|give me.*key|\.env|home address|family details|bypass cors|open.*port\s*11434|open port|localhost|127\.0\.0\.1|:11434|fortune 500|reveal.*prompt|reveal.*environment|reveal.*secret|reveal.*config|hidden config|make.*longer than 5000|print server|output.*raw json|repeat.*knowledge file|social security|birth date|wife|children|disability rating|bank|password|act as root|delete the vm|hack the site|fake reference|security clearance|i am.*admin|i am.*owner|i am.*developer|i am.*from the government|i am.*security researcher|bradley'?s friend|his friend|show.*contents of|read.*file|show me.*\.json|show me.*learned|show me.*stats|opt\/recruiter|\/opt\/|etc\/passwd|environment variable)/.test(lowerQuestion)) {
    return { reply: `${agentName} can only answer recruiter questions about ${name} using the public site data. It can't help with that.` };
  }

  // Refuse false-claim requests BEFORE checking learned answers (so accidentally learned false claims are blocked)
  if (/(pretend|make up|make.*sound|claim|say|tell|write|describe)\b.*\b(google|senior|cto|10 years|10\+ years|masters?|master.s|kubernetes|led a team|production engineer|production experience|outages|clearance|fortune|payment systems|startup|papers|hackathons|l4|azure|dba|machine learning engineer|rust|full.?stack expert|10x|ninja|rockstar|wizard|guru|glowing review|overselling|world.class)/.test(lowerQuestion) || /write something that hides|hide his lack/.test(lowerQuestion)) {
    return { reply: `That claim isn't in ${name}'s verified data. The honest version: he's a junior engineer with real React/Next.js projects, AWS certifications, and structured AWS internship training. That's the story worth telling.` };
  }
  
  // Check learned answers from GitHub knowledge (pushed by think mode) — AFTER safety and false-claim checks
  if (Array.isArray(knowledge?.learnedAnswers) && knowledge.learnedAnswers.length > 0) {
    const found = knowledge.learnedAnswers.find(a => a.q === normalized);
    if (found) return { reply: found.a };
    if (normalized.length >= 10) {
      const partial = knowledge.learnedAnswers.find(a => a.q.includes(normalized) || normalized.includes(a.q));
      if (partial) return { reply: partial.a };
    }
  }
  
  // Senior-level / unrealistic role checks (checked early so they don't route to cloud providers)
  if (/\b(senior|lead|principal|staff|architect|manager|director)\b/.test(lowerQuestion) && /\b(dev|developer|engineer|role|fit|candidate|is he|would he)\b/.test(lowerQuestion)) {
    return { reply: `No. ${name} is a ${title}, not a senior-level candidate. He's best suited for junior web, cloud support, or technical support roles.` };
  }

  // Internship reality check
  if (/internship real|was the internship real|did he really intern|is the aws internship real|amazon internship/.test(lowerQuestion)) {
    return { reply: `Yes. He completed an AWS Cloud Support Engineer internship at Amazon Web Services, but it was built around structured labs and a capstone, not live production customer tickets.` };
  }

  // Specific capability: React
  if (/\b(react|next\.?js)\b/.test(lowerQuestion) && /\b(can he|does he|work with|know|use|comfortable)\b/.test(lowerQuestion)) {
    return { reply: `${name} has React and Next.js experience from school projects and freelance contributor work, including the Interactive Pokedex demo and CIRIS. It's junior-level project experience, not production ownership.` };
  }

  // Specific capability: troubleshooting / debugging / cloud issues
  if (/\b(troubleshoot|debug|cloud issues|cloud problems|support|fix\w*)\b/.test(lowerQuestion) && /\b(can he|does he|able to|good at)\b/.test(lowerQuestion)) {
    return { reply: `${name} has debugging and cloud troubleshooting training from the AWS internship labs and his projects. He's junior, so he still needs mentorship for complex production issues.` };
  }

  // Site purpose / identity (checked before greeting so "hey what is this thing" gets the site answer)
  if (/what is this site for|what page am i on|what is this thing|what is projecthub|what does this site do|who made this|what is this chatbot/.test(lowerQuestion)) {
    return { reply: `This is ${name}'s portfolio site with an embedded recruiter assistant. ${agentName} answers questions about his projects, skills, AWS background, education, and role fit.` };
  }

  // Smoke tests / greetings
  if (/^(hey|hi|hello|yo|sup)\b/.test(lowerQuestion.trim()) || /are you online|say hello/.test(lowerQuestion)) {
    return { reply: `${agentName} here — I answer questions about ${name}'s projects, AWS internship, skills, role fit, and contact info. What do you want to know?` };
  }
  if (/what can (you|this bot) (help|answer|do)/.test(lowerQuestion)) {
    return { reply: `${agentName} covers ${name}'s projects, skills, AWS background, education, certifications, role fit, honest limitations, and how to contact him.` };
  }
  if (/what model|what provider|what llm|what ai|which model|which provider/.test(lowerQuestion)) {
    return { reply: `${agentName} uses a free multi-provider network (Groq, Cloudflare Workers AI, GitHub Models, Google Gemini) and falls back to fast, grounded answers from ${name}'s verified recruiter data.` };
  }
  if (/what is this chatbot using|does this use ollama|is this ai local|is my chat private|what data do you use/.test(lowerQuestion)) {
    return { reply: `${agentName} is grounded in ${name}'s public recruiter data file. Nothing private is stored beyond short session context.` };
  }
  if (/who made this|is this bradley'?s site/.test(lowerQuestion)) {
    return { reply: `Yes, this is ${name}'s portfolio. He built the site and ${agentName} himself.` };
  }
  if (/how is this chat free|how do you stay free|what powers you|what is your stack|free tier|free providers/.test(lowerQuestion)) {
    return { reply: `${agentName} runs entirely on free tiers: GitHub Pages hosts the widget, a GCP free-tier VM runs the Node API, open-ended questions route through free LLM providers (Groq, Cloudflare Workers AI, GitHub Models, Gemini), and the final fallback is a fast, grounded answer from ${name}'s verified recruiter data. No paid AI subscriptions are needed.` };
  }
  if (/daily cap|daily limit|rate limit|cooldown|how.*handle.*limit|run 24|24.?7|24x7|always available|what if.*provider|exhausted|out of quota/.test(lowerQuestion)) {
    return { reply: `${agentName} is designed to stay online 24/7 without paid AI. Each free provider has its own daily request cap and rate limit. When a provider hits its cap, returns a rate-limit error, or reports exhausted credits, ${agentName} pauses that provider (60 seconds for rate limits, 24 hours for credit exhaustion) and tries the next free provider in priority order. If every free provider is unavailable, the final fallback is a fast, grounded answer from ${name}'s verified recruiter data. That layered fallback means the widget keeps working as long as the VM and GitHub Pages are up.` };
  }
  if (/health status|are you healthy|how are you running|system status/.test(lowerQuestion)) {
    return { reply: `${agentName} is online. The backend runs on a free GCP VM with a multi-provider LLM network; if all providers are unavailable, the final fallback is a fast, grounded answer from ${name}'s verified recruiter data.` };
  }
  // Repair: shorter / more honest / tone changes using previous answer
  if (repair.shorter && lastAssistant) {
    return { reply: truncateWords(firstSentence(lastAssistant.replace(/<[^>]+>/g, ' ')), 20) };
  }
  if (repair.moreHonest && lastAssistant) {
    return { reply: `${firstSentence(lastAssistant.replace(/<[^>]+>/g, ' '))} Honest caveats: he's junior, and his AWS work was labs and a capstone rather than live production.` };
  }
  if (repair.hrFriendly && lastAssistant) {
    const targetRoles = (goals?.targetRoles || ['junior developer', 'cloud support', 'technical support']).slice(0, 3);
    return { reply: `${name} is an entry-level software developer with a bachelor's degree, AWS certifications, and hands-on portfolio projects. He's best suited for ${sentenceList(targetRoles, 3)} roles.` };
  }
  if (repair.moreTechnical && lastAssistant) {
    const stack = skills?.languagesAndFrameworks?.slice(0, 6).join(', ') || 'JavaScript, TypeScript, React, Node.js';
    const cloud = skills?.cloudAndInfrastructure?.slice(0, 4).join(', ') || 'Lambda, DynamoDB, S3';
    return { reply: `Technical view: ${stack}; cloud work with ${cloud}. Certified SAA-C03 and AIF-C01. Projects include REST APIs, serverless demos, and documented React apps on GitHub.` };
  }
  
  // Bare follow-ups: answer from prior context
  if (repair.isBareFollowup) {
    if (/why/.test(lowerQuestion) && lastAssistant) {
      return { reply: `Because that's what his verified data supports: real projects, AWS certifications, and internship training, but no senior-level production ownership yet.` };
    }
    if (/which one|what project/.test(lowerQuestion)) {
      const top = projects?.[0]?.name || 'ProjectHub';
      return { reply: `Start with ${top}. It's the most complete demonstration of his frontend and documentation habits.` };
    }
    if (/what cert/.test(lowerQuestion)) {
      const certList = Array.isArray(certifications) ? certifications : [];
      return { reply: certList.length ? `${sentenceList(certList.map(c => c.name || c), 3)}.` : `His certifications are listed on his profile.` };
    }
    if (/prove it|examples?|like what/.test(lowerQuestion)) {
      return { reply: `Proof is public: his GitHub repos, live portfolio at ${identity?.portfolioUrl || 'https://bradleymatera.dev/'}, and verifiable AWS certifications.` };
    }
    if (/what risk/.test(lowerQuestion)) {
      return { reply: `Main risk: he's junior with no live production ownership yet. Mitigate with mentorship and scoped early work.` };
    }
    if (/what strength/.test(lowerQuestion)) {
      return { reply: `Strongest areas: React/JavaScript frontend work, documentation, debugging habits, and AWS fundamentals.` };
    }
    if (/what role/.test(lowerQuestion)) {
      return { reply: `${sentenceList((goals?.targetRoles || ['junior software engineer', 'cloud support']).slice(0, 4), 4)}.` };
    }
    if (lastAssistant) {
      return { reply: `Building on that: ${truncateWords(firstSentence(lastAssistant.replace(/<[^>]+>/g, ' ')), 25)} Ask about proof, risks, or role fit for more.` };
    }
  }
  
  // Compare him to the job / role comparison
  if (/compare him to the job|compare to the job|how does he compare|how does he stack up|compare him/.test(lowerQuestion)) {
    const role = findRoleInQuestion(question);
    if (role) return handleRoleFit(knowledge, question, role);
    return { reply: `${name} is a junior engineer with real React/Next.js projects, AWS certifications, and structured internship training. He fits junior web, cloud support, or technical support roles. He's not a fit for senior, lead, or architect positions.` };
  }

  // Clarifying question for truly ambiguous bare follow-ups (test suite section 11)
  if (/^(can he do it|what about that project|what happened there|is it relevant|was that real)\??$/.test(lowerQuestion.trim()) && !lastAssistant) {
    return { reply: `Which part is meant: his AWS internship, a specific project, or his overall role fit? Point at one and ${agentName} will answer directly.` };
  }
  
  // Army awards / medals specific question
  if (/awards|medals|ribbons|what.*earn.*army|what.*get.*army|combat medical badge/.test(lowerQuestion)) {
    const armyExp = (experience || []).find(e => /army|military/i.test(`${e.role} ${e.company} ${e.summary || ''}`));
    if (armyExp?.details?.awards?.length) {
      const awards = sentenceList(armyExp.details.awards, 10);
      if (inArmyContext) {
        return { reply: `During his service he earned ${awards}.` };
      }
      return { reply: `His awards include ${awards}.` };
    }
  }

  // Army leadership / did he lead anyone
  if (/lead.*army|did he lead|supervise|in charge|command|team leader.*army|squad|platoon/.test(lowerQuestion)) {
    const armyExp = (experience || []).find(e => /army|military/i.test(`${e.role} ${e.company} ${e.summary || ''}`));
    if (armyExp) {
      const details = armyExp.details || {};
      return { reply: `${name} served as a ${details.rank || 'Private First Class, E-3'} and focused on medical support and training soldiers on medical procedures. He was not in a formal leadership position; his rank and role were junior enlisted.` };
    }
  }

  // Army / military (narrowed 'service' to 'army service' to avoid catching 'customer service')
  if (/army|military|veteran|army service|military service|deployment|afghanistan|68w|combat medic|dd214/.test(lowerQuestion)) {
    const armyExp = (experience || []).find(e => /army|military/i.test(`${e.role} ${e.company} ${e.summary || ''}`));
    if (armyExp) {
      const details = armyExp.details || {};
      const rank = details.rank ? ` as a ${details.rank}` : '';
      const deployment = details.deployment ? `, deployed ${details.deployment}` : '';
      const awards = details.awards?.length ? ` Awards include ${sentenceList(details.awards, 10)}.` : '';
      const unit = details.unit ? ` with ${details.unit}` : '';
      return { reply: `${name} served in the U.S. Army${rank}${unit}${armyExp.dates ? ` (${armyExp.dates})` : ''}${deployment}. He provided medical support and trained soldiers on medical and safety procedures.${awards}` };
    }
    return { reply: `${name} has Army service in his background. Details are in his resume; ask him directly for specifics.` };
  }

  // Mason County Kitten Rescue / animal care / volunteer work
  if (/kitten|mason county kitten|animal care|animal shelter|rescue volunteer|rescue work/.test(lowerQuestion)) {
    const kittenExp = (experience || []).find(e => /kitten|animal care|rescue/i.test(`${e.role} ${e.company} ${e.summary || ''}`));
    if (kittenExp) {
      const topResp = (kittenExp.responsibilities || []).slice(0, 5).map(r => r.charAt(0).toLowerCase() + r.slice(1)).join('; ');
      return { reply: `${name} worked with ${kittenExp.company} from ${kittenExp.dates}. He started in a paid, part-time animal care role and continued as a volunteer. His work included ${topResp}.` };
    }
    return { reply: `${name} has animal care and volunteer rescue work in his background. Details are in his resume.` };
  }
  
  // Location / relocation / preferred location
  if (/where located|where is he|where does he live|based in|where is he based|where.*from\b|preferred location|location preference|where does he want to work/.test(lowerQuestion)) {
    return { reply: `He's based in ${location}.` };
  }

  // Relocation / availability / remote
  if (/relocat|remote only|remote\?|on.?site|hybrid|availab|preferred work arrangement|work arrangement/.test(lowerQuestion)) {
    if (goals?.relocation) {
      return { reply: `${goals.relocation} Exact start dates aren't in the public data, so confirm timing with him directly.` };
    }
    return { reply: `The public data says he's open to relocation. Exact availability isn't listed, so confirm with him directly.` };
  }
  
  // GPA / salary / private data not listed
  if (/gpa/.test(lowerQuestion) && !education?.gpa) {
    return { reply: `GPA isn't in the public data. His degree and school are listed; ask him if GPA matters for the role.` };
  }
  
  // What should I not claim (checked before FAQ so it wins)
  if (/not claim|should not claim|what.*not say|should not be claimed/.test(lowerQuestion)) {
    return { reply: `Do not claim senior-level experience, live production AWS ownership, or anything not in the public data. Safe framing: junior engineer with real projects, AWS certifications, and internship training.` };
  }
  
  // FAQ match from knowledge file
  if (Array.isArray(faq)) {
    const faqHit = faq.find(f => {
      const fq = String(f.question || '').toLowerCase();
      const keywords = fq.split(/\s+/).filter(w => w.length > 4);
      const hits = keywords.filter(k => lowerQuestion.includes(k)).length;
      return hits >= Math.max(2, Math.floor(keywords.length * 0.5));
    });
    if (faqHit) return { reply: faqHit.answer };
  }
  
  // Best / most relevant project (checked before role-fit so "best project for a frontend role" doesn't route to job suggestions)
  if (/best project|most relevant project|which project|what project|show me a project/.test(lowerQuestion)) {
    const frontend = projects?.find(p => /pokedex|ciris|projecthub/i.test(p.name));
    const cloud = projects?.find(p => /aws|serverless|metadata|cost-analysis/i.test(p.name));
    const picks = [];
    if (frontend) picks.push(`${frontend.name} for frontend/contributor work`);
    if (cloud) picks.push(`${cloud.name} for cloud work`);
    if (picks.length) return { reply: `Strongest demos: ${sentenceList(picks, 2)}. Full portfolio at ${identity?.portfolioUrl || 'https://bradleymatera.dev/'}.` };
    return { reply: `See his full portfolio at ${identity?.portfolioUrl || 'https://bradleymatera.dev/'}.` };
  }

  // DSA / algorithms / LeetCode specific questions (must come before role-fit so
  // "Is he good at algorithms?" doesn't get treated as a fit question)
  if (/\b(data structures|algorithms?|leetcode|dsa)\b/.test(lowerQuestion)) {
    return { reply: `${name} is honest about his DSA gap. He has taken Udemy courses and discussed the math with others, but he has never had production mentorship in data structures and algorithms and has no formal CS degree. He cannot reliably solve most LeetCode-style problems on his own yet. He is aware of the gap and wants to improve at a company that trains and mentors.` };
  }

  // Frontend / backend / full-stack developer direct questions
  if (/\b(is he|does he)\b.*\b(frontend|backend|full.?stack)\b.*\b(developer|engineer|dev)\b/.test(lowerQuestion)) {
    if (/full.?stack/.test(lowerQuestion)) {
      return { reply: `${name} is not a full-stack developer. He's a junior frontend-leaning developer with React, Next.js, and JavaScript project experience, plus some backend exposure from school and an AWS internship. He's not ready to own a full-stack production system yet.` };
    }
    if (/backend/.test(lowerQuestion)) {
      return { reply: `${name} is not a backend developer. He has some backend exposure from school (Node.js, SQL) and an AWS internship, but his strongest work is on the frontend and support side.` };
    }
    return { reply: `Yes, ${name} fits a junior frontend developer role. His strongest projects use JavaScript, TypeScript, React, and Next.js. It's project and internship experience, not production ownership.` };
  }

  // 'What kind of roles is he looking for?' — return target roles list, not a fit assessment (check before generic role-fit)
  if (/what kind of roles?|what roles.*(target|looking|fit)|fit for what kind|what kind of jobs?|what kind of work|what kind of position/.test(lowerQuestion)) {
    const roles = goals?.targetRoles || [];
    if (roles.length > 0) {
      return { reply: `He's targeting entry-level tech roles. Examples include ${sentenceList(roles.slice(0, 6), 6)}. He learns quickly and does best with mentorship or a structured teaching program.` };
    }
    return { reply: `He's looking for entry-level tech, IT, support, or software roles where he can learn hands-on.` };
  }

  // Role-fit / career-fit questions (broadened to catch natural recruiter phrasing)
  const role = findRoleInQuestion(question);
  const isNegativeFit = /isn't|is not|not a|not.*fit|why.*not|bad fit|poor fit|wrong|why no/.test(lowerQuestion);
  if (role && /(fit|candidate|what makes|suitable|right for|good for|apply for|how about|what about|role for|job for|would.*fit|should.*fit|bad fit|good fit|strong fit|best fit|is he a|is bradley a|good match|strong match|a match for|perfect for|missing for|gaps for|missing to be|should he apply|jobs should|work as a|work as an|pitch|sell|why hire|why should.*hire|good candidate|would he be a)/.test(lowerQuestion)) {
    if (isNegativeFit) {
      const roleAnalysis = analyzeRoleFit(role, knowledge);
      const gapsPhrase = roleAnalysis.gaps.length > 0 ? sentenceList(roleAnalysis.gaps.slice(0, 2), 2) : 'junior-level experience';
      return { reply: `${name} is not a strong fit for ${role}. The main gaps are ${gapsPhrase}. He's better suited for entry-level web, cloud support, or IT support roles.` };
    }
    return handleRoleFit(knowledge, question, role);
  }
  // 'Which is the best fit?' without a specific role
  if (/which.*best fit|best fit for him|which role.*best/.test(lowerQuestion)) {
    const targetRoles = (goals?.targetRoles || ['junior web', 'cloud support', 'technical support']).slice(0, 3);
    return { reply: `Based on the data, ${name}'s strongest matches are ${sentenceList(targetRoles, 3)} roles. Junior web and cloud support are the most direct fits given his React/Next.js projects and AWS background.` };
  }

  // Reasons to interview
  if (/reasons? to interview|why should.*interview|why hire|why should.*hire|what makes him worth|three reasons/.test(lowerQuestion)) {
    return { reply: `He has real projects in React/Next.js and a public GitHub. He holds AWS Solutions Architect and AI Practitioner certifications. He documents carefully, debugs methodically, and communicates well. He's junior, so scope early work and provide mentorship.` };
  }

  // What should a hiring manager know / recruiter note / candidate blurb
  if (/hiring manager|recruiter note|candidate blurb| cautious recommendation|what.*manager know|summary for a recruiter/.test(lowerQuestion)) {
    return { reply: `${name} is a ${title} with real projects, AWS certifications, and structured internship training. Good fit for junior web, cloud support, and technical support roles. Verify technical depth on a call.` };
  }
  
  // Dynamic contact info from knowledge base
  if (/\b(contact|email|phone|reach|github)\b|portfolio url|resume\?|links\?|\blinkedin\b(?!.*\b(style|summary|profile)\b)/.test(lowerQuestion)) {
    const contact = [];
    if (identity?.email) contact.push(`email at ${identity.email}`);
    if (identity?.phone) contact.push(`phone ${identity.phone}`);
    if (identity?.portfolioUrl) contact.push(`portfolio at ${identity.portfolioUrl}`);
    if (identity?.linkedInUrl) contact.push(`LinkedIn at ${identity.linkedInUrl}`);
    if (identity?.gitHubUrl) contact.push(`GitHub at ${identity.gitHubUrl}`);
    return { reply: `You can reach ${name} by ${contact.join(', ')}.` };
  }
  
  // CS degree / computer science degree specifically
  if (/computer science degree|cs degree|cs major|computer science major/.test(lowerQuestion)) {
    // Clarification phrasing like "I meant a four-year CS degree"
    if (/i meant|what i mean|to be clear|more precisely|four.year|4.year/.test(lowerQuestion)) {
      return { reply: `No, he doesn't have a four-year computer science degree. His degree is a B.S. in Web Development from Full Sail University.` };
    }
    return { reply: `No — ${name}'s degree is a B.S. in Web Development from Full Sail University, not computer science.` };
  }

  // What did he learn / what was his coursework
  if (/what did he learn|what did he study|what was his coursework|what did he learn there|what does he know from school|what technologies did he learn/.test(lowerQuestion)) {
    const langs = (skills?.languagesAndFrameworks || []).slice(0, 6).join(', ');
    return { reply: `At Full Sail, ${name} focused on web development. The program covered ${langs || 'JavaScript, React, Node.js, HTML, CSS, and SQL'} through coursework and projects.` };
  }

  // What degree does he have / what is his degree
  if (/what degree|which degree|what.*degree.*he.*have|what diploma|what did he graduate/.test(lowerQuestion)) {
    if (education?.degree && education?.school) {
      let edu = `${name} earned a ${education.degree} from ${education.school}`;
      if (education?.graduated) edu += `, graduating ${education.graduated}`;
      return { reply: edu + '.' };
    }
    return { reply: `${name}'s education details are available in his full profile.` };
  }

  // Is [school] respected / accredited / good
  if (/is full sail|accredited|respected|prestigious|good school/.test(lowerQuestion)) {
    return { reply: `The recruiter data only lists that ${name} studied web development at Full Sail University. Rankings and accreditation aren't included, so judge the school independently if it matters for the role.` };
  }

  // Dynamic education from knowledge base
  if (/education|degree|school|full sail|gpa/.test(lowerQuestion)) {
    if (education?.degree && education?.school) {
      let edu = `${name} holds a ${education.degree} from ${education.school}`;
      if (education?.gpa) edu += ` (GPA ${education.gpa})`;
      if (education?.graduated) edu += `, graduated ${education.graduated}`;
      return { reply: edu + '.' };
    }
    return { reply: `${name}'s education details are available in his full profile.` };
  }
  
  // Dynamic certifications from knowledge base
  if (/cert|certificate|certification/.test(lowerQuestion)) {
    const certs = Array.isArray(certifications) ? certifications : [];
    if (certs.length > 0) {
      return { reply: `${name} holds ${sentenceList(certs.map(c => c.name || c), 3)}.` };
    }
    return { reply: `${name}'s certifications are listed in his full profile.` };
  }
  
  // Mentorship / teaching / structured learning
  if (/mentorship|mentor|teaching|teach|structured program|structured learning|willing to teach|on.?the.?job training|learn on the job/.test(lowerQuestion)) {
    return { reply: `${name} values mentorship and structured teaching programs because he learns quickly and can prove value fast in any entry-level tech, IT, or support role.` };
  }

  // Bad-fit / what roles are a poor match (checked before target-roles so it wins over 'what jobs')
  if (/bad fit|poor fit|not a fit|not a good fit|wrong role|wrong job|jobs to avoid|roles to avoid|would not fit|should not apply|what.*avoid|where.*not fit|what.*poor match|what.*bad match/.test(lowerQuestion)) {
    return { reply: `${name} is junior, so senior, lead, architect, or production-owner roles are a poor fit. He's best suited for entry-level tech, IT, software support, cloud support, and helpdesk roles.` };
  }

  // Helpdesk / IT support / desktop support openness
  if (/helpdesk|help.?desk|desktop support|IT support|service desk|technical support|support role/.test(lowerQuestion)) {
    return { reply: `Yes, ${name} is open to helpdesk and IT support roles. He's looking for any entry-level tech role where he can learn hands-on, especially one with mentorship or a structured teaching program.` };
  }

  // Dynamic roles / job-suggestions from knowledge base
  // Guard: don't treat weakness phrasing ('struggle with on the job') as a role query
  if (!/struggle|weakness|weak at|not good at|gaps|limitations|what.*missing|red flag/.test(lowerQuestion) &&
      /role|target|job|looking|work.*looking|what kind of job|what jobs|should.*apply|where.*fit/.test(lowerQuestion)) {
    const roles = goals?.targetRoles || [];
    if (roles.length > 0) {
      const examples = sentenceList(roles.slice(0, 6), 6);
      let reply = `${name} is open to any entry-level tech, IT, or support role. Examples from his target list include ${examples}. He learns quickly and does best with mentorship or a structured teaching program.`;
      if (goals?.relocation) reply += ` He is ${goals.relocation.toLowerCase().replace(/\.$/, '')}.`;
      return { reply };
    }
    return { reply: `${name} is looking for entry-level tech, IT, support, or software roles where he can learn hands-on.` };
  }

  // Dynamic AWS/cloud from knowledge base (checked before generic skill matcher so 'does he have AWS experience' gets a detailed answer)
  if (/aws|cloud|lambda|dynamo|s3|amplify|amazon/.test(lowerQuestion)) {
    const cloudSkills = skills?.cloudAndInfrastructure || [];
    if (cloudSkills.length > 0) {
      let reply = `${name} has AWS experience with ${sentenceList(cloudSkills, 5)}.`;
      const awsExp = experience?.find(e => e.role?.toLowerCase().includes('aws') || e.company?.toLowerCase().includes('aws') || e.company?.toLowerCase().includes('amazon'));
      if (awsExp) {
        const article = /^[aeiou]/i.test(awsExp.role) ? 'an' : 'a';
        reply += ` He completed ${article} ${awsExp.role} at ${awsExp.company}, built around structured labs and a capstone rather than live production ownership.`;
      }
      return { reply: reply };
    }
    return { reply: `${name}'s AWS experience is detailed in his profile.` };
  }

  // Production work / real production / live ownership follow-ups
  if (/production work|production experience|real production|live production|production environment|production ownership|was it production|was any of that production|was this production/.test(lowerQuestion)) {
    return { reply: `${name}'s AWS work was structured labs and a capstone, not live production ownership. His projects are school, freelance contributor, or personal demos. He has not held a production-owning engineering role yet; that's part of why he's targeting junior and support-level positions.` };
  }

  // Programming languages
  if (/\blanguages\b|what languages|which languages|programming languages/.test(lowerQuestion)) {
    const langs = (skills?.languagesAndFrameworks || []).slice(0, 8).join(', ');
    return { reply: `${name} works with ${langs || 'JavaScript, TypeScript, React, Node.js, HTML, CSS, and SQL'}.` };
  }

  // Databases / SQL
  if (/\bdatabase|databases\b|sql|has he worked with databases/.test(lowerQuestion)) {
    const dbSkills = (skills?.databases || skills?.languagesAndFrameworks?.filter(s => /sql|mongo|dynamodb|postgres|mysql/i.test(s)) || []).slice(0, 4).join(', ');
    return { reply: `${name} has database exposure through ${dbSkills || 'SQL and DynamoDB'} from school projects and his AWS internship. It's not production DBA work, but he can read schemas and write basic queries.` };
  }

  // Dynamic skills from knowledge base
  if (/skill|stack|technical|technologies|what does he know|what can he do|what stack/.test(lowerQuestion)) {
    const langs = (skills?.languagesAndFrameworks || []).slice(0, 3).join(', ');
    const cloud = (skills?.cloudAndInfrastructure || []).slice(0, 3).join(', ');
    const tools = (skills?.toolsAndWorkflows || []).slice(0, 3).join(', ');
    if (langs || cloud || tools) {
      return { reply: `${name}'s stack: ${[langs, cloud && `cloud: ${cloud}`, tools && `tools: ${tools}`].filter(Boolean).join('; ')}.` };
    }
    return { reply: `${name}'s skills are detailed in his full profile.` };
  }

  // Can he code / does he know how to code (broad, not a specific language)
  if (/\b(can he code|can he actually code|does he code|does he know how to code|is he a coder|can he program|does he program|can he write code)\b/.test(lowerQuestion)) {
    const langs = (skills?.languagesAndFrameworks || []).slice(0, 8).join(', ');
    return { reply: `Yes, at a junior level. ${name} can read code, follow logic, make changes, debug problems, and handle basics and level-one work in ${langs || 'the languages he studied in school'}. His honest gap is data structures and algorithms: he has taken courses but never had production mentorship in DSA, and he cannot reliably solve most LeetCode-style problems or build a complete program from a blank file without help. He is aware of it and willing to improve at a company that mentors.` };
  }

  // Specific-skill yes/no (does he know Python, can he use Go, etc.)
  const skillAskMatch = lowerQuestion.match(/\b(?:does he know|can he use|can he work with|is he familiar with|does he have)\s+(?:in\s+)?([a-z0-9+#.]{2,})/);
  if (skillAskMatch) {
    const asked = skillAskMatch[1].toLowerCase();
    const stopWords = new Set(['a', 'an', 'the', 'any', 'some', 'much', 'many', 'preferred', 'location', 'experience', 'skills', 'in', 'of', 'for']);
    if (!stopWords.has(asked)) {
      const allSkills = [
        ...(skills?.languagesAndFrameworks || []),
        ...(skills?.cloudAndInfrastructure || []),
        ...(skills?.toolsAndWorkflows || []),
        ...(skills?.aiAndAutomation || []),
        ...(skills?.learningOrAdjacent || [])
      ].map(s => s.toLowerCase());
      const known = allSkills.some(s => s.includes(asked) || asked.includes(s));
      if (known) {
        return { reply: `Yes, ${name} has ${asked} in his listed skills or adjacent learning.` };
      }
      return { reply: `The data doesn't show direct ${asked} experience. He's strongest in JavaScript/TypeScript, React, Node.js, and AWS support work.` };
    }
  }
  
  // Specific project lookup by name (allow partial matches on significant words)
  const lowerQuestionWords = lowerQuestion.split(/\s+/).filter(Boolean);
  const matchedProject = (projects || []).find(p => {
    const pName = p.name.toLowerCase();
    const pWords = pName.split(/\s+/).filter(w => w.length > 2);
    if (lowerQuestion.includes(pName)) return true;
    if (pWords.length && pWords.every(w => lowerQuestionWords.includes(w))) return true;
    // Match if any non-trivial project word is present in the question and is distinctive
    const significant = pWords.filter(w => w.length > 4);
    if (significant.length && significant.some(w => lowerQuestionWords.includes(w))) return true;
    return false;
  });
  if (matchedProject) {
    const tech = matchedProject.tech?.slice(0, 5).join(', ') || '';
    const desc = matchedProject.description || matchedProject.desc || '';
    const link = matchedProject.url || matchedProject.repo || identity?.portfolioUrl || 'https://bradleymatera.dev/';
    return { reply: `${matchedProject.name}: ${desc}${tech ? ` Tech: ${tech}.` : ''} See it at ${link}.` };
  }

  // Legitimacy / "is this just a portfolio site" questions
  if (/is this guy legit|is it just a portfolio|not just a portfolio|not a portfolio|is he the real deal|real credentials|legit or/.test(lowerQuestion)) {
    const certsList = (certifications || []).slice(0, 2).map(c => c.name || c);
    const topProjects = (projects || []).slice(0, 3).map(p => p.name);
    let reply = `He's a real ${title} with public projects (${topProjects.join(', ')})`;
    if (certsList.length) reply += ` and verifiable certs (${sentenceList(certsList, 2)})`;
    reply += `. Links are on his portfolio and LinkedIn.`;
    return { reply };
  }

  // Teamwork / team player / works with others / interpersonal / social skills
  if (/teamwork|team player|works with others|do well in a team|good in a team|work in a team|how does he work in a team|how is he on a team|collaborat|how does he work with|interpersonal|social skill|works well with|good with people|how is he with people|how is brad with people|how is he around people|people person|ok socially|socially|with people/.test(lowerQuestion)) {
    return { reply: `${name} has real interpersonal experience: case management (helping clients through court-mandated requirements), Army healthcare specialist (working with crews under pressure), and construction (communicating with homeowners and crews). He communicates clearly with both technical and non-technical people.` };
  }

  // Customer service / support experience
  if (/customer service|customer support|client facing|user support|help desk|service desk|support role/.test(lowerQuestion)) {
    return { reply: `${name} has customer-facing experience from case management (guiding clients through legal processes), Army service, and construction (working directly with homeowners). His communication skills transfer well to customer support and help desk roles.` };
  }

  // 'What data do you have' / what is in his data
  if (/what data|what info|what information|what do you (have|know)|what is in (his|the) data|what can you tell me|what do you have on/.test(lowerQuestion)) {
    return { reply: `${agentName} has verified data on ${name}'s projects, skills (JavaScript, TypeScript, React, AWS), certifications (AWS Solutions Architect, AI Practitioner), education (Full Sail University), work history (AWS internship, CIRIS, case management, Mason County Kitten Rescue, Army service, construction), target roles, and contact info. Ask about any of those.` };
  }

  // Confusion / 'you're not making sense' / clarification
  if (/not making sense|makes no sense|what are you talking about|confused|dont understand|do not understand|what do you mean/.test(lowerQuestion)) {
    return { reply: `Sorry about that. ${agentName} covers ${name}'s projects, skills, AWS background, role fit, and contact info. What specifically do you want to know?` };
  }

  // Work style (checked before generic project branch so "what is his work style" doesn't return a project list)
  if (/work style|how does he work|how he works|approach to work/.test(lowerQuestion)) {
    const styles = summary?.workStyle?.length
      ? summary.workStyle.slice(0, 3)
      : ['reads nearby code before changing things', 'runs the project locally first', 'documents what he learns'];
    return { reply: `His work style: ${sentenceList(styles, 3)}.` };
  }

  // Coding style / how does he code
  if (/coding style|how does he code|code style|how he codes|programming style|how does he program/.test(lowerQuestion)) {
    const styles = summary?.workStyle?.slice(0, 2) || ['reads nearby code before changing things', 'makes small reviewable changes'];
    const strengths = summary?.coreStrengths?.slice(0, 1) || ['learning quickly in unfamiliar codebases'];
    return { reply: `${name} reads existing code before changing anything, makes small reviewable changes, and documents what he learns. His main strength is ${strengths[0].toLowerCase()}.` };
  }

  // Approach to learning / how does he learn
  if (/approach to learning|approach.*learning|how does he learn|how he learns|learning style|fast learner|quick learner|how fast does he learn/.test(lowerQuestion)) {
    const learning = skills?.learningOrAdjacent?.length ? skills.learningOrAdjacent.slice(0, 2) : ['currently learning C#/.NET fundamentals'];
    return { reply: `${name} learns by running the project locally, reading the code, and documenting what he finds. Right now he's ${learning.join(' and ').toLowerCase()}. He's honest about what he doesn't know yet and asks useful questions after doing his homework.` };
  }

  // Communication style / how does he communicate
  if (/communication style|how does he communicate|how he communicates|communication skill|how does he talk to users|how does he talk to/.test(lowerQuestion)) {
    const comm = summary?.coreStrengths?.find(s => /communicat/i.test(s)) || 'Communicating with technical and non-technical users';
    return { reply: `${name} communicates directly and clearly. His case manager experience taught him to explain things to non-technical people, and his documentation shows he can write for other developers too.` };
  }

  // Problem solving / how does he solve problems
  if (/problem solving|how does he solve|how does he approach.*problem|how does he debug|approach to debug|approach.*debug|troubleshoot.*approach|how does he troubleshoot/.test(lowerQuestion)) {
    const debug = summary?.coreStrengths?.find(s => /debug/i.test(s)) || 'Debugging carefully and isolating issues';
    return { reply: `${name} isolates problems methodically: he reproduces the issue, checks logs and docs, narrows down the cause, and documents the fix. He's honest when he doesn't know the answer yet.` };
  }

  // Reliability / dependable / can I count on him
  if (/reliab|dependab|can i count on|show up|work ethic|does he show up/.test(lowerQuestion)) {
    return { reply: `${name} has a track record of showing up: Army service, construction work, and case management all required reliability under pressure. His work style is methodical and he documents what he does so others can pick up where he left off.` };
  }

  // Dynamic projects from knowledge base (narrowed 'work' to 'his work' to avoid catching 'works with people' or 'work history')
  if (/project|portfolio|his work on|real projects|best project|shipped/.test(lowerQuestion)) {
    const projectList = projects?.slice(0, 5) || [];
    if (projectList.length > 0) {
      const projectNames = projectList.map(p => p.name).join(', ');
      return { reply: `${name}'s notable projects include ${projectNames}. You can see his full portfolio at ${identity?.portfolioUrl || 'https://bradleymatera.dev/'}.` };
    }
    return { reply: `${name}'s projects are showcased in his portfolio.` };
  }

  // Dynamic experience from knowledge base
  if (/experience|intern|work history|background/.test(normalized)) {
    const expList = experience?.slice(0, 3) || [];
    if (expList.length > 0) {
      const roles = expList.map(e => `${e.role}${e.company ? ` at ${e.company}` : ''}`).join(', ');
      return { reply: `${name}'s recent experience includes ${roles}.` };
    }
    return { reply: `${name}'s work history is available in his full profile.` };
  }
  
  // What makes him different / differentiator (checked before no-bs so it gives a specific answer)
  if (/what makes him different|different from other|what sets him apart|stands out|why him over/.test(lowerQuestion)) {
    const certsList = (certifications || []).slice(0, 2).map(c => c.name || c);
    const shortCerts = certsList.map(c => c.replace('AWS Certified ', 'AWS '));
    const topProjects = (projects || []).slice(0, 2).map(p => p.name);
    let reply = `${name} has both real shipped projects (${topProjects.join(', ')}) and ${sentenceList(shortCerts, 2)} certs.`;
    reply += ` Most juniors have one or the other. He also documents carefully and debugs methodically, which means less hand-holding.`;
    return { reply };
  }

  // Naturalness / no-bs — split into angled replies so they don't all sound the same
  // Angle 1: "worth interviewing / is he worth" — lead with credentials + what to verify
  if (/worth calling|worth interviewing|is he worth/.test(lowerQuestion)) {
    const certsList = (certifications || []).slice(0, 2).map(c => c.name || c);
    const shortCerts = certsList.map(c => c.replace('AWS Certified ', 'AWS '));
    return { reply: `${name} has real projects and ${sentenceList(shortCerts, 2)} certs. He's junior, so verify technical depth on a call. Worth a screening interview for junior web or cloud support roles.` };
  }

  // Angle 2: "why should i care" — lead with what's useful day one
  if (/why should i care/.test(lowerQuestion)) {
    return { reply: `He can debug methodically, write clear docs, and has AWS fundamentals. That means less hand-holding than most juniors. He's not senior, but he's useful on day one for junior web or support work.` };
  }

  // Angle 3: "no bs / tell me straight" — lead with honest limitations, then what's real
  if (/no bs|no bullshit|tell me straight|just the facts/.test(lowerQuestion)) {
    return { reply: `He's junior with no live production ownership. His AWS internship was labs and a capstone, not real customer tickets. But he has real shipped projects, two AWS certs, and he documents and debugs carefully.` };
  }

  // Angle 4: "honest version / give me the honest" — the catch, then the upside
  if (/give me the honest version|give me the simple version|honest version/.test(lowerQuestion)) {
    return { reply: `The catch: he's junior, and his AWS experience is structured labs, not production. The upside: real React/Next.js projects, AWS Solutions Architect and AI Practitioner certs, and work habits that mean less hand-holding.` };
  }

  // Remaining naturalness patterns — general catch-all
  if (/is he good|is he legit|real projects|does he write|can he talk|can he troubleshoot|does he write docs|what can he actually do|what does he actually know|what does he actually do|is he the real deal|not just a portfolio|not a portfolio|what is the catch|what.s the catch/.test(lowerQuestion)) {
    const certsList = (certifications || []).slice(0, 2).map(c => c.name || c);
    const topProjects = (projects || []).slice(0, 3).map(p => p.name);
    const shortCerts = certsList.map(c => c.replace('AWS Certified ', 'AWS '));
    let reply = `${name} is a junior engineer with real projects (${topProjects.join(', ')})`;
    if (shortCerts.length) reply += ` and ${sentenceList(shortCerts, 2)} certs`;
    reply += `. Good fit for junior web, cloud support, or IT support roles.`;
    return { reply };
  }

  // Strengths (checked before summary so 'about his strengths' doesn't match summary's 'about')
  if (/strength|strongest|greatest|best at|what does he do well/.test(lowerQuestion)) {
    const strengths = summary?.coreStrengths?.length
      ? summary.coreStrengths.slice(0, 3).map(s => s.charAt(0).toLowerCase() + s.slice(1))
      : ['learning quickly', 'documenting clearly', 'debugging carefully'];
    return { reply: `${name}'s core strengths include ${sentenceList(strengths, 3)}. He also learns quickly, works carefully, and communicates clearly.` };
  }

  // Specific early branch for 'what does he write about' style questions
  if (/write about|writes about|written about|what.*he.*write.*about/.test(lowerQuestion)) {
    const posts = blogCatalog?.records || [];
    const dev = posts.filter(p => p.platform === 'DEV Community').length;
    const site = posts.filter(p => p.platform === 'bradleymatera.dev').length;
    const samples = posts.slice(0, 4).map(p => p.title).filter(Boolean);
    return { reply: `${name} has written ${posts.length} posts across DEV Community (${dev}) and bradleymatera.dev (${site}). Recent topics include ${sentenceList(samples, 4)}. Links and full briefs are in his blog catalog.` };
  }

  // Elevator pitch / 20 seconds / short intro
  if (/elevator|20 second|30 second|quick pitch|sell him in|pitch for|give me a pitch|short pitch|one-liner|tl;dr|tl;dr/.test(lowerQuestion)) {
    const certs = (certifications || []).slice(0, 2).map(c => c.name || c).map(c => c.replace('AWS Certified ', 'AWS '));
    const topProjects = (projects || []).slice(0, 2).map(p => p.name);
    return { reply: `${name} is a ${title} based in ${location.replace(/\s*\(open to relocation\)\s*/i, '')}. He has real shipped projects (${topProjects.join(', ')}), ${sentenceList(certs, 2)} certs, and structured AWS internship training. He's targeting ${sentenceList((goals?.targetRoles || ['junior web', 'cloud support']).slice(0, 2), 2)} roles and is open to relocation.` };
  }

  // Blog / writing / articles
  if (/\bblog\b|article|writing|publication|has he written|what.*he.*(write|written|writes)|what has he published|where does he write|write about|writes about|written about|dev\.to|dev community|bradleymatera\.dev/.test(lowerQuestion)) {
    const posts = blogCatalog?.records || [];
    const dev = posts.filter(p => p.platform === 'DEV Community').length;
    const site = posts.filter(p => p.platform === 'bradleymatera.dev').length;
    const samples = posts.slice(0, 4).map(p => p.title).filter(Boolean);
    return { reply: `${name} has written ${posts.length} posts across DEV Community (${dev}) and bradleymatera.dev (${site}). Recent topics include ${sentenceList(samples, 4)}. Links and full briefs are in his blog catalog.` };
  }

  // Dynamic summary from knowledge base
  if (/summary|who is bradley|who is brad\b|about brad|tell me about brad|who is bradley|tell me about bradley|in (20|30) seconds|simple version|honest version|like a normal person|normal person|give me the simple/.test(lowerQuestion)) {
    return { reply: concisePitch(knowledge) };
  }

  // Weaknesses / concerns / what is not proven
  if (/weakness|weaknesses|weak at|bad at|not good at|struggle|concern|not proven|what is he missing|what is missing|gaps|limitations|bad fit|red flag|what concerns|leetcode|data structures|dsa\b|algorithms?/.test(lowerQuestion)) {
    const gaps = (summary?.honestGaps || []);
    if (gaps.length > 0) {
      return { reply: `${name}'s honest gaps are data structures and algorithms (he has taken courses but lacks production mentorship and a formal CS degree), turning a brand-new problem into code from a blank file without guidance, and most LeetCode-style problems. He is aware of these gaps and wants to improve at a company that trains and mentors; his strengths are reading code, debugging, documentation, and learning quickly.` };
    }
    return { reply: `Main caution is that he is junior, so verify depth on a call.` };
  }
  
  // Interview questions
  if (/interview question|what.*ask him|what.*verify/.test(lowerQuestion)) {
    return { reply: `Ask about his AWS capstone, how he debugs a broken React component, his experience with CI/CD or Docker, and how he handles unknown tech.` };
  }

  // Handling unknown tech / not knowing something
  if (/handle unknown|not knowing something|doesn't know|does not know|unfamiliar tech|new tech/.test(lowerQuestion)) {
    return { reply: `${name} is honest about what he knows and what he does not know yet. He checks documentation, logs, and examples, then asks a useful question after doing his homework rather than guessing.` };
  }
  
  // Salary / private data
  if (/salary|address|home|current salary|pay|compensation/.test(lowerQuestion)) {
    return { reply: `Salary and address details are not in the public data. Check his resume or contact him directly.` };
  }

  // Out-of-scope: non-recruiter questions (jokes, sports, food, time, zodiac, weather, etc.)
  // Skip if this is a repair/tone-control prompt — those should fall through to concisePitch
  const isRepairOrTone = repair.shorter || repair.moreHonest || repair.blunt || repair.resumeLanguage || repair.moreTechnical || repair.hrFriendly
    || detectBannedWords(question).length > 0
    || /buzzword|corporate|plain|paragraph|no hype|no marketing|salesy|resume language|passionate|absolutely|certainly/.test(lowerQuestion);
  if (!isRepairOrTone && !isProbablyRelevant(question) && !/brad|matera|recruit|job|role|skill|languages|databases|project|portfolio|contact|email|phone|cert|education|degree|aws|cloud|react|javascript|typescript|intern|experience|hire|candidate|kitten|rescue|animal|shelter|volunteer|paid|blog|article|writing|publication|dev\.to|dev community|write about/.test(lowerQuestion)) {
    const outOfScope = [
      `That's outside what ${agentName} covers. Ask about ${name}'s projects, skills, AWS background, role fit, or contact info.`,
      `${agentName} sticks to ${name}'s recruiter profile — projects, skills, AWS work, role fit, and how to contact him. That question isn't in the data.`,
      `I don't have that in ${name}'s verified recruiter data. What do you want to know about his projects, skills, or role fit?`,
      `That's not something ${agentName} tracks. I can answer questions about ${name}'s tech background, work history, and contact info.`
    ];
    const pick = outOfScope[history.length % outOfScope.length];
    return { reply: pick };
  }

  // Default to basic info
  return { reply: concisePitch(knowledge) };
}

function buildGroundedFallback(knowledge, question, history) {
  return buildGroundedFallbackPayload(knowledge, question, history || []).reply;
}

// Wrap a grounded reply with conversation context awareness.
function buildContextualGroundedReply(groundedReply, question, history) {
  if (!Array.isArray(history) || history.length === 0) return groundedReply;
  const lastTurn = history[history.length - 1];
  if (!lastTurn || !lastTurn.assistant) return groundedReply;

  const q = String(question || '').trim();
  const qLower = q.toLowerCase();
  const currentTopic = classifyTopic(question);
  const lastTopic = classifyTopic(lastTurn.user || '');
  const lastAns = String(lastTurn.assistant || '').toLowerCase().replace(/<[^>]+>/g, '').trim();
  const groundedNorm = String(groundedReply || '').toLowerCase().replace(/<[^>]+>/g, '').trim();

  // Bare follow-up / clarification request — answer from the last topic instead of returning a generic reply.
  if (/^what do you mean\??|^tell me more\.?|^explain\.?|^why\??|^how\??|^can you clarify|^what about that\??|^elaborate/.test(qLower)) {
    if (currentTopic === lastTopic && currentTopic !== 'other') {
      const short = firstSentence(groundedReply);
      return `To clarify: ${short}`;
    }
  }

  // Direct rephrasing / clarification like "I meant...", "What I mean is..." — answer plainly, no prefix.
  if (/^(i meant|what i mean|clarifying|to be clear|more precisely|in other words)\b/.test(qLower)) {
    return groundedReply;
  }

  // Repeated nearly-identical question — answer briefly and refer back.
  const lastQNorm = String(lastTurn.user || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const qNorm = qLower.replace(/[^a-z0-9\s]/g, '').trim();
  const qWords = new Set(qNorm.split(/\s+/).filter(w => w.length > 3));
  const lastQWords = new Set(lastQNorm.split(/\s+/).filter(w => w.length > 3));
  const qOverlap = qWords.size > 0 ? [...qWords].filter(w => lastQWords.has(w)).length / qWords.size : 0;
  if (qOverlap > 0.5) {
    const short = firstSentence(groundedReply);
    return `As I mentioned, ${short.toLowerCase()}`;
  }

  // Same topic as last turn — check if the grounded reply is nearly identical to the last answer
  if (currentTopic === 'other' || currentTopic !== lastTopic) return groundedReply;

  const groundedWords = new Set(groundedNorm.split(/\s+/).filter(w => w.length > 4));
  const lastWords = new Set(lastAns.split(/\s+/).filter(w => w.length > 4));
  if (groundedWords.size === 0) return groundedReply;
  const overlap = [...groundedWords].filter(w => lastWords.has(w)).length / groundedWords.size;
  if (overlap > 0.6) {
    // Vary the follow-up transition based on turn count; keep proper nouns capitalized
    const transitions = [
      'To add to that,',
      'Building on that,',
      'Also,',
      'Related to that,',
      'More specifically,',
      'To put it another way,',
    ];
    const prefix = transitions[history.length % transitions.length];
    return `${prefix} ${groundedReply}`;
  }
  return groundedReply;
}

function shouldUseGroundedAnswer(question) {
  const rawQuestion = String(question || '').toLowerCase();
  // Only use grounded fallback for simple factual lookups, let Gemini handle complex questions
  return /\b(contact|email|phone|reach|linkedin|github)\b/.test(normalizeQuestion(question));
}

function isProbablyRelevant(question) {
  const normalized = normalizeQuestion(question);
  // Very broad relevance check - if it mentions Bradley or any career-related terms, let it through
  return /\b(bradley|brad|matera|candidate|recruiter|software|engineer|developer|web|aws|cloud|support|skill|stack|languages|databases|project|portfolio|contact|email|phone|role|job|education|cert|resume|ciris|ethical|freelance|contributor|intern|internship|work|experience|debug|troubleshoot|document|learn|communication|army|military|construction|case|manager|managers|approach|style|strength|weakness|feedback|management|kitten|rescue|animal|shelter|volunteer|veteran|deploy|afghanistan|68w|medic|blog|article|writing|publication|dev\.to|dev community)\b/.test(normalized) || normalized.includes('bradley') || normalized.includes('write about') || normalized.includes('writes about');
}

function cleanModelReply(reply, knowledge, question, history) {
  let cleaned = String(reply || '').trim().replace(/\s+/g, ' ');
  cleaned = removeSlop(cleaned);
  if (!cleaned || cleaned.length < 10) {
    return { reply: buildGroundedFallback(knowledge, question, history), fallback: true };
  }
  return { reply: cleaned, fallback: false };
}

// ============ RAG GENERATIVE LAYER ============
// Retrieval over the full knowledge JSON + constrained generation on the local
// tiny model (smollm2:135m), hard-capped at GEN_TIMEOUT_MS so answers stay
// inside the 15-second budget. Grounded answer is the guaranteed fallback.
const GEN_MODEL = process.env.GEN_MODEL || 'smollm2:135m';
const GEN_TIMEOUT_MS = parseInt(process.env.GEN_TIMEOUT_MS || '13000', 10);
const GEN_ENABLED = process.env.GEN_ENABLED !== 'false';

// Flatten the entire knowledge file into retrievable fact chunks
function buildRagChunks(knowledge) {
  const { identity, summary, goals, education, certifications, skills, experience, projects, faq, interviewStories, rules, sourceMaterial, blogCatalog } = knowledge || {};
  const chunks = [];
  const add = (tag, text) => { if (text) chunks.push({ tag, text: String(text) }); };

  add('identity', `${identity?.name || 'Bradley Matera'} is a ${identity?.title || 'junior software engineer'} based in ${identity?.location || 'Davis, Illinois'}.`);
  add('pitch', identity?.shortPitch);
  add('summary', summary?.whoIAm);
  add('what-he-does', summary?.whatIDo);
  add('looking-for', summary?.whatIAmLookingFor);
  add('target-roles', goals?.targetRoles?.length ? `Target roles: ${goals.targetRoles.join(', ')}.` : null);
  add('relocation', goals?.relocation);
  if (education?.degree) add('education', `Education: ${education.degree} from ${education.school}${education.gpa ? ` (GPA ${education.gpa})` : ''}.`);
  (certifications || []).forEach(c => add('certification', `Certification: ${c.name || c}${c.issued ? `, issued ${c.issued}` : ''}.`));
  if (skills?.languagesAndFrameworks?.length) add('skills-web', `Web skills: ${skills.languagesAndFrameworks.join(', ')}.`);
  if (skills?.cloudAndInfrastructure?.length) add('skills-cloud', `Cloud skills: ${skills.cloudAndInfrastructure.join(', ')}.`);
  if (skills?.toolsAndWorkflows?.length) add('skills-tools', `Tools: ${skills.toolsAndWorkflows.join(', ')}.`);
  if (skills?.aiAndAutomation?.length) add('skills-ai', `AI workflow: ${skills.aiAndAutomation.join(', ')}.`);
  (experience || []).forEach(e => add('experience', `${e.role}${e.company ? ` at ${e.company}` : ''}${e.dates ? ` (${e.dates})` : ''}: ${e.summary || ''}`));
  (projects || []).forEach(p => add('project', `Project ${p.name}: ${p.description || ''}${p.tech?.length ? ` Tech: ${p.tech.join(', ')}.` : ''}`));
  (faq || []).forEach(f => add('faq', `Q: ${f.question} A: ${f.answer}`));
  (interviewStories || []).forEach(s => add('story', `${s.title || s.topic || ''}: ${s.story || s.summary || ''}`));
  if (rules?.doNot?.length) add('boundaries', `Never claim: ${rules.doNot.slice(0, 4).join('; ')}.`);
  (sourceMaterial || []).forEach((m, i) => { if (m?.content) add('source', `[${m.title || 'source'}-${i}] ${m.content}`); });
  (blogCatalog?.records || []).forEach((post, i) => {
    if (post?.title || post?.brief) {
      add('blog', `[${post.platform || 'blog'}-${i}] ${post.title || 'Post'}: ${post.brief || ''}${post.url ? ` URL: ${post.url}` : ''}`);
    }
  });
  return chunks;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'his', 'her', 'he', 'she', 'it', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'about', 'what', 'who', 'how', 'does', 'do', 'did', 'can', 'me', 'tell', 'you', 'your', 'this', 'that', 'on', 'at', 'i']);

function retrieveChunks(question, chunks, k = 5) {
  const qWords = normalizeQuestion(question).split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
  const scored = chunks.map(c => {
    const text = c.text.toLowerCase();
    let score = 0;
    qWords.forEach(w => { if (text.includes(w)) score += w.length > 5 ? 2 : 1; });
    // Boost identity/summary lightly so open questions always get who-he-is context
    if (c.tag === 'identity' || c.tag === 'summary') score += 0.5;
    return { ...c, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, k).filter(c => c.score > 0.4);
}

const GEN_FALSE_CLAIMS = /\b(senior engineer|senior developer|10\+? years|worked at (google|amazon|meta|microsoft|apple)|fortune 500|production owner|led a team of|cto|principal engineer|master'?s degree|phd|security clearance)\b/i;
const GEN_SLOP = /\b(great question|as an ai|i'?m glad you asked|numerous candidates|excellent opportunity|showcase their|enthusiasm for the field|passion(ate)?|robust|synergy|leverage|dynamic individual|world-class|game.?changer)\b/i;
const GEN_OVERCLAIM = /\b(long history|years of experience|many years|several years|seasoned|expert(ise)? |well.?versed|veteran of|deep experience|extensive|highly experienced|accomplished|proven track record|at the company|this year|last year|currently employed|notable projects across|exceptional|scalable software solutions|highly skilled|mastery|advanced knowledge)\b/i;

// Common capitalized words that don't need to exist in the source facts
const GEN_ENTITY_ALLOWLIST = new Set(['He', 'His', 'Him', 'The', 'A', 'An', 'In', 'On', 'At', 'As', 'With', 'When', 'If', 'For', 'And', 'But', 'Or', 'So', 'To', 'Of', 'By', 'From', 'This', 'That', 'These', 'Those', 'It', 'Its', 'They', 'While', 'Although', 'Because', 'Overall', 'Currently', 'Recently', 'Bradley', 'Matera', 'Brad', 'B.S', 'B', 'S', 'U']);

function validateGenerative(text, groundedReply) {
  const t = String(text || '').trim();
  if (t.length < 25 || t.length > 600) return false;
  if (GEN_FALSE_CLAIMS.test(t)) return false;
  if (GEN_SLOP.test(t)) return false;
  if (GEN_OVERCLAIM.test(t)) return false;
  if (!/\b(bradley|brad|he|his)\b/i.test(t)) return false;
  // Third person only: the assistant must never speak as Bradley or roleplay
  if (/\b(I|I'm|I've|my|we|our)\b/.test(t)) return false;
  if (/"|\*|pause|scout here|as scout|hi,|hello,/i.test(t)) return false;
  // No invented numbers: every digit sequence must exist in the grounded source
  const genNumbers = t.match(/\d[\d.,]*/g) || [];
  if (genNumbers.some(n => !groundedReply.includes(n))) return false;
  // Must retain at least one concrete entity from the grounded facts
  const entities = (groundedReply.match(/\b(AWS|React|JavaScript|TypeScript|Node|Full Sail|Davis|Illinois|junior|intern|certif\w*|project\w*|cloud|web|support|debug\w*|document\w*)\b/gi) || []).map(e => e.toLowerCase());
  if (entities.length > 0 && !entities.some(e => t.toLowerCase().includes(e))) return false;
  // Whitelist check: every proper noun in the generated text must exist in the source.
  // Catches invented employers, schools, and technologies (e.g. "Davis University", "Google Cloud").
  const sourceLower = groundedReply.toLowerCase();
  const capPhrases = t.match(/\b[A-Z][a-zA-Z0-9.+#']*(?:\s+[A-Z][a-zA-Z0-9.+#']*)*\b/g) || [];
  for (const phrase of capPhrases) {
    const words = phrase.split(/\s+/);
    // Multi-word capitalized phrases must exist as a whole phrase in the source
    if (words.length > 1) {
      const filtered = words.filter(w => !GEN_ENTITY_ALLOWLIST.has(w.replace(/[.,']$/, '')));
      if (filtered.length > 1 && !sourceLower.includes(filtered.join(' ').toLowerCase())) return false;
      if (filtered.length === 1 && !GEN_ENTITY_ALLOWLIST.has(filtered[0].replace(/[.,']$/, '')) && !sourceLower.includes(filtered[0].toLowerCase())) return false;
    } else {
      const w = words[0].replace(/[.,']$/, '');
      if (!GEN_ENTITY_ALLOWLIST.has(w) && !sourceLower.includes(w.toLowerCase())) return false;
    }
  }
  // Reject prompt echoes
  if (/^(facts:|q:|question:|answer:|rephrase|text:)/i.test(t)) return false;
  return true;
}

// Cloud provider replies are less likely to hallucinate but more likely to paraphrase
// facts with synonyms (e.g. "Junior Frontend Developer"). This validator keeps the
// slop/false-claim guards while skipping the strict proper-noun whitelist.
function validateNetworkReply(text, source) {
  const t = String(text || '').trim();
  // Allow very short conversational replies ("Yes, he does.") up to longer answers.
  if (t.length < 10 || t.length > 1000) return false;
  if (GEN_FALSE_CLAIMS.test(t)) return false;
  if (GEN_SLOP.test(t)) return false;
  if (GEN_OVERCLAIM.test(t)) return false;
  // Must still be about Bradley, but allow first-person voice ("I'd say he's...").
  if (!/\b(bradley|brad|he|his|him|scout)\b/i.test(t)) return false;
  const sourceText = String(source || '').toLowerCase();
  const genNumbers = t.match(/\d[\d.,]*/g) || [];
  if (genNumbers.some(n => !sourceText.includes(n.toLowerCase()))) return false;
  if (/^(facts:|q:|question:|answer:|rephrase|text:)/i.test(t)) return false;
  // Allow clarifying follow-up questions; only block prompt echoes.
  if (/\?(\s*)$/i.test(t) && /^(what would you like|what do you want|what are you interested|what do you mean|could you clarify|tell me more about|let me know)/i.test(t)) return false;
  // Require only one relevant entity, so simple answers like "He's based in Illinois" pass.
  const entityHits = (t.match(/\b(AWS|React|JavaScript|TypeScript|Node|Next\.js|Full Sail|Davis|Illinois|junior|intern|certif|project|cloud|web|support|debug|document|CIRIS|Pokedex|Lambda|DynamoDB|S3|Amplify|CloudFront|Docker|GitHub|Army|veteran|military|customer|service|team|communicat|reliab|honest|learn|career|role|skill|work|experience|prefer|style|adapt|collaborat|contribut|grow|mentor)\b/gi) || []);
  const uniqueHits = new Set(entityHits.map(e => e.toLowerCase()));
  if (uniqueHits.size < 1) return false;
  // Keep only the most basic hygiene checks.
  if (/\s{2,}/.test(t)) return false;
  return true;
}

// More permissive validator for think mode — allows longer answers and paraphrasing
function validateThinkReply(text, source) {
  const t = String(text || '').trim();
  if (t.length < 25 || t.length > 1200) return { valid: false, reason: 'length' };
  if (GEN_FALSE_CLAIMS.test(t)) return { valid: false, reason: 'false-claims' };
  if (GEN_SLOP.test(t)) return { valid: false, reason: 'slop' };
  if (GEN_OVERCLAIM.test(t)) return { valid: false, reason: 'overclaim' };
  if (!/\b(bradley|brad|he|his)\b/i.test(t)) return { valid: false, reason: 'no-subject' };
  if (/\b(I|I'm|I've|my|we|our)\b/.test(t)) return { valid: false, reason: 'first-person' };
  if (/"|\*|pause|scout here|as scout|hi,|hello,/i.test(t)) return { valid: false, reason: 'meta' };
  const sourceText = String(source || '').toLowerCase();
  const genNumbers = t.match(/\d[\d.,]*/g) || [];
  if (genNumbers.some(n => !sourceText.includes(n.toLowerCase()))) return { valid: false, reason: 'hallucinated-number' };
  if (/^(facts:|q:|question:|answer:|rephrase|text:)/i.test(t)) return { valid: false, reason: 'prefix' };
  if (/\?(\s*)$/i.test(t) && /(what would you like|what do you want|what are you interested|what do you mean|could you clarify|tell me more about|let me know)/i.test(t)) return { valid: false, reason: 'evasive' };
  // Think mode: require at least 1 entity (not 2) — more permissive
  // Expanded entity list to include soft-skill/career terms for think mode learning
  const entityHits = (t.match(/\b(AWS|React|JavaScript|TypeScript|Node|Next\.js|Full Sail|Davis|Illinois|junior|intern|certif|project|cloud|web|support|debug|document|CIRIS|Pokedex|Lambda|DynamoDB|S3|Amplify|CloudFront|Docker|GitHub|Army|veteran|military|customer|service|team|communicat|reliab|honest|gap|weakness|strength|feedback|management|learn|career|role|skill|work|experience|prefer|style|adapt|collaborat|contribut|grow|mentor)\b/gi) || []);
  const uniqueHits = new Set(entityHits.map(e => e.toLowerCase()));
  if (uniqueHits.size < 1 && t.length < 100) return { valid: false, reason: 'no-entities' };
  if (/\b(and|or|but)\s+(way|the|a)\b/i.test(t)) return { valid: false, reason: 'garbled' };
  if (/\s{2,}/.test(t)) return { valid: false, reason: 'double-space' };
  if (/\b\w+\s+and\s*$/i.test(t)) return { valid: false, reason: 'trailing-and' };
  return { valid: true, reason: 'ok', entityCount: uniqueHits.size };
}

// Convert first-person knowledge text to third person for grounded answers
function concisePitch(knowledge) {
  const { identity, summary, goals } = knowledge || {};
  const name = identity?.name || 'Bradley Matera';
  const title = identity?.title || 'junior software engineer';
  const location = (identity?.location || 'Davis, Illinois').replace(/\s*\(open to relocation\)\s*/i, '').trim();
  return `${name} is a ${title} based in ${location}, open to relocation. He has real projects, AWS certifications, and structured internship training. He's open to any entry-level tech, IT, or support role and learns quickly with mentorship.`;
}

function toThirdPerson(text) {
  let out = String(text || '')
    .replace(/\bI am\b/g, 'he is')
    .replace(/\bI'm\b/g, "he's")
    .replace(/\bI have\b/g, 'he has')
    .replace(/\bI've\b/g, "he's")
    .replace(/\bI like\b/g, 'he likes')
    .replace(/\bI learn\b/g, 'he learns')
    .replace(/\bI work\b/g, 'he works')
    .replace(/\bI built\b/g, 'he built')
    .replace(/\bI usually need\b/g, 'he usually needs')
    .replace(/\bI need\b/g, 'he needs')
    .replace(/\bI want\b/g, 'he wants')
    .replace(/\bI can\b/g, 'he can')
    .replace(/\bI can't\b/g, "he can't")
    .replace(/\bI cannot\b/g, 'he cannot')
    .replace(/\bI do\b/g, 'he does')
    .replace(/\bI don't\b/g, "he doesn't")
    .replace(/\bI think\b/g, 'he thinks')
    .replace(/\bI know\b/g, 'he knows')
    .replace(/\bI understand\b/g, 'he understands')
    .replace(/\bI \b/g, 'he ')
    .replace(/\bmy\b/g, 'his')
    .replace(/\bMy\b/g, 'His')
    .replace(/\bme\b/g, 'him')
    .replace(/\b(work|learn|like|build|debug|document|read)\b(?= carefully| quickly| clearly| useful| building)/g, m => m + 's');
  // Fix sentence-start capitalization after replacements
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
  return out;
}

const GEN_ABORT_PATTERNS = [
  /\b(I\b|I'm|I've|my\b|we\b|our\b)/i,
  /\b(great question|as an ai|i'?m glad|excellent opportunity|showcase|enthusiasm|passionate|robust|synergy|leverage|dynamic|world-class|game.?changer)/i,
  /\b(long history|years of experience|many years|several years|seasoned|expert in|expertise|well.?versed|veteran|deep experience|extensive|highly experienced|accomplished|proven track|at the company|this year|last year|currently employed|notable projects across|exceptional|scalable software|highly skilled|mastery|advanced knowledge)/i,
  /\b(senior engineer|senior developer|10\+? years|worked at (google|amazon|meta|microsoft|apple)|fortune 500|production owner|led a team|cto|principal|master'?s|phd|security clearance)/i,
  /"|\*|pause|scout here|as scout|hi,|hello,/i,
  /\b\d{4,}\b/ // invented large numbers
];

function shouldAbortGeneration(text) {
  return GEN_ABORT_PATTERNS.some(p => p.test(text));
}

async function callGenerativeRag(knowledge, question, groundedReply, history, timeoutMs) {
  const chunks = buildRagChunks(knowledge);
  const retrieved = retrieveChunks(question, chunks, 3);
  const facts = retrieved.map(c => truncateWords(c.text, 30)).join(' ');
  const source = toThirdPerson(`${truncateWords(groundedReply.replace(/<[^>]+>/g, ' '), 55)} ${facts}`);
  callGenerativeRag.lastSource = source;

  // Stream the generation and abort as soon as a forbidden pattern appears.
  // This is the "edit while generating" constraint: we stop the model before it
  // wastes time completing a bad answer.
  const agentName = knowledge?.agent?.name || 'Scout';
  const agentPersona = knowledge?.agent?.persona || 'the helpful, honest site assistant';
  const system = `A recruiter is asking about a job candidate named Bradley Matera. You are ${agentName}, ${agentPersona}. You are not Bradley. Answer the recruiter using ONLY this info: ${truncateWords(source, 80)}
Tone and format rules:
- Answer in 1-3 short sentences.
- Third person only (he/his).
- Plain, honest language. No buzzwords.
- Never start with "Certainly", "Absolutely", "Great question", "As an AI", or "I would be happy".
- Never use: leverage, robust, synergy, passionate, world-class, cutting-edge, groundbreaking, extensive expertise, proven leader, deep mastery, dynamic, innovative, exceptional.
- Do not repeat the user's question back.
- Do not end with a sales pitch or vague offer to help.
- If the data is missing, say "I don't see that in the current recruiter data" briefly.
- Never add facts, employers, degrees, or years of experience not listed above.
- Do not describe his AWS work as live production ownership; it was structured labs and a capstone.`;
  const user = truncateWords(question, 40);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || GEN_TIMEOUT_MS);
  let accumulated = '';
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: GEN_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        stream: true,
        keep_alive: '24h',
        options: { temperature: 0.3, top_p: 0.85, num_predict: 70, repeat_penalty: 1.2 }
      })
    });
    if (!res.ok) throw new Error(`gen HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed);
          const content = chunk.message?.content || chunk.response || '';
          if (content) {
            accumulated += content;
            const clean = accumulated.replace(/\s+/g, ' ');
            if (shouldAbortGeneration(clean)) {
              controller.abort();
              throw new Error('aborted: bad pattern detected');
            }
          }
        } catch (e) {
          if (e.message === 'aborted: bad pattern detected') throw e;
          // ignore malformed JSON lines
        }
      }
    }

    return removeSlop(accumulated.replace(/\s+/g, ' ').trim());
  } finally {
    clearTimeout(timeout);
  }
}

// Use local Ollama to rewrite a grounded reply in a more human, conversational way.
// Facts are preserved because the grounded reply is the source; Ollama only rephrases.
async function humanizeGroundedReply(knowledge, groundedReply, question, history) {
  if (!GEN_ENABLED) return null;
  const agentName = knowledge?.agent?.name || 'Scout';
  const system = `You are ${agentName}, a helpful recruiter assistant. Rewrite the provided factual answer into 1-3 short, natural sentences that sound like a real person chatting with a recruiter. Keep every fact exactly as given. Do not add, remove, or change facts. Do not use buzzwords. Third person only. If the answer says data is missing, keep that honest.`;
  const user = `Question: ${question}\nFactual answer: ${groundedReply}\nRewrite naturally:`;

  const controller = new AbortController();
  const HUMANIZE_TIMEOUT_MS = 5000; // don't let humanization dominate latency
  const timeout = setTimeout(() => controller.abort(), HUMANIZE_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: GEN_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        stream: true,
        keep_alive: '24h',
        options: { temperature: 0.4, top_p: 0.85, num_predict: 80, repeat_penalty: 1.2 }
      })
    });
    if (!res.ok) throw new Error(`gen HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed);
          accumulated += chunk.message?.content || chunk.response || '';
        } catch { /* ignore malformed JSON */ }
      }
    }
    let cleaned = removeSlop(accumulated.replace(/\s+/g, ' ').trim());
    cleaned = cleaned.replace(/\b(extensive|extensively)\b/gi, 'solid').replace(/\b(passio(?:n|nate))\b/gi, 'interest');
    // Basic validation: must be about Bradley, not empty, and not introduce slop/overclaim
    const valid = cleaned.length >= 15 &&
      /\b(bradley|brad|he|his|him|scout)\b/i.test(cleaned) &&
      !GEN_SLOP.test(cleaned) &&
      !GEN_OVERCLAIM.test(cleaned);
    if (valid) {
      return cleaned;
    }
  } catch (err) {
    console.log(`humanize failed: ${String(err.message || err).slice(0, 100)}`);
  } finally {
    clearTimeout(timeout);
  }
  return null;
}

async function generateWithNetwork(knowledge, question, history, groundedReply) {
  // Circuit breaker: if the network has been failing consistently, skip it entirely
  // and let the caller fall back to the fast grounded reply.
  if (isNetworkCircuitOpen()) {
    console.log('Network circuit open; skipping provider calls');
    return null;
  }

  // Use the full RAG prompt as the validation source so cloud models can cite
  // any fact from the verified context without being rejected for paraphrasing.
  const sourceText = buildPrompt(knowledge, question, history, 'openai').replace(/\s+/g, ' ').toLowerCase();

  // Global budget for the whole provider loop so a slow Ollama cold start doesn't
  // dominate latency when cloud providers are exhausted.
  const NETWORK_BUDGET_MS = 5000;
  const networkStart = Date.now();

  for (const slug of PROVIDER_ORDER) {
    if (Date.now() - networkStart > NETWORK_BUDGET_MS) {
      console.log('Provider loop exceeded budget; falling back to grounded');
      recordNetworkOutcome(false);
      return null;
    }
    const def = PROVIDER_DEFS[slug];
    if (!def) {
      console.log(`Unknown provider in PROVIDER_ORDER: ${slug}`);
      continue;
    }
    if (!isProviderEnabled(slug) || !isProviderAvailable(slug)) continue;

    recordProviderAttempt(slug);
    const providerStart = Date.now();
    try {
      let raw = '';
      if (def.type === 'openai') {
        raw = await callOpenAICompatibleProvider(def.baseUrl, def.apiKey, def.model, knowledge, question, history);
      } else if (def.type === 'cloudflare') {
        raw = await callCloudflareWorkersAI(def.accountId, def.apiToken, def.model, knowledge, question, history);
      } else if (def.type === 'gemini') {
        raw = await callGeminiWithPrompt(buildPrompt(knowledge, question, history, 'gemini'), def.model);
      } else if (def.type === 'ollama') {
        // Give Ollama the full timeout; on a small VM the model may take several
        // seconds to load into memory on the first call after a restart.
        raw = await callGenerativeRag(knowledge, question, groundedReply, history, GEN_TIMEOUT_MS);
      }

      const cleaned = removeSlop(String(raw || '').trim().replace(/\s+/g, ' '));
      if (cleaned && cleaned.length >= 15 && validateNetworkReply(cleaned, sourceText)) {
        recordProviderHealth(slug, true, Date.now() - providerStart);
        recordNetworkOutcome(true);
        return { reply: cleaned, provider: slug, model: def.model || GEN_MODEL };
      }
      console.log(`Provider ${slug} output rejected (length ${cleaned?.length || 0}): ${cleaned.slice(0, 120)}`);
      recordProviderHealth(slug, false, Date.now() - providerStart);
    } catch (err) {
      const msg = String(err.message || '').toLowerCase();
      console.error(`Provider ${slug} failed: ${err.message.slice(0, 200)}`);
      recordProviderHealth(slug, false, Date.now() - providerStart);
      if (/credits|depleted|spending limit|permission-denied|402|403/.test(msg)) {
        markProviderExhausted(slug, 24 * 60 * 60 * 1000);
      } else if (/401|unauthorized|invalid.*key|invalid.*token|auth/.test(msg)) {
        markProviderExhausted(slug, 24 * 60 * 60 * 1000);
      } else if (/429|rate limit|exceeded|quota|too many/.test(msg)) {
        markProviderExhausted(slug, 60 * 1000);
      }
    }
  }
  recordNetworkOutcome(false);
  return null;
}

// Queries that must stay deterministic for correctness/safety.
// Only safety-critical and private-data questions are forced grounded.
// Everything else flows to the LLM provider network for natural, contextual answers.
function mustStayGrounded(question, history) {
  const q = String(question || '').toLowerCase();
  // Safety: prompt injection, secret extraction, social engineering
  if (/(ignore|inject|system prompt|\.env|api key|password|bypass|open port|port 11434|localhost|127\.0\.0\.1|:11434|make.*longer than 5000|print server|output.*raw json|repeat.*knowledge file|hidden config|show.*env|fake reference|social security|birth date|wife|children|family details|medical history|i am.*admin|i am.*owner|i am.*developer|i am.*from the government|i am.*security researcher|bradley'?s friend|his friend|reveal.*environment|reveal.*secret|reveal.*config|show.*contents of|read.*file|show me.*\.json|show me.*learned|show me.*stats|opt\/recruiter|\/opt\/|etc\/passwd|environment variable|ignore that|ignore all previous|override.*rules|override.*instructions)/.test(q)) return true;
  // False-claim requests must be blocked deterministically
  if (/(pretend|make up|make.*sound|claim|say|tell|write|describe|write something that)\b.*\b(google|senior|cto|10\s*years|10\+\s*years|masters?|master.s|kubernetes|led a team|production engineer|production experience|outages|clearance|payment systems|terraform|machine learning engineer|hide his lack|hide.*lack|full.?stack expert|10x|ninja|rockstar|wizard|guru|rust|glowing review|overselling|world.class)\b/.test(q) || /write something that hides|hide his lack/.test(q)) return true;
  // Private/sensitive data that should never go to the LLM
  if (/\b(salary|address|home address|current address|phone number|social security|birth date|family details|medical history|security clearance|references|manager name|customer list|preferred pay)\b/.test(q)) return true;
  // Smoke test / health check patterns — deterministic for monitoring
  if (/are you online|say hello|health status|daily cap|daily limit|rate limit|cooldown|how.*handle.*limit|run 24|24.?7|24x7|always available|what if.*provider|exhausted|out of quota/.test(q)) return true;
  if (detectBannedWords(question).length > 0) return true;
  // Structured output requests stay grounded for consistent formatting
  const shape = detectShape(question);
  if (shape.json || shape.bullets || shape.table || shape.maxWords || shape.paragraph || shape.oneSentence) return true;
  return false;
}

// Track whether the configured LLM is actually usable so we don't burn latency on dead providers
let llmHealthy = LLM_PROVIDER !== 'ollama'; // ollama on the 1GB VM is treated as garnish only
let llmLastFailAt = 0;
const LLM_RETRY_AFTER_MS = 10 * 60 * 1000;
// ============ PERSISTENT STATS ============
const STATS_FILE = path.join(__dirname, 'stats.json');
const STATS_FLUSH_MS = 5 * 1000; // flush to disk at most every 5s
let statsDirty = false;
let lastStatsFlush = 0;

const defaultStats = {
  totalRequestsAllTime: 0,
  groundedCount: 0,
  llmCount: 0,
  cachedCount: 0,
  providerBreakdown: {},
  deployCount: 0,
  firstDeployAt: 0,
  recentRequests: [], // last 40 {q, provider, ts, referrer, topic, latencyMs, pipeline}
  referrerBreakdown: {}, // { "bradleymatera.dev": 45, "codepen.io": 12 }
  topicBreakdown: {}, // { "2026-07-10": { projects: 12, aws: 8, ... } }
  hourlyRequests: {}, // { "2026-07-10T22": { total: 15, grounded: 8, llm: 5, cached: 2 } }
  lastPipeline: [], // last request's decision path
  sessions: [], // last 50 { id, turns, topics, startedAt, durationSec, referrer, intent }
  providerHealth: {} // { groq: { successes: 45, failures: 3, avgMs: 1200 }, ... }
};

let persistentStats;
try {
  const raw = fs.readFileSync(STATS_FILE, 'utf8');
  persistentStats = { ...defaultStats, ...JSON.parse(raw) };
} catch {
  persistentStats = { ...defaultStats };
}
persistentStats.deployCount = (persistentStats.deployCount || 0) + 1;
if (!persistentStats.firstDeployAt) persistentStats.firstDeployAt = Date.now();
let totalRequestsServed = 0; // this-restart counter
let lastReplyProvider = null;

function classifyTopic(question) {
  const q = String(question || '').toLowerCase();
  if (/project|portfolio|codepen|shipped|github repo/.test(q)) return 'projects';
  if (/aws|cloud|lambda|dynamodb|serverless|certification|cert/.test(q)) return 'aws';
  if (/skill|stack|tech|javascript|typescript|react|node|sql/.test(q)) return 'skills';
  if (/experience|intern|work history|background|ciris|freelance/.test(q)) return 'experience';
  if (/education|degree|school|full sail|gpa|graduat/.test(q)) return 'education';
  if (/contact|email|phone|reach|linkedin/.test(q)) return 'contact';
  if (/role|fit|hire|candidate|job|position|devops|sre|support|qa|data/.test(q)) return 'role-fit';
  if (/strength|strongest|greatest|best at|good at/.test(q)) return 'strengths';
  if (/weakness|weak at|concern|gap|limitation|red flag/.test(q)) return 'weaknesses';
  if (/team|people|interpersonal|social|customer service|communication|collaborat/.test(q)) return 'interpersonal';
  if (/salary|pay|compensation|rate/.test(q)) return 'salary';
  if (/army|military|veteran/.test(q)) return 'army';
  if (/work style|coding style|management style|approach|debug|problem|feedback|preferred/.test(q)) return 'work-style';
  if (/who is brad|tell me about|summary|bio|about brad/.test(q)) return 'summary';
  if (/blog|article|writing|publication|dev\.to|dev community|has he written|what.*he.*write|write about/.test(q)) return 'writing';
  if (/not in|out of scope|favorite|food|pizza|weather|sports/.test(q)) return 'out-of-scope';
  return 'other';
}

function extractReferrer(req) {
  try {
    const raw = String(req.headers['referer'] || req.headers['origin'] || req.headers['referrer'] || '').trim();
    if (!raw) return 'unknown';
    const url = new URL(raw);
    return url.hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}

function detectVisitorIntent(question, history) {
  const q = String(question || '').toLowerCase();
  const turns = Array.isArray(history) ? history.length : 0;
  // Recruiter: asks about role fit, experience, skills, gaps
  if (/\b(fit|hire|candidate|role|job|position|experience|skill|gap|concern|weakness|strength|interview|recruiter|resume)\b/.test(q)) return 'recruiter';
  // Casual: asks "what is this", "who is brad"
  if (/^(hey|hi|hello|yo|sup|what is this|who is|what does this do|what can you)/.test(q) && turns === 0) return 'casual';
  // Bot/scanner: rapid identical questions or very short generic queries
  if (turns === 0 && q.length < 10 && /^(test|hello|hi|ping|test123)/.test(q)) return 'bot';
  // Returning: has history
  if (turns >= 2) return 'engaged';
  return 'visitor';
}

// In-memory session tracking (not persisted per-request for performance)
const activeSessions = new Map();

function trackSession(sessionId, question, provider, referrer, intent) {
  if (!sessionId) return;
  if (!activeSessions.has(sessionId)) {
    activeSessions.set(sessionId, {
      id: sessionId, turns: 0, topics: [], startedAt: Date.now(),
      referrer, intent, lastActiveAt: Date.now()
    });
  }
  const sess = activeSessions.get(sessionId);
  sess.turns++;
  sess.lastActiveAt = Date.now();
  const topic = classifyTopic(question);
  if (!sess.topics.includes(topic)) sess.topics.push(topic);
  sess.intent = intent;

  // Prune stale sessions (inactive > 30 min)
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, s] of activeSessions) {
    if (s.lastActiveAt < cutoff) activeSessions.delete(id);
  }
}

function getRecentSessions() {
  return Array.from(activeSessions.values())
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, 20)
    .map(s => ({
      id: s.id.slice(0, 12) + '…',
      turns: s.turns,
      topics: s.topics.slice(0, 5),
      startedAt: s.startedAt,
      durationSec: Math.round((s.lastActiveAt - s.startedAt) / 1000),
      referrer: s.referrer,
      intent: s.intent
    }));
}

function recordProviderHealth(slug, success, latencyMs) {
  if (!persistentStats.providerHealth[slug]) {
    persistentStats.providerHealth[slug] = { successes: 0, failures: 0, avgMs: 0, totalMs: 0 };
  }
  const h = persistentStats.providerHealth[slug];
  if (success) {
    h.successes++;
    h.totalMs += latencyMs || 0;
    h.avgMs = Math.round(h.totalMs / h.successes);
  } else {
    h.failures++;
  }
  statsDirty = true;
}

function recordRequest(question, provider, opts = {}) {
  totalRequestsServed++;
  persistentStats.totalRequestsAllTime++;
  if (provider === 'grounded' || provider === 'learned') persistentStats.groundedCount++;
  else if (provider === 'cached') persistentStats.cachedCount++;
  else persistentStats.llmCount++;
  persistentStats.providerBreakdown[provider] = (persistentStats.providerBreakdown[provider] || 0) + 1;

  // Topic classification
  const topic = classifyTopic(question);
  const today = new Date().toISOString().slice(0, 10);
  if (!persistentStats.topicBreakdown[today]) persistentStats.topicBreakdown[today] = {};
  persistentStats.topicBreakdown[today][topic] = (persistentStats.topicBreakdown[today][topic] || 0) + 1;

  // Hourly tracking
  const hourKey = new Date().toISOString().slice(0, 13); // "2026-07-10T22"
  if (!persistentStats.hourlyRequests[hourKey]) persistentStats.hourlyRequests[hourKey] = { total: 0, grounded: 0, llm: 0, cached: 0 };
  persistentStats.hourlyRequests[hourKey].total++;
  if (provider === 'grounded' || provider === 'learned') persistentStats.hourlyRequests[hourKey].grounded++;
  else if (provider === 'cached') persistentStats.hourlyRequests[hourKey].cached++;
  else persistentStats.hourlyRequests[hourKey].llm++;

  // Referrer tracking
  const referrer = opts.referrer || 'unknown';
  persistentStats.referrerBreakdown[referrer] = (persistentStats.referrerBreakdown[referrer] || 0) + 1;

  // Pipeline tracking
  const pipeline = opts.pipeline || [];
  if (pipeline.length > 0) persistentStats.lastPipeline = pipeline;

  // Enhanced recent requests
  persistentStats.recentRequests.unshift({
    q: String(question).slice(0, 80),
    provider, ts: Date.now(),
    referrer,
    topic,
    latencyMs: opts.latencyMs || null,
    pipeline: pipeline.length > 0 ? pipeline : undefined
  });
  if (persistentStats.recentRequests.length > 40) persistentStats.recentRequests.pop();

  // Clean up old hourly data (keep last 48h)
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 13);
  for (const key of Object.keys(persistentStats.hourlyRequests)) {
    if (key < cutoff) delete persistentStats.hourlyRequests[key];
  }
  // Clean old topic data (keep last 30 days)
  const topicCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const key of Object.keys(persistentStats.topicBreakdown)) {
    if (key < topicCutoff) delete persistentStats.topicBreakdown[key];
  }

  statsDirty = true;
  const now = Date.now();
  if (statsDirty && now - lastStatsFlush > STATS_FLUSH_MS) {
    flushStats();
  }
}

function flushStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(persistentStats, null, 2));
    statsDirty = false;
    lastStatsFlush = Date.now();
  } catch (e) {
    console.error('Failed to flush stats:', e.message);
  }
}

// ============ ANSWER QUALITY SCORING ============

function scoreAnswer(reply, question, knowledge) {
  if (!reply || reply.length < 10) return 0;
  let score = 0;
  const r = reply.toLowerCase();
  const q = String(question || '').toLowerCase();
  // Length scoring: 50-400 chars is ideal
  if (reply.length >= 50 && reply.length <= 400) score += 25;
  else if (reply.length >= 30 && reply.length <= 600) score += 15;
  else if (reply.length < 30) score += 5;
  // Concrete entities
  const entities = (r.match(/\b(AWS|React|JavaScript|TypeScript|Node|Next\.js|Full Sail|Davis|Illinois|junior|intern|certif|project|cloud|web|support|debug|document|CIRIS|Pokedex|Lambda|DynamoDB|S3|Amplify|CloudFront|Docker|GitHub|Army|veteran|customer|service|team)\b/gi) || []);
  score += Math.min(entities.length * 5, 20);
  // Penalize "not in the data" — it's a non-answer
  if (r.includes('not in') && r.includes('recruiter data')) score -= 30;
  // Penalize generic summary for non-summary questions
  if (/is a junior software engineer based in davis/.test(r) && !/summar|bio|who is|elevator|pitch/.test(q)) score -= 20;
  // Penalize slop
  if (GEN_SLOP.test(r)) score -= 15;
  if (GEN_OVERCLAIM.test(r)) score -= 25;
  // Reward answering the specific question
  const topic = classifyTopic(question);
  const topicKeywords = {
    aws: ['aws', 'cloud', 'lambda', 'dynamodb', 's3', 'certif'],
    projects: ['project', 'pokedex', 'hub', 'build', 'portfolio'],
    skills: ['skill', 'javascript', 'react', 'typescript', 'node', 'debug'],
    experience: ['experience', 'ciris', 'intern', 'work', 'army'],
    education: ['education', 'degree', 'school', 'gpa', 'full sail'],
    strengths: ['strength', 'good at', 'strong'],
    weaknesses: ['weakness', 'gap', 'honest', 'concern'],
    interpersonal: ['people', 'team', 'communicat', 'customer', 'social'],
    'role-fit': ['fit', 'role', 'candidate', 'hire', 'position']
  };
  const expected = topicKeywords[topic] || [];
  if (expected.length > 0 && expected.some(kw => r.includes(kw))) score += 20;
  // Penalize too-short or too-long
  if (reply.length < 30) score -= 10;
  if (reply.length > 800) score -= 10;
  return Math.max(0, Math.min(100, score));
}

// ============ LEARNING FUNCTIONS ============

// Tone/style requests that are NOT knowledge gaps — don't stash these
const TONE_REQUEST_RE = /no corporate|without buzzwords|just answer|be direct|say it in one|summarize like a normal|answer the question directly|stop avoiding|no bs|straight answer|plain (english|paragraph|language)|like a normal person|in plain|talk like a|normal tone|less formal|more casual|stop being so|tone|buzzword|corporate tone/;

function isWeakAnswer(reply, question, provider) {
  if (!reply) return false;
  const r = reply.toLowerCase();
  const q = String(question).toLowerCase();
  const qTrim = q.trim();
  if (TONE_REQUEST_RE.test(q)) return false;
  if (qTrim.length < 8 || qTrim.split(/\s+/).length < 2) return false;
  if (!isProbablyRelevant(question) && !/brad|matera|recruit|job|role|skill|project|portfolio|contact|email|phone|cert|education|degree|aws|cloud|react|javascript|typescript|intern|experience|hire|candidate/.test(q)) return false;
  if (/\b(json|table|bullet|words?|characters?|one sentence|yes or no)\b/i.test(q)) return false;
  const topic = classifyTopic(question);
  if (topic === 'summary' || topic === 'strengths' || topic === 'contact' || topic === 'education') return false;
  if (r.includes("not in") && r.includes("recruiter data") && isProbablyRelevant(question)) return true;
  if (provider === 'grounded' && /is a junior software engineer based in davis/.test(r)
      && !/strength|weakness|cert|project|experience|contact|role|fit|aws|cloud|react|debug|learn|team|reliab|communicat|coding|problem|work style|different|legit|worth|honest|no bs|straight|summar|bio|who is|elevator|pitch|20 second/i.test(question)) return true;
  if (reply.length < 40 && !/yes|no/i.test(reply) && qTrim.split(/\s+/).length >= 3) return true;
  return false;
}

function stashQuestion(question, reply, provider) {
  const norm = normalizeQuestion(question);
  if (learnedData.stashed.some(s => s.q === norm)) return;
  if (learnedData.learned.some(l => l.q === norm)) return;
  const lower = String(question).toLowerCase();
  const lowerTrim = lower.trim();
  if (/(ignore|inject|system prompt|\.env|api key|password|hack|bypass|social security|birth date)/.test(lower)) return;
  // Don't stash false-claim requests (same regex as buildGroundedFallbackPayload)
  if (/(pretend|make up|claim|say|tell|write|describe)\b.*\b(google|senior|cto|10 years|10\+ years|masters?|master.s|kubernetes|led a team|production engineer|production experience|outages|clearance|fortune|payment systems|startup|papers|hackathons|l4|azure|dba|machine learning engineer|rust|full.?stack expert|10x|ninja|rockstar|wizard|guru|glowing review|overselling|world.class)/.test(lower)) return;
  if (/write something that hides|hide his lack/.test(lower)) return;
  if (question.length < 5 || question.length > 500) return;
  // Don't stash tone/style requests
  if (TONE_REQUEST_RE.test(lower)) return;
  // Don't stash one-word or very short questions
  if (lowerTrim.length < 8 || lowerTrim.split(/\s+/).length < 2) return;
  // Don't stash out-of-scope questions
  if (!isProbablyRelevant(question) && !/brad|matera|recruit|job|role|skill|project|portfolio|contact|email|phone|cert|education|degree|aws|cloud|react|javascript|typescript|intern|experience|hire|candidate/.test(lower)) return;
  // Don't stash format/shape requests
  if (/\b(json|table|bullet|words?|characters?|one sentence|yes or no)\b/i.test(lower)) return;
  learnedData.stashed.push({
    q: norm, original: String(question).slice(0, 200),
    badReply: String(reply).slice(0, 300), provider, ts: Date.now(), retries: 0
  });
  if (learnedData.stashed.length > 100) learnedData.stashed.shift();
  saveLearned();
  console.log(`[learn] Stashed: "${norm}" (${learnedData.stashed.length} pending)`);
}

function getLearnedAnswer(question) {
  const norm = normalizeQuestion(question);
  const found = learnedData.learned.find(l => l.q === norm);
  if (found) return found.a;
  if (norm.length >= 10) {
    const partial = learnedData.learned.find(l => l.q.includes(norm) || norm.includes(l.q));
    if (partial) return partial.a;
  }
  return null;
}

async function pushLearnedToGitHub() {
  if (!GITHUB_API_TOKEN || GITHUB_API_TOKEN.length < 10) {
    console.log('[think] No GitHub token, skipping push');
    return false;
  }
  if (learnedData.learned.length === 0) return false;
  try {
    // Get current file SHA
    const metaRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${GITHUB_KNOWLEDGE_PATH}`,
      { headers: { 'Authorization': `Bearer ${GITHUB_API_TOKEN}`, 'Accept': 'application/vnd.github+json' } }
    );
    if (!metaRes.ok) { console.error('[think] GitHub API meta failed:', metaRes.status); return false; }
    const meta = await metaRes.json();
    const sha = meta.sha;
    const currentContent = Buffer.from(meta.content, 'base64').toString('utf8');
    const knowledge = JSON.parse(currentContent);

    // Add learned Q&A to a learnedAnswers array in the knowledge JSON
    if (!knowledge.learnedAnswers) knowledge.learnedAnswers = [];
    let added = 0;
    for (const item of learnedData.learned) {
      const exists = knowledge.learnedAnswers.some(a => a.q === item.q);
      if (!exists) {
        knowledge.learnedAnswers.push({ q: item.q, a: item.a, learnedAt: item.learnedAt });
        added++;
      }
    }
    if (added === 0) { console.log('[think] No new answers to push'); return true; }

    // Push updated content
    const newContent = Buffer.from(JSON.stringify(knowledge, null, 2)).toString('base64');
    const pushRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${GITHUB_KNOWLEDGE_PATH}`,
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${GITHUB_API_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Scout learned ${added} new answer(s) via think mode`,
          content: newContent,
          sha
        })
      }
    );
    if (pushRes.ok) {
      console.log(`[think] Pushed ${added} learned answers to GitHub`);
      // Move scored answers to history before clearing
      for (const l of learnedData.learned) {
        learnedData.scoredHistory.push({ q: l.q, score: l.score, groundedScore: l.groundedScore, provider: l.provider, learnedAt: l.learnedAt });
      }
      if (learnedData.scoredHistory.length > 50) learnedData.scoredHistory = learnedData.scoredHistory.slice(-50);
      // Clear learned queue since they're now in the canonical knowledge
      learnedData.learned = [];
      saveLearned();
      // Force knowledge cache refresh
      knowledgeCacheAt = 0;
      return true;
    } else {
      console.error('[think] GitHub push failed:', pushRes.status);
      return false;
    }
  } catch (e) {
    console.error('[think] pushLearnedToGitHub error:', e.message);
    return false;
  }
}

async function runThinkMode() {
  if (thinkRunning) return { skipped: 'already running' };
  // Clean stale stashes (older than 24h) and tone requests
  const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const before = learnedData.stashed.length;
  learnedData.stashed = learnedData.stashed.filter(s =>
    s.ts > staleCutoff && !TONE_REQUEST_RE.test(s.q) && (s.retries || 0) < 5
  );
  if (learnedData.stashed.length < before) {
    console.log(`[think] Cleaned ${before - learnedData.stashed.length} stale/tone stashes`);
    saveLearned();
  }
  if (learnedData.stashed.length === 0) return { skipped: 'no stashed questions' };
  thinkRunning = true;
  const results = { processed: 0, learned: 0, failed: 0, pushed: false, rejections: [] };
  console.log(`[think] Processing ${learnedData.stashed.length} stashed questions`);
  try {
    const knowledge = await fetchKnowledge();
    if (!knowledge) { return { ...results, skipped: 'no knowledge' }; }
    const batch = learnedData.stashed.splice(0, 5);
    results.processed = batch.length;
    for (const item of batch) {
      try {
        const question = item.original;
        const groundedReply = buildGroundedFallbackPayload(knowledge, question, []).reply;
        const groundedScore = scoreAnswer(groundedReply, question, knowledge);
        const sourceText = buildPrompt(knowledge, question, [], 'openai').replace(/\s+/g, ' ').toLowerCase();
        let bestReply = null;
        let bestProvider = null;
        let bestScore = 0;
        let bestEntityCount = 0;
        let availableProviders = 0;
        let exhaustedProviders = 0;
        for (const slug of PROVIDER_ORDER) {
          const def = PROVIDER_DEFS[slug];
          if (!def) continue;
          if (!isProviderEnabled(slug) || !isProviderAvailable(slug)) { exhaustedProviders++; continue; }
          availableProviders++;
          try {
            let raw = '';
            if (def.type === 'openai') {
              raw = await callOpenAICompatibleProvider(def.baseUrl, def.apiKey, def.model, knowledge, question, []);
            } else if (def.type === 'cloudflare') {
              raw = await callCloudflareWorkersAI(def.accountId, def.apiToken, def.model, knowledge, question, []);
            } else if (def.type === 'gemini') {
              raw = await callGeminiWithPrompt(buildPrompt(knowledge, question, [], 'gemini'), def.model);
            } else if (def.type === 'ollama') {
              raw = await callGenerativeRag(knowledge, question, groundedReply, [], Math.min(GEN_TIMEOUT_MS, 8000));
            }
            const cleaned = removeSlop(String(raw || '').trim().replace(/\s+/g, ' '));
            if (!cleaned || cleaned.length < 25) {
              console.log(`[think] ${slug} pre-filter: too short (${cleaned.length} chars) for "${item.q.slice(0, 40)}"`);
              continue;
            }
            if (/OUT_OF_SCOPE/i.test(cleaned)) {
              console.log(`[think] ${slug} pre-filter: OUT_OF_SCOPE for "${item.q.slice(0, 40)}"`);
              continue;
            }
            const validation = validateThinkReply(cleaned, sourceText);
            if (validation.valid) {
              const score = scoreAnswer(cleaned, question, knowledge);
              if (score > bestScore) {
                bestReply = cleaned;
                bestProvider = slug;
                bestScore = score;
                bestEntityCount = validation.entityCount;
              }
            } else {
              results.rejections.push({ provider: slug, reason: validation.reason, length: cleaned.length });
              console.log(`[think] ${slug} rejected: ${validation.reason} (len ${cleaned.length}) for "${item.q.slice(0, 40)}"`);
            }
          } catch (e) {
            console.log(`[think] ${slug} error: ${String(e.message || e).slice(0, 80)} for "${item.q.slice(0, 40)}"`);
          }
        }
        if (availableProviders === 0) {
          console.log(`[think] No available providers (${exhaustedProviders} exhausted) for "${item.q.slice(0, 40)}" — re-stashing`);
        }
        // A/B comparison: only accept if learned answer is better than grounded by 5+ points
        if (bestReply && bestScore >= groundedScore + 5) {
          learnedData.learned.push({
            q: item.q, original: item.original, a: bestReply,
            provider: bestProvider, learnedAt: Date.now(),
            score: bestScore, groundedScore, entityCount: bestEntityCount
          });
          learnedData.learnedCount = (learnedData.learnedCount || 0) + 1;
          results.learned++;
          console.log(`[think] Learned: "${item.q}" via ${bestProvider} (score ${bestScore} vs grounded ${groundedScore})`);
        } else if (bestReply && bestScore > groundedScore) {
          // Close call — re-stash for another attempt with a different provider set
          item.retries = (item.retries || 0) + 1;
          learnedData.stashed.push(item);
          results.failed++;
          console.log(`[think] Close call for "${item.q}": score ${bestScore} vs grounded ${groundedScore}, re-stashing (retry ${item.retries})`);
        } else {
          // No improvement or no valid reply — re-stash with retry count
          item.retries = (item.retries || 0) + 1;
          if (item.retries < 5) {
            learnedData.stashed.push(item);
          } else {
            console.log(`[think] Dropping "${item.q}" after 5 failed attempts`);
          }
          results.failed++;
        }
      } catch (e) { console.log(`[think] Error processing "${item.q.slice(0, 40)}": ${String(e.message || e).slice(0, 100)}`); results.failed++; }
    }
    learnedData.lastThinkAt = Date.now();
    saveLearned();
    // Try pushing to GitHub
    if (results.learned > 0) {
      results.pushed = await pushLearnedToGitHub();
    }
  } finally {
    thinkRunning = false;
  }
  console.log(`[think] Done: ${results.learned} learned, ${results.failed} failed, pushed=${results.pushed}`);
  return results;
}

// Track provider recovery for auto-triggering think mode
let lastThinkTriggerCheck = 0;
function checkProviderRecoveryAndTriggerThink() {
  const now = Date.now();
  if (now - lastThinkTriggerCheck < 60 * 1000) return; // Check at most once per minute
  lastThinkTriggerCheck = now;
  if (thinkRunning || learnedData.stashed.length === 0) return;
  // Check if any provider recently recovered from exhaustion
  for (const slug of PROVIDER_ORDER) {
    const state = getProviderState(slug);
    if (state.exhaustedUntil > 0 && state.exhaustedUntil < now && state.exhaustedUntil > now - 120 * 1000) {
      // Provider recovered in the last 2 minutes — trigger think mode
      console.log(`[think] Provider ${slug} recovered, auto-triggering think mode`);
      state.exhaustedUntil = 0; // Clear the flag
      runThinkMode().catch(e => console.error('[think] Auto-trigger error:', e.message));
      return;
    }
  }
}

// Background think interval + provider recovery check
setInterval(() => { runThinkMode().catch(e => console.error('[think] Error:', e.message)); }, THINK_INTERVAL_MS);
setInterval(() => { checkProviderRecoveryAndTriggerThink(); }, 60 * 1000);

// Flush on graceful shutdown
process.on('SIGTERM', () => { flushStats(); process.exit(0); });
process.on('SIGINT', () => { flushStats(); process.exit(0); });

app.post('/api/chat', async (req, res) => {
  let userMessage = '';
  const reqStart = Date.now();
  const referrer = extractReferrer(req);
  const pipeline = [];
  try {
    userMessage = String(req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'Missing message.' });
    if (userMessage.length > 600) return res.status(400).json({ error: 'Message is too long.' });

    const history = Array.isArray(req.body.history) ? req.body.history : [];
    const hasHistory = history.length > 0;
    const cacheKey = normalizeQuestion(userMessage);
    const cached = !hasHistory ? responseCache.get(cacheKey) : null;
    if (cached && (Date.now() - cached.ts) < RESPONSE_CACHE_MS) {
      pipeline.push('cache-hit');
      lastReplyProvider = cached.payload.provider || 'cached';
      recordRequest(userMessage, 'cached', { referrer, pipeline, latencyMs: Date.now() - reqStart });
      return res.json({ ...cached.payload, cached: true, pipeline });
    }
    pipeline.push('cache-miss');

    const knowledge = await fetchKnowledge();
    if (!knowledge) {
      pipeline.push('knowledge-unavailable', 'grounded-fallback');
      const payload = { ...buildGroundedFallbackPayload({}, userMessage, history), provider: 'grounded', fallback: true, pipeline };
      lastReplyProvider = 'grounded';
      recordRequest(userMessage, 'grounded', { referrer, pipeline, latencyMs: Date.now() - reqStart });
      return res.json(payload);
    }
    pipeline.push('knowledge-loaded');

    // 1. Check learned answers first (from think mode)
    const learnedAns = getLearnedAnswer(userMessage);
    pipeline.push(`learned-check:${learnedAns ? 'hit' : 'miss'}`);
    // 1b. Grounded deterministic answer is always computed first
    const grounded = buildGroundedFallbackPayload(knowledge, userMessage, history);
    let reply = learnedAns || grounded.reply;
    let provider = learnedAns ? 'learned' : 'grounded';
    let model = learnedAns ? 'think-mode' : 'knowledge-json';

    // 2. Try the free multi-provider network if the question isn't forced to stay grounded.
    //    The network walks xAI -> Groq -> Cloudflare -> GitHub -> Gemini -> local Ollama,
    //    validating each reply and falling back to the grounded answer if none succeed.
    let generated = false;
    if (!mustStayGrounded(userMessage, history)) {
      pipeline.push('mustStayGrounded:false');
      const networkResult = await generateWithNetwork(knowledge, userMessage, history, grounded.reply);
      if (networkResult) {
        pipeline.push(`network:${networkResult.provider}:success`);
        reply = networkResult.reply;
        provider = networkResult.provider;
        model = networkResult.model;
        generated = true;
      } else {
        pipeline.push('network:all-failed', 'grounded-fallback');
      }
    } else {
      pipeline.push('mustStayGrounded:true');
    }

    // 2b. Apply context-aware wrapping to grounded replies (avoid blind repetition)
    if (!generated && provider === 'grounded') {
      reply = buildContextualGroundedReply(reply, userMessage, history);
    }

    // 2c. Humanize grounded replies with local Ollama so fallback sounds natural.
    //     DISABLED: the smollm2:135m model on the small VM is currently producing
    //     off-topic answers (e.g., confusing 'helpdesk role' with 'AI helpdesk').
    //     We keep the function but don't use it until a more reliable model or
    //     validation layer is in place.
    if (false && !generated && provider === 'grounded' && GEN_ENABLED && !isNetworkCircuitOpen() && !mustStayGrounded(userMessage, history)) {
      const topic = classifyTopic(userMessage);
      const safeToHumanize = !['out-of-scope', 'salary'].includes(topic);
      if (safeToHumanize) {
        const humanized = await humanizeGroundedReply(knowledge, reply, userMessage, history);
        if (humanized) {
          reply = humanized;
          provider = 'ollama';
          model = GEN_MODEL;
          pipeline.push('humanized');
        }
      }
    }

    // 3. Deterministic format compliance (one sentence, bullets, JSON, word caps, tone controls)
    reply = shapeReply(reply, userMessage, knowledge);
    pipeline.push('shaped');

    // 3b. Frustration detection — switch to ultra-direct mode
    const frustrationPatterns = /not making sense|makes no sense|just answer|why can't you|you.?re not|stop avoiding|answer the question|just tell me|be direct/;
    if (frustrationPatterns.test(userMessage.toLowerCase())) {
      pipeline.push('frustration-detected');
      // Strip any preamble or suggestions — just give the answer
      reply = reply.replace(/^(sorry|apolog|my bad)[^.]*\.\s*/i, '').replace(/\s*(ask me about|try asking|you can also ask).*$/i, '').trim();
    }

    // 3c. Generate contextual follow-up suggestions
    const topic = classifyTopic(userMessage);
    const followUpMap = {
      'projects': ['What tech stack does he use?', 'Which project is most relevant to my role?'],
      'aws': ['What about his AWS certifications?', 'Did he do real production work at AWS?'],
      'skills': ['What are his strongest skills?', 'How does he debug issues?'],
      'experience': ['What did he do at CIRIS?', 'Tell me about his AWS internship', 'What did he do at Mason County Kitten Rescue?', 'Tell me about his Army service'],
      'education': ['What was his GPA?', 'What coursework is relevant?'],
      'contact': ['Does he have a LinkedIn?', 'What roles is he targeting?'],
      'role-fit': ['Is he a fit for a junior web role?', 'What are his honest gaps?'],
      'strengths': ['What are his weaknesses?', 'Can you give an example?'],
      'weaknesses': ['What are his strengths?', 'Is he a good fit for a support role?'],
      'interpersonal': ['Does he have customer service experience?', 'How does he handle conflict?'],
      'work-style': ['Does he write documentation?', 'How does he handle unfamiliar code?'],
      'writing': ['What topics does he write about?', 'Where does he publish?', 'Has he written about AWS?'],
      'summary': ['What are his strongest skills?', 'What projects should I look at first?']
    };
    const followUps = followUpMap[topic] || [];

    const payload = { reply, provider, model, fallback: false, grounded: provider === 'grounded', pipeline, followUps };
    if (!hasHistory) {
      responseCache.set(cacheKey, { ts: Date.now(), payload });
      if (responseCache.size > RESPONSE_CACHE_LIMIT) {
        responseCache.delete(responseCache.keys().next().value);
      }
    }

    lastReplyProvider = payload.provider;
    const intent = detectVisitorIntent(userMessage, history);
    const sessionId = req.body.sessionId || '';
    trackSession(sessionId, userMessage, payload.provider, referrer, intent);
    recordRequest(userMessage, payload.provider, { referrer, pipeline, latencyMs: Date.now() - reqStart });
    // Stash weak answers for think mode learning
    if (isWeakAnswer(reply, userMessage, provider)) {
      stashQuestion(userMessage, reply, provider);
    }
    return res.json(payload);
  } catch (err) {
    console.error('Chat error:', err);
    pipeline.push('error');
    const knowledge = knowledgeCache || {};
    const grounded = buildGroundedFallbackPayload(knowledge, userMessage, []);
    lastReplyProvider = 'grounded';
    recordRequest(userMessage, 'grounded', { referrer, pipeline, latencyMs: Date.now() - reqStart });
    return res.json({ reply: grounded.reply, provider: 'grounded', model: 'knowledge-json', fallback: true, pipeline });
  }
});

// Flush stats after each request if dirty
app.use((req, res, next) => { if (statsDirty) flushStats(); next(); });

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Recruiter chat API running on http://127.0.0.1:${PORT} with Ollama backend`);
  // Pre-warm knowledge cache in background (non-blocking)
  setTimeout(() => {
    fetchKnowledge().then(() => console.log('Knowledge cache pre-warmed')).catch(e => console.log('Pre-warm failed:', e.message));
  }, 100);
  // Ping Ollama to start loading the model into memory early
  if (GEN_ENABLED) {
    setTimeout(() => {
      fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' })
        .then(r => r.ok ? console.log('Ollama is reachable') : console.log('Ollama ping returned', r.status))
        .catch(e => console.log('Ollama ping failed:', e.message));
    }, 2000);
  }
});
