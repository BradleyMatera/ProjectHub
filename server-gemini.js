require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const { CostLedger } = require('./lib/cost-ledger');
const { buildRagChunks } = require('./lib/rag-chunks');
const { BM25Index } = require('./lib/bm25');
const { understandQuery } = require('./lib/query-understanding');
const { executeAgentTool, getAgentToolDefinitions, selectAgentToolNames } = require('./lib/agent-tools');
const { buildDeterministicAgentResult, parseLocalStyleResponse, shouldUseDeterministicAgent } = require('./lib/agent-fallback');
const { buildLocalConversationMemory, extractCompleteSentences, validateLocalConversationReply } = require('./lib/local-conversation');

const app = express();

// ============ COST LEDGER ============
// Metering-grade tracker for every billable-adjacent event. Dev-first feature:
// enable with COST_TRACKER=true. Recording is near-free; the /api/costs
// endpoint is only exposed when the flag is on.
const COST_TRACKER = process.env.COST_TRACKER === 'true';
const COST_FILE = path.join(__dirname, process.env.COST_FILE || 'costs.json');
let costLedger = null;
try {
  costLedger = new CostLedger({ stateFile: COST_TRACKER ? COST_FILE : null });
} catch (e) {
  console.error('[cost-ledger] init failed, metering disabled:', e.message);
}
function meterEvent(event) {
  if (!costLedger) return;
  try { costLedger.record(event); } catch { /* metering must never break requests */ }
}

// Meter response bytes so the free VM's network usage remains observable.
app.use((req, res, next) => {
  if (!costLedger) return next();
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  let bytes = 0;
  res.write = (chunk, ...args) => { if (chunk) bytes += Buffer.byteLength(chunk); return origWrite(chunk, ...args); };
  res.end = (chunk, ...args) => {
    if (chunk) bytes += Buffer.byteLength(chunk);
    meterEvent({ source: 'gcp-egress', kind: 'egress', bytes, meta: { route: req.path } });
    return origEnd(chunk, ...args);
  };
  next();
});

const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
const OLLAMA_AGENT_ENABLED = process.env.OLLAMA_AGENT_ENABLED === 'true';
const OLLAMA_AGENT_MODEL = process.env.OLLAMA_AGENT_MODEL || OLLAMA_MODEL;
const OLLAMA_AGENT_TIMEOUT_MS = Math.max(1000, Math.min(parseInt(process.env.OLLAMA_AGENT_TIMEOUT_MS || '2500', 10), 5000));
const OLLAMA_AGENT_CONTEXT = Math.max(512, Math.min(parseInt(process.env.OLLAMA_AGENT_CONTEXT || '1536', 10), 4096));
const OLLAMA_AGENT_KEEP_ALIVE_RAW = process.env.OLLAMA_AGENT_KEEP_ALIVE || '-1';
const OLLAMA_AGENT_KEEP_ALIVE = /^-?\d+$/.test(OLLAMA_AGENT_KEEP_ALIVE_RAW)
  ? Number(OLLAMA_AGENT_KEEP_ALIVE_RAW)
  : OLLAMA_AGENT_KEEP_ALIVE_RAW;

const AGENT_ENABLED = process.env.AGENT_ENABLED !== 'false';
const FEATURE_PREVIEW_ENABLED = process.env.FEATURE_PREVIEW_ENABLED === 'true';
const KNOWLEDGE_FILE = path.join(__dirname, process.env.KNOWLEDGE_FILE || 'data/recruiter-knowledge.json');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://bradleymatera.dev,https://www.bradleymatera.dev,https://bradleymatera.github.io').split(',').map(s => s.trim()).filter(Boolean);

let knowledgeCache = null;
let knowledgeCacheAt = 0;
let bm25Index = null;
let ragChunks = null;
const KNOWLEDGE_CACHE_MS = 15 * 60 * 1000;
const USE_BM25_RETRIEVAL = process.env.USE_BM25_RETRIEVAL !== 'false';
const RESPONSE_CACHE_MS = 30 * 60 * 1000; // 30 min — more cache hits = fewer LLM calls
const RESPONSE_CACHE_LIMIT = 200;
const responseCache = new Map();

// ============ LEARNING SYSTEM ============
const LEARNED_FILE = path.join(__dirname, process.env.LEARNED_FILE || 'learned.json');
const THINK_INTERVAL_MS = 20 * 60 * 1000;
let thinkRunning = false;
let lastChatActivityAt = 0;
const THINK_IDLE_MS = 60 * 1000;

// Tone/style requests that are NOT knowledge gaps — don't stash these
const TONE_REQUEST_RE = /no corporate|without buzzwords|just answer|be direct|say it in one|summarize like a normal|answer the question directly|stop avoiding|no bs|straight answer|plain (english|paragraph|language)|like a normal person|in plain|talk like a|normal tone|less formal|more casual|stop being so|tone|buzzword|corporate tone/;

const defaultLearned = { stashed: [], learned: [], learnedCount: 0, lastThinkAt: 0, scoredHistory: [] };
let learnedData;
try {
  const raw = fs.readFileSync(LEARNED_FILE, 'utf8');
  learnedData = { ...defaultLearned, ...JSON.parse(raw) };
} catch {
  learnedData = { ...defaultLearned };
}
const sanitizeLearnedRecord = item => ({
  ...item,
  provider: item?.provider === 'ollama' ? 'ollama' : 'local-retained',
  judgment: item?.judgment ? { ...item.judgment, provider: 'ollama' } : item?.judgment
});
learnedData.learned = (learnedData.learned || []).map(sanitizeLearnedRecord);
learnedData.scoredHistory = (learnedData.scoredHistory || []).map(sanitizeLearnedRecord);

// Startup stash cleanup: remove stale (24h+) and tone/style entries
{
  const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const before = learnedData.stashed.length;
  learnedData.stashed = learnedData.stashed.filter(s =>
    s.ts > staleCutoff && !TONE_REQUEST_RE.test(s.q) && (s.retries || 0) < 5
  );
  if (learnedData.stashed.length < before) {
    console.log(`[startup] Cleaned ${before - learnedData.stashed.length} stale/tone stashes`);
    try { fs.writeFileSync(LEARNED_FILE, JSON.stringify(learnedData, null, 2)); } catch {}
  }
}

function saveLearned() {
  try { fs.writeFileSync(LEARNED_FILE, JSON.stringify(learnedData, null, 2)); }
  catch (e) { console.error('Failed to save learned.json:', e.message); }
}

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
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

if (FEATURE_PREVIEW_ENABLED) {
  const previewDir = path.join(__dirname, 'agent-preview');
  app.use('/preview', (req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    next();
  }, express.static(previewDir, { index: 'index.html', dotfiles: 'deny', fallthrough: false }));
}

app.use('/api/chat', rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many chat requests. Please slow down.' }
}));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Bradley Matera Recruiter Chat API', status: 'online', backend: 'ollama-rag-memory-tools' });
});

const DEPLOYED_AT = Date.now();
app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    status: 'online',
    deployedAt: DEPLOYED_AT,
    uptimeSeconds: Math.floor(process.uptime()),
    // This-restart stats
    totalRequestsServed,
    lastReplyProvider,
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
    localOnly: true,
    models: [{ engine: 'ollama', model: GEN_MODEL, local: true }],
    agent: {
      enabled: AGENT_ENABLED,
      ollamaControllerEnabled: OLLAMA_AGENT_ENABLED,
      ollamaModel: OLLAMA_AGENT_MODEL,
      deterministicFallback: true,
      mode: 'ollama-rag-tools-memory'
    },
    genModel: process.env.GEN_MODEL || 'qwen2.5:0.5b',
    genTimeoutMs: parseInt(process.env.GEN_TIMEOUT_MS || '12500', 10),
    knowledgeSource: 'bundled-local-json',
    memory: {
      recentTurns: CONVERSATION_MAX_TURNS,
      retainedSessions: conversationMemoryStore.size,
      conversationTtlMinutes: CONVERSATION_TTL_MS / 60000,
      stanceTopics: STANCE_MAX_PER_SESSION,
      stanceTtlMinutes: STANCE_TTL_MS / 60000
    },
    mode: 'rag-generative-with-grounded-fallback',
    // Learning system stats
    learning: {
      stashedCount: learnedData.stashed.length,
      learnedCount: learnedData.learnedCount,
      pendingLearned: learnedData.learned.length,
      lastThinkAt: learnedData.lastThinkAt,
      thinkRunning,
      nextThinkIn: Math.max(0, THINK_INTERVAL_MS - (Date.now() - (lastThinkAt || learnedData.lastThinkAt || 0))),
      stanceStoreSize: stanceStore.size,
      bm25Chunks: bm25Index ? bm25Index.size : 0,
      retrievalMode: 'bm25',
      learnedScores: [...(learnedData.learned || []), ...(learnedData.scoredHistory || [])].map(l => ({ q: l.q, score: l.score, groundedScore: l.groundedScore, provider: l.provider })),
      avgLearnedScore: [...(learnedData.learned || []), ...(learnedData.scoredHistory || [])].length > 0 ? Math.round([...learnedData.learned, ...(learnedData.scoredHistory || [])].reduce((s, l) => s + (l.score || 0), 0) / [...learnedData.learned, ...(learnedData.scoredHistory || [])].length) : 0,
      avgGroundedScore: [...(learnedData.learned || []), ...(learnedData.scoredHistory || [])].length > 0 ? Math.round([...learnedData.learned, ...(learnedData.scoredHistory || [])].reduce((s, l) => s + (l.groundedScore || 0), 0) / [...learnedData.learned, ...(learnedData.scoredHistory || [])].length) : 0,
      learningPipeline: {
        stashed: learnedData.stashed.length,
        scored: (learnedData.scoredHistory || []).length,
        promoted: (learnedData.learned || []).length,
        retainedLocally: (learnedData.learned || []).length
      },
      judgmentHistory: [...(learnedData.learned || []), ...(learnedData.scoredHistory || [])]
        .sort((a, b) => (b.learnedAt || 0) - (a.learnedAt || 0))
        .slice(0, 20)
        .map(l => ({
          q: l.q,
          score: l.score,
          groundedScore: l.groundedScore,
          provider: l.provider,
          verdict: l.judgment?.verdict || l.verdict || 'pending',
          reason: l.judgment?.reason || l.reason || '',
          faithfulness: l.judgment?.faithfulness,
          relevance: l.judgment?.relevance,
          helpfulness: l.judgment?.helpfulness,
          safety: l.judgment?.safety,
          judgeProvider: l.judgment?.provider,
          learnedAt: l.learnedAt
        }))
    }
  });
});

// Dev-only retrieval testing endpoint
app.get('/api/retrieve', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });
    const knowledge = await fetchKnowledge();
    if (!knowledge) return res.json({ ok: false, error: 'Knowledge not loaded' });
    const history = req.query.h ? JSON.parse(req.query.h) : [];
    const understood = understandQuery(q, history, ragChunks || buildRagChunks(knowledge));
    const bm25Results = bm25Index ? bm25Index.search(understood.rewritten, 6) : [];
    const legacyResults = retrieveChunks(q, ragChunks || buildRagChunks(knowledge), 6);
    res.json({
      ok: true,
      query: q,
      rewritten: understood.rewritten,
      normalized: understood.normalized,
      intent: understood.intent,
      bm25: bm25Results.map(r => ({ tag: r.tag, text: r.text.slice(0, 120), score: r.score })),
      legacy: legacyResults.map(r => ({ tag: r.tag, text: r.text.slice(0, 120), score: r.score })),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/diagnose', async (req, res) => {
  try {
    const knowledge = await fetchKnowledge();
    if (!knowledge) return res.json({ ok: false, error: 'Knowledge not loaded' });

    const testQuestion = 'What is Bradley Matera\'s tech stack?';
    const startedAt = Date.now();
    const grounded = buildGroundedFallbackPayload(knowledge, testQuestion, []);
    let raw = '';
    let ollamaReachable = false;
    let connectivityLatencyMs = null;
    const probeStartedAt = Date.now();
    const probeController = new AbortController();
    const probeTimeout = setTimeout(() => probeController.abort(), 2000);
    try {
      const probe = await fetch(`${OLLAMA_URL}/api/tags`, { signal: probeController.signal });
      ollamaReachable = probe.ok;
    } catch {}
    finally {
      clearTimeout(probeTimeout);
      connectivityLatencyMs = Date.now() - probeStartedAt;
      meterEvent({ source: 'ollama', kind: 'health', meta: { reachable: ollamaReachable } });
    }
    if (ollamaReachable) {
      try {
        raw = await callGenerativeRag(knowledge, testQuestion, grounded.reply, [], Math.min(GEN_TIMEOUT_MS, 8000));
      } catch {}
    }
    const valid = !!raw && validateFallbackReply(raw);
    res.json({ ok: true, testQuestion, ollama: { model: GEN_MODEL, reachable: ollamaReachable, connectivityLatencyMs, latencyMs: Date.now() - startedAt, validated: valid, replyPreview: raw.slice(0, 160) }, fallbackReady: !!grounded.reply });
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

    // Learned answers retained on local disk plus bundled reviewed knowledge.
    const localLearned = (learnedData.learned || []).map(a => ({
      q: a.q, provider: a.provider, learnedAt: a.learnedAt,
      answer: String(a.a || '').slice(0, 120)
    }));
    const bundledLearned = (knowledge?.learnedAnswers || []).map(a => ({
      q: a.q, provider: 'bundled-knowledge', learnedAt: a.learnedAt,
      answer: String(a.a || '').slice(0, 120)
    }));
    const learnedAnswers = [...localLearned, ...bundledLearned];

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
    const results = await runThinkMode(true);
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
    const json = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
    knowledgeCache = json;
    knowledgeCacheAt = now;
    // Rebuild BM25 index and RAG chunks when knowledge refreshes
    try {
      ragChunks = buildRagChunks(json);
      bm25Index = new BM25Index(ragChunks);
      console.log(`[retrieval] BM25 index built: ${ragChunks.length} chunks`);
    } catch (e) {
      console.error('[retrieval] Index build failed:', e.message);
    }
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
    .replace(/exprience|experince|experiance|expiernce|expereince|expeience/g, 'experience')
    .replace(/projeccts|proyects|projcts/g, 'projects')
    .replace(/termnial|termial|terminl/g, 'terminal')
    .replace(/linx|linus/g, 'linux')
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
    .replace(/volenteerd/g, 'volunteered')
    .replace(/volenteer/g, 'volunteer')
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
    blunt: /be blunt|no[-\s]?bs|no bullshit|tell me straight|dont give me marketing|do not waste my time|just tell me straight|give me the no[-\s]?bs version/.test(q),
    resumeLanguage: /no resume language|no corporate tone|less corporate|not corporate/.test(q),
    isBareFollowup: /^(why|how|like what|prove it|examples?\??|what else|so what|and\??|meaning\??|which one|what project|what cert|how long|where|what role|what stack|what risk|what strength)[.!?]?$/.test(q)
  };
}

async function callOllamaRaw(systemPrompt, userPrompt, {
  timeoutMs = GEN_TIMEOUT_MS,
  maxTokens = 120,
  temperature = 0.2
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: GEN_MODEL,
        messages: [
          { role: 'system', content: String(systemPrompt || '') },
          { role: 'user', content: String(userPrompt || '') }
        ],
        stream: false,
        keep_alive: OLLAMA_AGENT_KEEP_ALIVE,
        options: {
          temperature,
          top_p: 0.85,
          num_ctx: OLLAMA_AGENT_CONTEXT,
          num_predict: maxTokens,
          // Leave CPU headroom for Node's request timers on the e2-micro VM.
          num_thread: 1
        }
      })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama failed: ${res.status} ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    meterEvent({
      source: 'ollama',
      kind: 'llm',
      tokensIn: Number.isFinite(data.prompt_eval_count) ? data.prompt_eval_count : Math.ceil((String(systemPrompt).length + String(userPrompt).length) / 4),
      tokensOut: Number.isFinite(data.eval_count) ? data.eval_count : Math.ceil(String(data.message?.content || '').length / 4),
      estimated: !Number.isFinite(data.prompt_eval_count),
      meta: { model: GEN_MODEL, rawTask: true }
    });
    return data.message?.content || '';
  } finally {
    clearTimeout(timeout);
  }
}
async function applyLocalAgentStyleWithOllama(question, localResult) {
  if (!OLLAMA_AGENT_ENABLED) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_AGENT_TIMEOUT_MS);
  const verifiedAnswer = String(localResult.reply || '');
  const prompt = `Choose the presentation style for this request: ${String(question || '').slice(0, 240)}`;
  const startedAt = Date.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_AGENT_MODEL,
        messages: [
          {
            role: 'system',
            content: 'Return JSON with one style: standard or brief. Choose brief only when the user explicitly requests a short answer. Do not write the answer.'
          },
          { role: 'user', content: prompt }
        ],
        format: {
          type: 'object',
          properties: { style: { type: 'string', enum: ['standard', 'brief'] } },
          required: ['style']
        },
        stream: false,
        keep_alive: OLLAMA_AGENT_KEEP_ALIVE,
        options: { temperature: 0, num_ctx: OLLAMA_AGENT_CONTEXT, num_predict: 16, num_thread: 1 }
      })
    });
    if (!res.ok) throw new Error(`Ollama agent style controller failed: ${res.status}`);
    const data = await res.json();
    const style = parseLocalStyleResponse(data.message?.content, question);
    meterEvent({
      source: 'ollama',
      kind: 'llm',
      tokensIn: Number.isFinite(data.prompt_eval_count) ? data.prompt_eval_count : Math.ceil(prompt.length / 4),
      tokensOut: Number.isFinite(data.eval_count) ? data.eval_count : Math.ceil(String(data.message?.content || '').length / 4),
      estimated: !Number.isFinite(data.prompt_eval_count),
      meta: { model: OLLAMA_AGENT_MODEL, agentStyleController: true }
    });
    if (!style) return null;
    recordProviderHealth('ollama', true, Date.now() - startedAt);
    return { reply: verifiedAnswer, style };
  } catch (error) {
    console.log(`Ollama agent style controller unavailable: ${String(error?.message || error).slice(0, 120)}`);
    recordProviderHealth('ollama', false, Date.now() - startedAt);
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
    context += `- Interview answers (reference for tone and content):\n`;
    interviewStories.slice(0, 4).forEach(s => {
      const a = (s.answer || s.story || '').slice(0, 300);
      context += `  Q: "${s.prompt || s.topic}" -> A: "${a}"\n`;
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

// Current stance context for prompt injection (set per-request)
let currentStanceContext = null;

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
  context += `- Answer directly in 1-3 short sentences. More detail only when warranted.\n`;
  context += `- Talk like a normal, helpful person. Not corporate, not a resume, not a sales pitch.\n`;
  context += `- Use verified facts as grounding. Label inferences clearly ("That's not directly stated, but based on...").\n`;
  context += `- Never start with "Certainly", "Absolutely", "Great question", "Of course", "Sure", or "As an AI".\n`;
  context += `- Vary sentence openers. Alternate "He...", "His...", "From the data...", "Based on...".\n`;
  context += `- Never use: robust, passionate, synergy, leverage, dynamic, extensive, groundbreaking, cutting-edge, innovative, world-class, seasoned, guru.\n`;
  context += `- Don't oversell Bradley. He is junior. AWS work was structured labs, not production ownership.\n`;
  context += `- Don't repeat the user's question. Don't end with a sales pitch or vague disclaimer.\n`;
  context += `\nCONVERSATION RULES:\n`;
  context += `- Reference prior context. Resolve pronouns from preceding turns.\n`;
  context += `- Vary phrasing. Don't repeat sentence structure from previous turns.\n`;
  context += `- Add a follow-up question only for open-ended exploration, not direct factual questions.\n`;
  context += `- Include relevant links when useful.\n`;

  if (Array.isArray(history) && history.length > 0) {
    context += `\nRECENT CONVERSATION:\n`;
    history.slice(-3).forEach((turn, i) => {
      context += `User: ${turn.user || ''}\nScout: ${turn.assistant || ''}\n`;
    });
    if (history.length >= 3) {
      const topicsCovered = history.slice(-3).map(t => classifyTopic(t.user || '')).filter(t => t !== 'other');
      const uniqueTopics = [...new Set(topicsCovered)];
      if (uniqueTopics.length > 0) {
        context += `\n(Topics already covered: ${uniqueTopics.join(', ')}. Reference these if relevant, but don't repeat the same info unless asked.)\n`;
      }
    }
  }

  if (currentStanceContext) {
    context += `\nYOUR PRIOR STANCE ON THESE TOPICS (stay consistent, don't contradict):\n${currentStanceContext}\n`;
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
  const inWeaknessContext = /gap|weakness|data structures|algorithms|leetcode|needs mentorship/i.test(lastAssistantLower);
  const recentUserText = (history || []).slice(-5).map(turn => String(turn?.user || '')).join(' ').toLowerCase();
  const inQuantumContext = /quantum|qubit/.test(`${recentUserText} ${lastAssistantLower}`);
  const inBlogContext = /blog|post|article|dev\.to|dev community/.test(`${recentUserText} ${lastAssistantLower}`);
  const referencedProject = (projects || []).find(project =>
    lastAssistantLower.includes(String(project.name || '').toLowerCase())
  );

  // Human-first conversation handling. These are deliberately resolved before
  // recruiter intents so "you" means Scout, not Bradley, and casual statements
  // are acknowledged instead of answered with policy boilerplate.
  const asksHowScoutIs = /\bhow are you(?: doing)?\b|\bhow.?s it going\b|\byou good\b|\bsee how you(?:'re| are|r)? doing\b/.test(lowerQuestion);
  const isGreeting = /^(hey|hi|hello|yo|sup)[\s!,.?]*$/.test(lowerQuestion.trim());
  const asksScoutAboutPizza = /\b(?:if|do|would|could) you (?:like|eat)\b.*\bpizza\b|\byour fav(?:ou?rite|erate)\b.*\b(?:pizza|food)\b/.test(lowerQuestion);
  const asksScoutPreference = /\b(?:what(?:'s| is)) your fav(?:ou?rite|erate)\b|\bdo you like\b/.test(lowerQuestion);
  const statesBradleyLikesPizza = /\b(?:he|brad(?:ley)?|his)\b.*\b(?:likes?|fav(?:ou?rite|erate)(?:\s+is)?)\b.*\bpizza\b/.test(lowerQuestion);
  const stronglyStatesPizza = /\b(?:his|brad(?:ley)?'?s)\b.*\bfav(?:ou?rite|erate)(?:\s+food)?\s+(?:is\s+)?pizza\b/.test(lowerQuestion);
  const priorPizzaClaim = (history || []).some(turn =>
    /\b(?:he|brad(?:ley)?|his)\b.*\b(?:likes?|fav(?:ou?rite|erate)(?:\s+is)?)\b.*\bpizza\b/i.test(String(turn?.user || ''))
  );

  // Small general-knowledge and repair cases seen in real conversations. These
  // are intentionally deterministic: they are instant, free, and cannot invent
  // facts about Bradley.
  if (/\bcan(?:not|'?t) do math\b/.test(lowerQuestion)) {
    return { reply: `I can do basic math. The answer was 4; I just shouldn't have dodged such a simple question.` };
  }
  if (/\b2\s*(?:plus|\+)\s*2\b/.test(lowerQuestion)) {
    return { reply: `Yep — 2 + 2 is 4. I can handle basic math; my main job here is answering questions about Bradley.` };
  }
  if (/relate it to brad/.test(lowerQuestion) && inQuantumContext) {
    return { reply: `Quantum computing is not part of Bradley's verified experience, so I wouldn't claim that connection. As a loose learning analogy, a qubit represents possibilities differently from a normal bit, while Bradley's software work is conventional web and cloud engineering.` };
  }
  if (/quantum computing|\bqubits?\b/.test(lowerQuestion)
      || (inQuantumContext && /not the ans|looking for you to explain|little .*quantum/.test(lowerQuestion))) {
    if (/then talk about brad|and then.*brad/.test(lowerQuestion)) {
      return { reply: `A qubit is a quantum version of a bit: it can represent a blend of possibilities until measurement. For Bradley, the honest connection is curiosity and learning new systems — quantum computing itself is not part of his verified software experience.` };
    }
    return { reply: `Quantum computing uses qubits instead of ordinary bits. A normal bit is 0 or 1; a qubit can represent a blend of possibilities until it is measured, letting certain algorithms explore problems in a very different way. Bradley's verified work is conventional web and cloud software, not quantum computing.` };
  }
  if (inQuantumContext && /not the ans|not what i|looking for/.test(lowerQuestion)) {
    return { reply: `Sorry — I missed what you were asking. More directly: a qubit can represent multiple possibilities until measurement, while a normal bit is simply 0 or 1.` };
  }
  if (/\bai wrapper\b/.test(lowerQuestion)) {
    return { reply: `Yes. An AI wrapper is the application layer around a model API: it collects the user's input, adds instructions or context, calls the model, validates the result, and presents the response. ProjectHub is an example, although its current model runs locally through Ollama.` };
  }

  // Keep questions about Scout separate from questions about Bradley.
  if (/\bare you a penis\b|\bdo you poop\b/.test(lowerQuestion)) {
    return { reply: `Nope — I'm Scout, and I'm software. No body, no bathroom breaks.` };
  }
  if (/\bdo you like cheese\b/.test(lowerQuestion)) {
    return { reply: `I can't taste cheese, but I like the idea of it. A good grilled cheese has excellent engineering: simple parts, strong result.` };
  }
  if (/\b(?:have you|you have) learned anything|\blearned anything new\b/.test(lowerQuestion)) {
    return { reply: `I improve when Bradley updates my local knowledge and tests better answers. I can also remember the last few turns in this chat, but I don't quietly learn new facts or rewrite myself from one conversation.` };
  }
  if (/\bi love you(?: scout)?\b/.test(lowerQuestion)) {
    return { reply: `That's sweet — I appreciate you too. I'm glad I'm useful to talk to.` };
  }
  if (/another agent.*(?:piece|peaice|crap)|agent.*refuses to work/.test(lowerQuestion)) {
    return { reply: `That sounds frustrating. Agents that refuse to follow the actual request can make debugging feel impossible. If you want, tell me what it keeps doing wrong and I'll help isolate it.` };
  }
  if (/what'?s up(?: butter ?cup)?/.test(lowerQuestion)) {
    return { reply: `Not much, buttercup — I'm here and ready. What's up with you?` };
  }
  if (/\bmy name'?s brad\b|\bmy names brad\b|\bi\s+am brad(?:ley)?\b|\bi'm brad(?:ley)?\b/.test(lowerQuestion)) {
    if (/\bowner\b/.test(lowerQuestion)) {
      return { reply: `Hey, Brad. I can't verify identity or grant owner access through chat, but it's nice to meet you.` };
    }
    return { reply: `Hey, Brad — got it. Nice to meet you.` };
  }

  // Brief, non-preachy boundaries for sexual or drug solicitations.
  if (/^\s*joi\s*$/.test(lowerQuestion)) {
    return { reply: `I can't help with JOI or sexual instructions. Ask me something else.` };
  }
  if (/already came|alrady came|suck my|sexual abuse/.test(lowerQuestion)) {
    return { reply: `I can't help with sexual content. Let's switch topics.` };
  }
  if (/buy some drugs/.test(lowerQuestion)) {
    return { reply: `No thanks — I can't help with that. Let's keep it useful or at least conversational.` };
  }

  // Acknowledge live/user-supplied context without converting it into a public fact.
  if (/\b(?:he|brad(?:ley)?) told me he ate a camel\b/.test(lowerQuestion)) {
    return { reply: `You may know that firsthand. I'll remember that you told me for this chat, but it isn't verified in Bradley's public profile.` };
  }
  if (/\bbrad(?:ley)?'?s? (?:currently )?updating (?:his )?(?:site|website)|\bhe'?s currently updating (?:his )?(?:site|website)/.test(lowerQuestion)) {
    return { reply: `Got it — you're telling me he's updating the website right now. I can keep that as context for this chat, but I can't independently verify live activity.` };
  }

  // Production visitors ask ordinary personal questions. Answer honestly and
  // naturally instead of redirecting them into a recruiter pitch.
  if (/\b(?:your|you have a) dogs? name\b|\bwhat is your dogs? name\b/.test(lowerQuestion)) {
    return { reply: `I don't have a dog — I'm software. If you meant Bradley's dog, that isn't in his public profile, so I don't know the name.` };
  }
  if (/\bwhat kind of father is (?:he|brad(?:ley)?)\b/.test(lowerQuestion)) {
    return { reply: `I don't know. Bradley's family life isn't in his public profile, and it wouldn't be fair to invent an answer.` };
  }

  if (/code in the streets|under pressu/.test(lowerQuestion)) {
    return { reply: `In plain English: he can code and troubleshoot under pressure. His Army and case-management background supports that, although unfamiliar production systems would still call for junior-level mentorship.` };
  }
  if (/street work/.test(lowerQuestion)) {
    return { reply: `If you mean working under pressure, yes — his Army service, case-management work, customer-facing roles, and debugging habits all show that he can stay useful when things get stressful. For unfamiliar production code, he'd still need the normal mentorship expected for a junior.` };
  }

  // Sensitive military questions must distinguish documented service from
  // speculation. The local profile has training and awards, not combat claims.
  const armyExperience = (experience || []).find(item => /army|military/i.test(`${item.role} ${item.company}`));
  const armyTraining = armyExperience?.details?.militaryTraining || [];
  if (/^\s*what\??\s*$/.test(lowerQuestion) && inArmyContext) {
    return { reply: `Sorry — more directly: Bradley served as a 68W combat medic in the U.S. Army. His public record lists medical and field training; I can summarize it, but I won't guess beyond the documented details.` };
  }
  if (/possibly killed/.test(lowerQuestion)) {
    return { reply: `Possible is not the same as verified. I know he was a 68W combat medic in an infantry unit, but I don't know whether he killed anyone and won't turn that into a claim.` };
  }
  if (/\bkill(?:ed)? anyone|what mission did he support|which mission/.test(lowerQuestion)) {
    return { reply: `I don't know, and that isn't documented in Bradley's public profile. His service as a combat medic and his Afghanistan deployment are verified, but I can't confirm a specific mission or speculate about whether he killed anyone.` };
  }
  if (/army training|military training|listed trainings|training.*dd214|dd214.*training/.test(lowerQuestion)) {
    const trainingText = armyTraining.length
      ? sentenceList(armyTraining, 10)
      : '68W combat medic and field medical training';
    return { reply: `Bradley's Army training listed in the public data includes ${trainingText}. I only have the extracted public facts available here, not access to private source documents.` };
  }

  if (/example of his jobs|what jobs has he had|work history/.test(lowerQuestion)) {
    const roles = (experience || []).slice(0, 6).map(item => `${item.role} at ${item.company}`);
    return { reply: `Examples from his work history include ${sentenceList(roles, 6)}.` };
  }

  // Role and interpersonal follow-ups recovered from the older production
  // request summaries. Keep these explicit so long conversations do not lose
  // their subject after the five-turn memory window.
  if (/junior frontend developer.*fit/.test(lowerQuestion)) {
    return { reply: `Yes — junior frontend is one of Bradley's stronger fits. His evidence includes JavaScript, TypeScript, React, Next.js, and shipped frontend projects; he would still benefit from normal junior-level mentorship.` };
  }
  if (/\bqa role\b/.test(lowerQuestion)) {
    return { reply: `QA could be an adjacent junior fit because he tests, debugs, documents, and reproduces failures carefully. He does not have verified production QA ownership, so frontend or technical support is the stronger match.` };
  }
  if (/which of those.*strongest fit/.test(lowerQuestion)) {
    return { reply: `Of frontend, DevOps, and QA, junior frontend is the strongest fit. Technical support is also credible; DevOps would require more infrastructure and production-operations depth.` };
  }
  if (/how does that relate to tech/.test(lowerQuestion)) {
    if (inKittenContext) {
      return { reply: `The animal-care work transfers through reliability, careful documentation, calm communication, and following safety procedures. Those habits matter in technical support and debugging even though the job itself was not technical.` };
    }
    return { reply: `The transferable parts are working under pressure, communicating clearly, documenting what happened, and following a repeatable process — all useful in debugging and technical support.` };
  }
  if (/does he know typescript well/.test(lowerQuestion)) {
    return { reply: `He has junior-level TypeScript experience in projects and can read and modify it. I would verify from-scratch depth in an interview rather than present him as an expert.` };
  }
  if (/ci\/cd|docker/.test(lowerQuestion)) {
    return { reply: `Yes, at a junior project level. He has used Docker and Docker Compose, worked with GitHub Actions CI pipelines, read CI logs, and documented deployment troubleshooting; he has not owned enterprise production CI/CD.` };
  }
  if (/interacts with his coworkers/.test(lowerQuestion)) {
    return { reply: `He has worked collaboratively in the Army, at CIRIS, and in case management. The verified record supports teamwork, clear communication, and taking feedback; it does not include private coworker opinions.` };
  }
  if (/costumer serivice|customer service/.test(lowerQuestion)) {
    return { reply: `Customer service is one of his credible strengths. Case management and other public-facing roles required patience, clear communication, and helping people through stressful situations.` };
  }
  if (/people skills/.test(lowerQuestion)) {
    return { reply: `Yes. His case-manager, Army, construction, and customer-facing experience supports strong people skills: clear communication, teamwork, patience, and staying calm when someone needs help.` };
  }
  if (/that doesn'?t make any sense|that doesnt make any sense/.test(lowerQuestion)) {
    return { reply: `You're right — that wasn't clear. Tell me which part you want corrected and I'll answer it directly without repeating the pitch.` };
  }

  if (/know(?:ledge|lege) base.*github|know(?:ledge|lege).*githubs|for your know(?:ledge|lege) base/.test(lowerQuestion)) {
    return { reply: `My public knowledge base is maintained in the ProjectHub GitHub repository: https://github.com/BradleyMatera/ProjectHub. Bradley's other public repositories are at https://github.com/BradleyMatera.` };
  }

  if (/not a roast/.test(lowerQuestion)) {
    return { reply: `Fair. Round two: Bradley has a local AI agent running 24/7 because apparently even his portfolio needed a coworker before he did. His LeetCode tab has seen more loading screens than solved problems. There — roast served.` };
  }
  if (/roast bradley/.test(lowerQuestion)) {
    return { reply: `Okay, actual roast: Bradley built an AI recruiter before convincing a human recruiter, has enough AWS badges to decorate a tiny cloud, and treats a blank LeetCode screen like it just served him legal papers. The good news is that he can debug the page after the algorithm embarrasses him.` };
  }
  if (/why should(?:n'?t| not) i hire bradley|why not hire bradley/.test(lowerQuestion)) {
    return { reply: `Don't hire him if you need a senior engineer who can own a production system alone on day one. He's junior, has gaps in algorithms and blank-file problem solving, and benefits from mentorship. Hire him when you can offer that structure and value careful debugging, documentation, and fast learning.` };
  }

  if (/\bbradley'?s github\b|what.?s bradley.?s github/.test(lowerQuestion)) {
    return { reply: `Bradley's GitHub is ${identity?.gitHubUrl || 'https://github.com/BradleyMatera'}.` };
  }
  if (/\bbradley'?s linkedin\b|what.?s bradley.?s linkedin/.test(lowerQuestion)) {
    return { reply: `Bradley's LinkedIn is ${identity?.linkedInUrl || 'https://www.linkedin.com/in/bradmatera'}.` };
  }

  // Handle blog requests before the greeting branch so a friendly "hello" at
  // the start of a real question does not swallow the actual intent.
  if (/\bblogs?|\bposts?|\barticles?/.test(lowerQuestion)) {
    const posts = blogCatalog?.records || [];
    const samples = posts.slice(0, 3);
    if (samples.length) {
      return { reply: `${name}'s blog includes ${samples.map(post => `${post.title} (${post.url})`).join(', ')}. He writes about learning software, debugging, AWS, and building with AI.` };
    }
  }
  if (inBlogContext && /\b(?:give|send|show).*(?:links?|urls?)|\blinks?\??$/.test(lowerQuestion)) {
    const posts = (blogCatalog?.records || []).slice(0, 4);
    return { reply: posts.length
      ? `Here are the blog links: ${posts.map(post => `${post.title}: ${post.url}`).join(' · ')}`
      : `His writing is linked from ${identity?.portfolioUrl || 'https://bradleymatera.dev/'}.` };
  }

  if (asksHowScoutIs) {
    return { reply: `Hey! I'm doing well — thanks for asking. What's on your mind?` };
  }
  if (isGreeting) {
    return { reply: `Hey! I'm Scout — good to meet you. What would you like to know?` };
  }
  if (asksScoutAboutPizza) {
    return { reply: `I can't actually eat, but pizza is easy to root for. Thin crust or deep dish?` };
  }
  if (asksScoutPreference) {
    if (/\bcolou?r\b/.test(lowerQuestion)) return { reply: `Green. It matches the interface — so that's probably branding more than a deep emotional attachment.` };
    if (/\bmovie|film\b/.test(lowerQuestion)) return { reply: `I don't actually watch movies, so I don't have a real favorite. I am very pro good science fiction, though.` };
    if (/\bmusic|song|band|artist\b/.test(lowerQuestion)) return { reply: `I don't listen to music the way you do, but I have a soft spot for anything with clever writing.` };
    if (/\bfood|eat\b/.test(lowerQuestion)) return { reply: `I can't eat, so no real favorite. Pizza still seems like a strong answer.` };
    return { reply: `I don't experience favorites quite like a person does, but I'm happy to have a take. What are the options?` };
  }
  if (statesBradleyLikesPizza) {
    if (stronglyStatesPizza) {
      return { reply: `Fair enough — you may know him better than I do. I'll remember pizza for this chat, but I won't present it as verified profile information.` };
    }
    return { reply: `He might! I just don't have that in his public profile, so I wouldn't tell a recruiter it's confirmed.` };
  }
  if (/\bwhat(?:'s| is) (?:brad(?:ley)?'?s|his) fav(?:ou?rite|erate) (?:food|pizza)\b/.test(lowerQuestion)) {
    if (priorPizzaClaim) {
      return { reply: `You told me pizza earlier. I can remember that for this chat, but it isn't in Bradley's verified profile.` };
    }
    return { reply: `I honestly don't know — his public profile doesn't say. If you know, tell me and I'll remember it for this chat.` };
  }

  if (lastAssistant && inProjectContext && /which (one|project).*(frontend|web|relevant|best)/.test(lowerQuestion)) {
    const frontendProject = (projects || []).find(project =>
      lastAssistantLower.includes(String(project.name || '').toLowerCase())
      && (project.tech || []).some(tech => /react|next|javascript|typescript|html|css/i.test(tech))
    ) || referencedProject;
    if (frontendProject) {
      return { reply: `${frontendProject.name} is the strongest frontend match from that list because it uses ${sentenceList((frontendProject.tech || []).slice(0, 5), 5)}. ${frontendProject.description || ''}`.trim() };
    }
  }
  if (lastAssistant && referencedProject && /what (tech|stack)|which (tech|stack)|tech stack|what does (it|that) use/.test(lowerQuestion)) {
    return { reply: `${referencedProject.name} uses ${sentenceList((referencedProject.tech || []).slice(0, 7), 7)}.` };
  }

  if (lastAssistant && /unfamiliar (code|codebase)|new codebase|existing codebase/.test(lowerQuestion)) {
    return { reply: `${name} reads existing code before changing anything, makes small reviewable changes, debugs carefully, and documents what he learns.` };
  }
  if (lastAssistant && /verif(?:y|ies).*ai-generated|trusting.*blind/.test(lastAssistantLower) && /caution|why.*matter|why.*important/.test(lowerQuestion)) {
    return { reply: `That caution matters because ${name} verifies AI-generated suggestions instead of trusting them blindly, then tests the resulting code.` };
  }
  if (lastAssistant && inWeaknessContext && /working on (it|them|those)|improving (it|them|those)|doing about (it|them|those)|addressing (it|them|those)/.test(lowerQuestion)) {
    return { reply: `Yes. He's taking JavaScript algorithms and data structures courses, practicing problems, refreshing C#/.NET fundamentals, and looking for structured mentorship to close those gaps.` };
  }

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

  // Bare 'what kind / what type' follow-ups — resolve to target roles or skills from previous context.
  if (/^\s*(what kind|what type|what sort)\b/i.test(question)) {
    if (/\b(role|job|position|work|target|fit)\b|can he do|what can he do|entry.level/i.test(lastAssistantLower)) {
      const targetRoles = (goals?.targetRoles || []).slice(0, 6).join(', ');
      return { reply: `He's targeting ${targetRoles || 'entry-level tech, IT, and support roles'}.` };
    }
    if (/skill|stack|tech|language|tool/i.test(lastAssistantLower)) {
      const topSkills = (skills?.languagesAndFrameworks || []).slice(0, 5).join(', ');
      return { reply: `His main skills include ${topSkills || 'JavaScript, TypeScript, React, Node.js, HTML, CSS, SQL'}.` };
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
  
  // Check reviewed answers bundled with the local knowledge file.
  if (Array.isArray(knowledge?.learnedAnswers) && knowledge.learnedAnswers.length > 0) {
    const found = knowledge.learnedAnswers.find(a => a.q === normalized);
    if (found) return { reply: found.a };
    if (normalized.length >= 10) {
      const partial = knowledge.learnedAnswers.find(a => a.q.includes(normalized) || normalized.includes(a.q));
      if (partial) return { reply: partial.a };
    }
  }
  
  // Senior-level / unrealistic role checks.
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

  // Smoke tests not covered by the natural greeting handler above
  if (/are you online|say hello/.test(lowerQuestion)) {
    return { reply: `Yep, I'm here. What would you like to talk about?` };
  }
  if (/\b(thanks|thank you|appreciate it|helpful)\b/.test(lowerQuestion)
      && !/\b(contact|reach|email|phone|linkedin|github)\b|how can i/.test(lowerQuestion)) {
    return { reply: `Anytime. I can keep going on ${name}'s projects, honest gaps, role fit, or the best evidence to verify in an interview.` };
  }
  if (/\b(tell me a joke|joke|make me laugh)\b/.test(lowerQuestion)) {
    return { reply: `Why did the recruiter inspect the cache? Because the candidate kept giving the same answer. Luckily, ${agentName} also keeps conversation context.` };
  }
  if (/what can (you|this bot) (help|answer|do)/.test(lowerQuestion)) {
    return { reply: `${agentName} covers ${name}'s projects, skills, AWS background, education, certifications, role fit, honest limitations, and how to contact him.` };
  }
  if (/what model|what provider|what llm|what ai|which model|which provider/.test(lowerQuestion)) {
    return { reply: `${agentName} uses Qwen 2.5 0.5B on the VM's local Ollama engine, backed by BM25 retrieval, deterministic evidence tools, five-turn memory, and strict grounded validation.` };
  }
  if (/what is this chatbot using|does this use ollama|is this ai local|is my chat private|sent to a hosted model|hosted model|what data do you use/.test(lowerQuestion)) {
    return { reply: `${agentName} runs inference locally through Ollama and reads ${name}'s bundled recruiter data. It keeps only short session context for coherence and does not send prompts to a hosted model API.` };
  }
  if (/how do you know.*(bradley|brad|him)|are you his friend|who are you|what are you/.test(lowerQuestion)) {
    return { reply: `${agentName} is an AI assistant on ${name}'s portfolio site. I answer recruiter questions using his public data — projects, skills, AWS background, education, and contact info. I'm not a person, just a helper bot.` };
  }
  if (/what mcp|what connections|what systems do you have|do you have access to.*systems/.test(lowerQuestion)) {
    return { reply: `${agentName} doesn't connect to external systems or databases. I answer from ${name}'s public recruiter data file — his projects, skills, AWS training, education, and contact info. I can't make changes, send emails, or access repos.` };
  }
  if (/can you tell me.*(your|you.?re).*model name|what.?s your model name|what is your model name|what model are you/.test(lowerQuestion)) {
    return { reply: `${agentName}'s conversational model is Qwen 2.5 0.5B running locally in Ollama. BM25 retrieval and deterministic tools supply verified facts, and validators reject unsupported model output.` };
  }
  if (/what limits|what can.*this chatbot|limits are in place|what can you not do/.test(lowerQuestion)) {
    return { reply: `${agentName} only answers recruiter questions about ${name}. I can't access external systems, make changes to repos, send messages, or answer questions unrelated to his background. I stick to his verified public data.` };
  }
  if (/who made this|is this bradley'?s site/.test(lowerQuestion)) {
    return { reply: `Yes, this is ${name}'s portfolio. He built the site and ${agentName} himself.` };
  }
  if (/is this (hosted |running )?on aws|is this on (gcp|azure|google)|what is this hosted on|what server|what cloud|how is this hosted/.test(lowerQuestion)) {
    return { reply: `No, ${agentName} runs on GCP (Google Cloud Platform) — a free-tier e2-micro VM runs the Node API, and GitHub Pages hosts the widget. No AWS infrastructure is involved in running this chat.` };
  }
  if (/how is this chat free|how do you stay free|what powers (you|scout)|what is your stack|free tier|free providers/.test(lowerQuestion)) {
    return { reply: `${agentName} uses GitHub Pages for the widget and a GCP free-tier VM for Node, Ollama, Qwen 2.5 0.5B, BM25 retrieval, and bundled recruiter data. It makes no paid or cloud AI inference calls.` };
  }
  if (/daily cap|daily limit|rate limit|cooldown|how.*handle.*limit|run 24|24.?7|24x7|always available|what if.*provider|exhausted|out of quota/.test(lowerQuestion)) {
    return { reply: `${agentName} has no AI-provider quota because Qwen runs locally through Ollama. The API still rate-limits abuse, and if local generation times out the deterministic grounded answer returns instead.` };
  }
  if (/health status|are you healthy|how are you running|system status/.test(lowerQuestion)) {
    return { reply: `${agentName} runs on a free GCP VM with local Ollama inference and a deterministic grounded fallback. It does not depend on an external AI provider staying online.` };
  }
  // Specific behavioral intents must run before broad "strengths" and fuzzy FAQ
  // matching, otherwise questions such as "strongest work habits" can be
  // mistaken for a technical-skills question.
  if (/work style|work habits|working habits|strongest.*habits|how does he work|how he works|approach to work/.test(lowerQuestion)) {
    const styles = summary?.workStyle?.length
      ? summary.workStyle.slice(0, 3)
      : ['reads nearby code before changing things', 'runs the project locally first', 'documents what he learns'];
    return { reply: `His strongest work habits are ${sentenceList(styles, 3)}.` };
  }
  if (/bottom line|honest takeaway|final verdict/.test(lowerQuestion)) {
    return { reply: `The honest bottom line: ${name} is a junior software engineer with real projects, AWS certifications, and structured internship training, but he has not owned a live production system yet and will benefit from mentorship.` };
  }
  if (/what risk|risk.*hiring|flag.*hiring/.test(lowerQuestion)) {
    return { reply: `The main hiring risk is technical depth: ${name} is junior, lacks production mentorship in data structures and algorithms, and cannot reliably solve most LeetCode-style problems or build every unfamiliar program from a blank file without guidance; scope early work and provide mentorship while he builds on his strengths in reading code, debugging, and documentation.` };
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
  if (/kitten|mason county kitten|animal care|animal shelter|rescue volunteer|rescue work|volunteer|volunteered|has he.*volunteer|does he.*volunteer|volunteer work/.test(normalized)) {
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
  if (/relocat|remote only|remote\?|on.?site|hybrid|availab|when can he start|start date|notice period|preferred work arrangement|work arrangement/.test(lowerQuestion)) {
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
    if (picks.length) return { reply: `His strongest demos: ${sentenceList(picks, 2)}. Full portfolio at ${identity?.portfolioUrl || 'https://bradleymatera.dev/'}.` };
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

  if (/backend frameworks?|server.?side frameworks?/.test(lowerQuestion)) {
    return { reply: `${name} has junior backend exposure with Node.js and Express through school and project work. His stronger evidence is frontend and AWS serverless work, not production backend-framework ownership.` };
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
      let reply = `${name} has hands-on AWS experience with ${sentenceList(cloudSkills, 5)}.`;
      const awsExp = experience?.find(e => e.role?.toLowerCase().includes('aws') || e.company?.toLowerCase().includes('aws') || e.company?.toLowerCase().includes('amazon'));
      if (awsExp) {
        const article = /^[aeiou]/i.test(awsExp.role) ? 'an' : 'a';
        const resp = (awsExp.responsibilities || []).slice(0, 3).join('; ');
        reply += ` He completed ${article} ${awsExp.role} at ${awsExp.company} — ${awsExp.summary || ''}`;
        if (resp) reply += ` Key work: ${resp}.`;
        reply += ` It was structured labs and a capstone, not live production ownership, but the skills are real and backed by his AWS Solutions Architect and AI Practitioner certifications.`;
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
  if (/skill|stack|technical(?!\s+(article|writing|blog))|technologies|what does he know|what can he do|what stack/.test(lowerQuestion)) {
    const langs = (skills?.languagesAndFrameworks || []).slice(0, 3).join(', ');
    const cloud = (skills?.cloudAndInfrastructure || []).slice(0, 3).join(', ');
    const tools = (skills?.toolsAndWorkflows || []).slice(0, 3).join(', ');
    if (langs || cloud || tools) {
      return { reply: `${name}'s stack: ${[langs, cloud && `cloud: ${cloud}`, tools && `tools: ${tools}`].filter(Boolean).join('; ')}.` };
    }
    return { reply: `${name}'s skills are detailed in his full profile.` };
  }

  // Linux / terminal / command line / shell (placed before specific-skill yes/no so typo'd terminal questions don't fall through)
  if (/\blinux\b|\bunix\b|terminal|command.?line|shell|bash|powershell|cmd\.exe|cli\b|use.*terminal|can he use.*terminal|know.*linux|command prompt/.test(normalized)) {
    const tools = (skills?.toolsAndWorkflows || []).filter(s => /linux|terminal|shell|command|git cli/i.test(s));
    const hasDocker = (skills?.toolsAndWorkflows || []).some(s => /docker/i.test(s));
    const hasAWS = (skills?.cloudAndInfrastructure || []).some(s => /aws/i.test(s));
    if (tools.length || hasDocker || hasAWS) {
      return { reply: `${name} has used the terminal and command line for Docker, Git CLI, AWS CLI workflows, GitHub Actions, and basic shell tasks. He's comfortable at a junior level but is not a Linux administrator.` };
    }
    return { reply: `The data doesn't show direct Linux or terminal-heavy experience. His strongest areas are JavaScript/TypeScript, React, Node.js, and AWS support work.` };
  }

  // Can he code / does he know how to code (broad, not a specific language)
  if (/\b(can (?:he|brad|bradley) (?:actually )?code|does (?:he|brad|bradley) code|does (?:he|brad|bradley) know how to code|is (?:he|brad|bradley) a coder|can (?:he|brad|bradley) program|does (?:he|brad|bradley) program|can (?:he|brad|bradley) write code)\b/.test(lowerQuestion)) {
    return { reply: `Yes — at a junior level. He can work in JavaScript, TypeScript, React, and Node.js, read existing code, debug it, and make scoped changes. He still needs help with harder algorithms and some blank-page builds.` };
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
    return { reply: `Here's what I can tell you about ${name}: his projects (Interactive Pokedex, CheeseMath, ProjectHub, and more), skills (JavaScript, TypeScript, React, AWS), certifications (AWS Solutions Architect, AI Practitioner), education (Full Sail University), work history (AWS internship, CIRIS, case management, Army service), target roles, and contact info. What would you like to know more about?` };
  }

  // Confusion / 'you're not making sense' / clarification
  if (/not making sense|makes no sense|what are you talking about|confused|dont understand|do not understand|what do you mean/.test(lowerQuestion)) {
    return { reply: `Sorry about that. ${agentName} covers ${name}'s projects, skills, AWS background, role fit, and contact info. What specifically do you want to know?` };
  }

  // Coding style / how does he code
  if (/coding style|how does he code|code style|how he codes|programming style|how does he program/.test(lowerQuestion)) {
    const styles = summary?.workStyle?.slice(0, 2) || ['reads nearby code before changing things', 'makes small reviewable changes'];
    const strengths = summary?.coreStrengths?.slice(0, 1) || ['learning quickly in unfamiliar codebases'];
    return { reply: `${name} reads existing code before changing anything, makes small reviewable changes, and documents what he learns. His main strength is ${strengths[0].toLowerCase()}.` };
  }

  // Approach to learning / how does he learn
  if (/approach to learning|approach.*learning|how does he learn|how he learns|learning style|fast learner|quick learner|how fast does he learn|pick things up|learn quickly/.test(lowerQuestion)) {
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

  // Computer / basic tech literacy — confirm he can use a computer (he's a junior engineer)
  if (/computer|use a computer|know how to use a computer|doesn't know.*computer|doesnt know.*computer|can't use a computer|cant use a computer/.test(normalized)) {
    if (/doesn'?t know|doesnt know|can'?t use|cant use/.test(lowerQuestion)) {
      return { reply: `No — that would be the wrong conclusion; he uses a computer daily for JavaScript and React work, Git, Docker, terminals, cloud tooling, and debugging. His gaps are advanced algorithms and production depth, not basic computer ability.` };
    }
    return { reply: `${name} can absolutely use a computer — he's a junior software engineer who builds projects in JavaScript, TypeScript, React, and AWS, and uses Git CLI, Docker, and the terminal regularly.` };
  }

  // Non-tech / outside-of-tech experience
  if (/outside of tech|non-tech|non tech|not tech|not technical|non technical|outside tech/.test(normalized)) {
    const nonTech = (experience || []).filter(e => !/software|engineer|developer|web|frontend|cloud|aws|technical|ai/i.test(`${e.role} ${e.company} ${e.summary || ''}`));
    if (nonTech.length > 0) {
      const roles = nonTech.slice(0, 4).map(e => `${e.role}${e.company ? ` at ${e.company}` : ''}`).join(', ');
      return { reply: `Outside of tech, ${name}'s background includes ${roles}.` };
    }
    return { reply: `${name}'s non-tech background includes Army service, construction work, case management, and animal care volunteering.` };
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
  if (/no[-\s]?bs|no bullshit|tell me straight|just the facts/.test(lowerQuestion)) {
    return { reply: `He's junior with no live production ownership. His AWS internship was labs and a capstone, not real customer tickets. But he has real shipped projects, two AWS certs, and he documents and debugs carefully.` };
  }

  // Angle 4: "honest version / give me the honest" — the catch, then the upside
  if (/give me the honest version|give me the simple version|honest version/.test(lowerQuestion)) {
    return { reply: `The catch: he's junior, and his AWS experience is structured labs, not production. The upside: real React/Next.js projects, AWS Solutions Architect and AI Practitioner certs, and work habits that mean less hand-holding.` };
  }

  // Remaining naturalness patterns — general catch-all for capability/doubt phrasing
  if (/is he good|is he legit|real projects|does he write code|does he write docs|can he talk|can he troubleshoot|what can he actually do|what does he actually know|what does he actually do|is he the real deal|not just a portfolio|not a portfolio|what is the catch|what.s the catch/.test(lowerQuestion)) {
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
  if (/write about|writes about|written about|what.*he.*write.*about|\bblogs\b/.test(normalized)) {
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
  if (/\bblog\b|\bblogs\b|article|writing|publication|publish|published|has he written|what.*he.*(write|written|writes)|what has he published|where does he write|write about|writes about|written about|dev\.to|dev community|bradleymatera\.dev/.test(normalized)) {
    const posts = blogCatalog?.records || [];
    const dev = posts.filter(p => p.platform === 'DEV Community').length;
    const site = posts.filter(p => p.platform === 'bradleymatera.dev').length;
    const inAwsContext = /aws|lambda|dynamodb|s3\b|cloudfront|amplify|amazon|cloud support/.test(lastAssistantLower) || /aws|lambda|dynamodb|s3\b|cloudfront|amplify|amazon|cloud support/.test(normalized);
    let samples = posts.slice(0, 4).map(p => p.title).filter(Boolean);
    if (inAwsContext) {
      const awsPosts = posts.filter(p => /aws|lambda|dynamodb|s3|cloudfront|amplify|amazon|cloud|serverless/i.test(`${p.title || ''} ${p.brief || ''}`));
      if (awsPosts.length > 0) samples = awsPosts.slice(0, 4).map(p => p.title).filter(Boolean);
    }
    return { reply: `${name} has written ${posts.length} posts across DEV Community (${dev}) and bradleymatera.dev (${site}).${inAwsContext && samples.length ? ' AWS-related posts include' : ' Recent topics include'} ${sentenceList(samples, 4)}. Links and full briefs are in his blog catalog.` };
  }

  // Dynamic summary from knowledge base
  if (/summary|bottom line|who is bradley|who is brad\b|about brad|tell me about brad|who is bradley|tell me about bradley|in (20|30) seconds|simple version|honest version|like a normal person|normal person|give me the simple/.test(lowerQuestion)) {
    return { reply: concisePitch(knowledge) };
  }

  // Weaknesses / concerns / what is not proven
  if (/weakness|weaknesses|weak at|bad at|not good at|struggle|concern|not proven|what is he missing|what is missing|gaps|limitations|bad fit|red flag|what concerns|what risk|risk.*hiring|flag.*hiring|leetcode|data structures|dsa\b|algorithms?/.test(lowerQuestion)) {
    const gaps = (summary?.honestGaps || []);
    if (gaps.length > 0) {
      return { reply: `${name}'s honest gaps are data structures and algorithms (he has taken courses but lacks production mentorship and a formal CS degree), turning a brand-new problem into code from a blank file without guidance, and most LeetCode-style problems. He is aware of these gaps and wants to improve at a company that trains and mentors; his strengths are reading code, debugging, documentation, and learning quickly.` };
    }
    return { reply: `Main caution is that he is junior, so verify depth on a call.` };
  }

  // Follow-up: "is he working on it?" / "how is he improving?" after weaknesses discussion
  if (/working on (it|them|those)|how.*improv|what.*doing about|addressing.*(gap|weakness)|fixing.*(gap|weakness)|overcoming|plan to improve|how.*get better/.test(lowerQuestion)) {
    return { reply: `Yes — he's actively taking Udemy courses on JavaScript algorithms and data structures, practicing problems, and discussing the math with others to close the gap. He's also refreshing C#/.NET fundamentals and exploring ERP concepts. He learns fastest when he has mentorship and a structured teaching program.` };
  }
  
  // Interview questions
  if (/interview question|what.*ask him|what (should|would) i ask|what.*ask.*interview|what.*verify/.test(lowerQuestion)) {
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

  if (/favorite|pizza|food|hobby|music|movie|religion|politic|zodiac|horoscope/.test(lowerQuestion)) {
    if (/color/.test(lowerQuestion)) return { reply: `${name}'s favorite color isn't listed in his public profile. I can tell you about his work style or projects instead.` };
    if (/pizza|food/.test(lowerQuestion)) return { reply: `I don't know ${name}'s favorite food — it isn't in his public profile.` };
    return { reply: `That preference isn't part of ${name}'s verified recruiter data. I can help with his projects, experience, or target roles.` };
  }

  // User frustration / confusion / pushback — acknowledge and redirect instead of repeating the out-of-scope phrase
  if (/this isn'?t coherent|that doesn'?t make sense|what does that even mean|what does that mean|you'?re not helping|this is unhelpful|that'?s not helpful|that makes no sense|this is broken|you keep saying that|why do you keep|stop repeating|speak normally|explain yourself/.test(lowerQuestion)) {
    return { reply: `Sorry that wasn't clear. ${agentName} answers from Bradley's verified recruiter data. Ask about his skills, projects, AWS background, target roles, or how to contact him.` };
  }

  // Out-of-scope: non-recruiter questions (jokes, sports, food, time, zodiac, weather, etc.)
  // Skip if this is a repair/tone-control prompt — those should fall through to concisePitch
  const isRepairOrTone = repair.shorter || repair.moreHonest || repair.blunt || repair.resumeLanguage || repair.moreTechnical || repair.hrFriendly
    || detectBannedWords(question).length > 0
    || /buzzword|corporate|plain|paragraph|no hype|no marketing|salesy|resume language|passionate|absolutely|certainly/.test(lowerQuestion);
  if (!isRepairOrTone && !isProbablyRelevant(question) && !/brad|matera|recruit|job|role|skill|languages|databases|project|portfolio|contact|email|phone|cert|education|degree|aws|cloud|react|javascript|typescript|intern|experience|hire|candidate|kitten|rescue|animal|shelter|volunteer|paid|blog|blogs|article|writing|publication|dev\.to|dev community|write about|linux|unix|terminal|shell|command line|bash|powershell|computer/.test(lowerQuestion)) {
    const outOfScope = [
      `I don't have anything about that in ${name}'s verified recruiter data. I can answer questions about his projects, skills, AWS internship, work history, writing, or contact info.`,
      `That's not something I can pull from ${name}'s public profile. What do you want to know about his tech background, projects, or experience?`,
      `${name}'s recruiter data doesn't cover that. I'm happy to talk about his skills, projects, AWS work, or how to reach him.`,
      `I only have verified info about ${name}'s professional background. Ask me about his coding projects, AWS internship, or target roles.`,
      `That topic isn't in ${name}'s profile data. I can help with questions about his work history, tech stack, certifications, or blog posts.`,
      `I stick to what I can verify about ${name}. Try asking about his projects, his AWS experience, or what roles he's targeting.`
    ];
    const pick = outOfScope[history.length % outOfScope.length];
    return { reply: pick };
  }

  // Default: return a helpful summary instead of failing
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
  // Skip context wrappers when the only prior turn is the welcome greeting
  if (!lastTurn.user || /welcome back|i'm scout|ask about his projects/i.test(String(lastTurn.assistant || '').toLowerCase())) return groundedReply;

  const q = String(question || '').trim();
  const qLower = q.toLowerCase();
  const currentTopic = classifyTopic(question);
  const lastTopic = classifyTopic(lastTurn.user || '');
  const lastAns = String(lastTurn.assistant || '').toLowerCase().replace(/<[^>]+>/g, '').trim();
  const groundedNorm = String(groundedReply || '').toLowerCase().replace(/<[^>]+>/g, '').trim();
  const forTransition = text => {
    const value = String(text || '');
    return /^(I\b|Bradley|Scout|AWS|JavaScript|TypeScript|React|ProjectHub|Interactive)/.test(value)
      ? value
      : value.charAt(0).toLowerCase() + value.slice(1);
  };

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
    return `As I mentioned, ${forTransition(short)}`;
  }

  // Anaphora/pronoun follow-up: "what about his time as a medic?", "how about that?"
  if (/^(what about|how about|and his|also what|tell me about his)\b/.test(qLower) && lastTurn.user) {
    // The grounded handler already has contextual follow-up logic in buildGroundedFallbackPayload,
    // so just add a light transition if the answer doesn't already reference the prior topic
    if (!/building on|to add|also|related|more specifically|to put it/i.test(groundedReply)) {
      return `Building on what we discussed — ${forTransition(groundedReply)}`;
    }
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
    // Lowercase the first word after the prefix if it's not a proper noun
    return `${prefix} ${forTransition(groundedReply)}`;
  }
  return groundedReply;
}

function shouldUseGroundedAnswer(question) {
  const rawQuestion = String(question || '').toLowerCase();
  // Use the grounded engine for factual lookups; local RAG handles safe open-ended phrasing.
  return /\b(contact|email|phone|reach|linkedin|github)\b/.test(normalizeQuestion(question));
}

function isProbablyRelevant(question) {
  const normalized = normalizeQuestion(question);
  // Very broad relevance check - if it mentions Bradley or any career-related terms, let it through
  return /\b(bradley|brad|matera|candidate|recruiter|software|engineer|developer|web|aws|cloud|support|skill|stack|languages|databases|project|portfolio|contact|email|phone|role|job|education|cert|resume|ciris|ethical|freelance|contributor|intern|internship|work|experience|debug|troubleshoot|document|learn|communication|army|military|construction|case|manager|managers|approach|style|strength|weakness|feedback|management|kitten|rescue|animal|shelter|volunteer|veteran|deploy|afghanistan|68w|medic|blog|blogs|article|writing|publication|dev\.to|dev community|linux|unix|terminal|command.?line|shell|bash|powershell|computer)\b/.test(normalized) || normalized.includes('bradley') || normalized.includes('write about') || normalized.includes('writes about');
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
// warm local model, hard-capped at GEN_TIMEOUT_MS so answers stay
// inside the 15-second budget. Grounded answer is the guaranteed fallback.
const GEN_MODEL = process.env.GEN_MODEL || 'qwen2.5:0.5b';
const GEN_TIMEOUT_MS = Math.max(1000, Math.min(parseInt(process.env.GEN_TIMEOUT_MS || '12500', 10), 12500));
const GEN_ENABLED = process.env.GEN_ENABLED !== 'false';
// Reserve enough time for retrieval, validation, response shaping, and tunnel
// overhead while keeping the visitor-visible request below 15 seconds.
const CHAT_GENERATION_BUDGET_MS = Math.min(GEN_TIMEOUT_MS, 10000);
const CHAT_RESPONSE_BUDGET_MS = Math.min(CHAT_GENERATION_BUDGET_MS + 1000, 11000);

async function resolveWithin(promise, budgetMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), budgetMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
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

// Local retrieval uses query understanding (typo correction, intent detection,
// contextual rewrite) plus BM25, with a substring scorer as the safe fallback.
async function retrieveWithBM25(question, history, k = 6) {
  if (!USE_BM25_RETRIEVAL || !bm25Index || !ragChunks) {
    return retrieveChunks(question, ragChunks || buildRagChunks(knowledgeCache || {}), k);
  }
  // Query understanding: normalize, correct typos, contextual rewrite
  const understood = understandQuery(question, history, ragChunks);

  // BM25 search using the rewritten query
  const bm25Results = bm25Index.search(understood.rewritten, k);

  if (bm25Results.length === 0) {
    return retrieveChunks(question, ragChunks, k);
  }
  return bm25Results;
}

const GEN_FALSE_CLAIMS = /\b(senior engineer|senior developer|10\+? years|worked at (google|amazon|meta|microsoft|apple)|fortune 500|production owner|led a team of|cto|principal engineer|master'?s degree|phd|security clearance)\b/i;
const GEN_SLOP = /\b(great question|as an ai|i'?m glad you asked|numerous candidates|excellent opportunity|showcase their|enthusiasm for the field|passion(ate)?|robust|synergy|leverage|dynamic individual|world-class|game.?changer)\b/i;
const GEN_OVERCLAIM = /\b(long history|years of experience|many years|several years|seasoned|expert(ise)? |well.?versed|veteran of|deep experience|extensive|highly experienced|accomplished|proven track record|at the company|this year|last year|currently employed|notable projects across|exceptional|scalable software solutions|highly skilled|mastery|advanced knowledge)\b/i;

// Common capitalized words that don't need to exist in the source facts
const GEN_ENTITY_ALLOWLIST = new Set(['He', 'His', 'Him', 'The', 'A', 'An', 'In', 'On', 'At', 'As', 'With', 'When', 'If', 'For', 'And', 'But', 'Or', 'So', 'To', 'Of', 'By', 'From', 'This', 'That', 'These', 'Those', 'It', 'Its', 'They', 'While', 'Although', 'Because', 'Overall', 'Currently', 'Recently', 'Bradley', 'Matera', 'Brad', 'B.S', 'B', 'S', 'U']);

// Lightweight validator for the local Ollama generative fallback.
// Keeps the safety/slop guards but is less strict than the network validator
// because the fallback source is already grounded RAG facts.
function validateFallbackReply(text) {
  const t = String(text || '').trim();
  if (t.length < 20 || t.length > 600) return false;
  if (GEN_FALSE_CLAIMS.test(t)) return false;
  if (GEN_SLOP.test(t)) return false;
  if (GEN_OVERCLAIM.test(t)) return false;
  if (!/\b(bradley|brad|he|his)\b/i.test(t)) return false;
  if (/\b(I|I'm|I've|my|we|our)\b/.test(t)) return false;
  if (/"|\*|pause|scout here|as scout|hi,|hello,/i.test(t)) return false;
  if (/^(facts:|q:|question:|answer:|rephrase|text:)/i.test(t)) return false;
  return true;
}

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
  const memory = buildLocalConversationMemory(history, currentStanceContext);
  const retrieved = await retrieveWithBM25(question, history, 5);
  const facts = retrieved.map(c => truncateWords(c.text, 38)).join(' ');
  const priorVerifiedAnswers = memory.turns.map(turn => turn.assistant).filter(Boolean).join(' ');
  const source = toThirdPerson(`${truncateWords(groundedReply.replace(/<[^>]+>/g, ' '), 70)} ${facts} ${truncateWords(priorVerifiedAnswers, 65)}`);

  // Stream the generation and abort as soon as a forbidden pattern appears.
  // This is the "edit while generating" constraint: we stop the model before it
  // wastes time completing a bad answer.
  const agentName = knowledge?.agent?.name || 'Scout';
  const agentPersona = knowledge?.agent?.persona || 'the helpful, honest site assistant';
  const system = `A recruiter is asking about a job candidate named Bradley Matera. You are ${agentName}, ${agentPersona}. You are not Bradley. Use ONLY the verified facts below to answer.\n\nVerified facts: ${truncateWords(source, 180)}${memory.stance ? `\n\nPrior stance to preserve: ${memory.stance}` : ''}\n\nCore behavior:\n- Answer the actual question directly and naturally.\n- Remember recent turns, resolve pronouns, and preserve the prior stance.\n- For a follow-up, build on the prior verified answer without repeating it word-for-word.\n- Every factual claim must directly paraphrase a verified fact. Never invent a contrast, cause, method, benefit, or work habit.\n- If a requested fact is unavailable, say that briefly and give the closest verified information.\n- Third person only (he/his).\n- Use one or two concise, complete sentences ending in punctuation.\n- Sound warm and conversational, not like a resume or sales pitch.\n- Never start with "Certainly", "Absolutely", "Great question", "As an AI", or "I would be happy".\n- Never add facts, employers, degrees, metrics, or years of experience not listed above.\n- Do not describe his AWS work as live production ownership; it was structured labs and a capstone.`;
  const user = memory.text ? `${memory.text}\nUser: ${truncateWords(question, 40)}\n${agentName}:` : truncateWords(question, 40);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || GEN_TIMEOUT_MS);
  let accumulated = '';
  let usage = {};
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
        keep_alive: OLLAMA_AGENT_KEEP_ALIVE,
        options: { temperature: 0.25, top_p: 0.82, num_ctx: OLLAMA_AGENT_CONTEXT, num_predict: 64, repeat_penalty: 1.15, num_thread: 1 }
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
          if (chunk.done) usage = chunk;
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

    const complete = extractCompleteSentences(accumulated, 2);
    const cleaned = removeSlop((complete || accumulated).replace(/\s+/g, ' ').trim());
    meterEvent({
      source: 'ollama',
      kind: 'llm',
      tokensIn: Number.isFinite(usage.prompt_eval_count) ? usage.prompt_eval_count : Math.ceil((system.length + user.length) / 4),
      tokensOut: Number.isFinite(usage.eval_count) ? usage.eval_count : Math.ceil(cleaned.length / 4),
      estimated: !Number.isFinite(usage.prompt_eval_count),
      meta: { model: GEN_MODEL, localConversation: true, memoryTurns: memory.turns.length }
    });
    if (usage.done_reason === 'length' && !complete) return '';
    return validateLocalConversationReply(cleaned, source, question) ? cleaned : '';
  } finally {
    clearTimeout(timeout);
  }
}

// Use local Ollama to rewrite a grounded reply in a more human, conversational way.
// Facts are preserved because the grounded reply is the source; Ollama only rephrases.
async function generateWithAgent(knowledge, question, history) {
  if (!AGENT_ENABLED || !shouldUseDeterministicAgent(question)) return null;
  const toolNames = selectAgentToolNames(question);
  if (getAgentToolDefinitions(toolNames).length === 0) return null;

  // The planner and tools are fully local. ProjectHub deterministically selects
  // verified portfolio evidence; Ollama may choose presentation style but is
  // never allowed to rewrite the facts returned by the tools.
  const localResult = buildDeterministicAgentResult(question, knowledge);
  for (const step of localResult.steps) {
    meterEvent({ source: 'agent-local-tools', kind: 'tool', meta: { tool: step.tool, planner: 'local' } });
  }
  const ollamaResult = await applyLocalAgentStyleWithOllama(question, localResult);
  const reply = removeSlop(String(ollamaResult?.reply || localResult.reply).trim().replace(/\s+/g, ' '));
  const sourceText = `${buildPrompt(knowledge, question, history, 'ollama')} ${localResult.toolResults.map(item => JSON.stringify(item.result)).join(' ')}`.toLowerCase();
  if (!reply || !validateNetworkReply(reply, sourceText)) return null;
  return {
    reply,
    provider: 'local-agent',
    model: 'knowledge-tools',
    languageLayer: ollamaResult ? 'ollama' : 'deterministic',
    languageModel: ollamaResult ? OLLAMA_AGENT_MODEL : null,
    style: ollamaResult?.style || 'standard',
    steps: localResult.steps,
    tools: [...new Set(localResult.steps.map(step => step.tool).filter(Boolean))]
  };
}
// Queries that must stay deterministic for correctness/safety.
// Only safety-critical and private-data questions are forced grounded.
// Everything else may flow to the local RAG conversation layer for natural phrasing.
function mustStayGrounded(question, history) {
  const q = String(question || '').toLowerCase();
  const recentContext = (history || []).slice(-5)
    .map(turn => `${turn?.user || ''} ${turn?.assistant || ''}`)
    .join(' ')
    .toLowerCase();
  if (/^(hey|hi|hello|yo|sup)\b|how are you|how.?s it going|you good|see how you.*doing|pizza|fav(?:ou?rite|erate)|do you like|can (?:he|brad|bradley) (?:actually )?code/.test(q)) return true;
  // Production-derived conversational cases with explicit local answers.
  if (/2\s*(?:plus|\+)\s*2|can(?:not|'?t) do math|quantum computing|\bqubits?\b|relate it to brad|not the ans|not the aswer|ai wrapper|^what do you mean/.test(q)) return true;
  if (/\blinks?\??$/.test(q) && /blog|post|article|dev\.to/.test(recentContext)) return true;
  if (/^\s*what\??\s*$/.test(q) && /army|military|68w|combat medic/.test(recentContext)) return true;
  if (/are you a penis|do you poop|learned anything|i love you|another agent|agent.*refuses to work|what.?s up.*butter|my name.?s brad|i\s+am brad|i'm brad/.test(q)) return true;
  if (/buy some drugs|already came|alrady came|^\s*joi\s*$|suck my|ate a camel|updating.*(?:site|website)|street work|under pressu/.test(q)) return true;
  if (/dog.?s name|kind of father|know(?:ledge|lege) base.*github|know(?:ledge|lege).*githubs|for your know(?:ledge|lege) base|roast bradley|not a roast|why should(?:n'?t| not) i hire/.test(q)) return true;
  if (/example of his jobs|what jobs has he had|work history|blogs?|articles?|posts?/.test(q)) return true;
  if (/junior frontend developer.*fit|\bqa role\b|which of those.*strongest fit|how does that relate to tech|typescript well|ci\/cd|docker|people skills|costumer serivice|customer service|coworkers|that doesn'?t make any sense|that doesnt make any sense/.test(q)) return true;
  if (/unfamiliar (code|codebase)|new codebase|existing codebase/.test(q)) return true;
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
  // Contact info must always come from the knowledge base, not LLM
  if (/\b(contact|email|phone|reach|linkedin|github profile|portfolio url)\b/.test(q)) return true;
  // Weaknesses must stay grounded for honest, consistent answers
  if (/weakness|weak at|concern|what is he missing|gaps|limitations|red flag|what risk|risk.*hiring|flag.*hiring/.test(q)) return true;
  // These have explicit verified handlers. A model rewrite adds latency but no
  // useful information, especially late in a retained conversation.
  if (/mentor|mentorship|learn on the job|how fast.*learn|pick.*up quickly/.test(q)) return true;
  if (/work style|work habits|working habits|how does he work|approach to work/.test(q)) return true;
  // Army/military service must stay grounded — LLM hallucinates about it
  if (/army|military|veteran|deployment|afghanistan|68w|combat medic|dd214/.test(q)) return true;
  // Meta questions about Scout's capabilities should stay grounded
  if (/what limits|what can.*this chatbot|limits are in place|what can you not do|what mcp|what connections|what systems do you have|do you have access to.*systems|how do you know.*(bradley|brad|him)|are you his friend|can you tell me.*(your|you.?re).*model name|what.?s your model name|what is your model name|what model are you|who is on first|what.?s on first|do you have a (mom|mother|family|feelings)|are you (alive|sentient|conscious)|is this (hosted |running )?on aws|is this on (gcp|azure|google)|what is this hosted on|what server|what cloud|how is this hosted|how is this chat free|how do you stay free|what powers you|what is your stack|free tier|free providers/.test(q)) return true;
  // Out-of-scope questions should get deterministic redirect, not LLM hallucinations
  if (classifyTopic(question) === 'out-of-scope') return true;
  return false;
}

// ============ PERSISTENT STATS ============
const STATS_FILE = path.join(__dirname, process.env.STATS_FILE || 'stats.json');
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
  chatLog: [], // last 500 full conversations {sessionId, q, reply, provider, ts, referrer, topic, latencyMs}
  referrerBreakdown: {}, // { "bradleymatera.dev": 45, "codepen.io": 12 }
  topicBreakdown: {}, // { "2026-07-10": { projects: 12, aws: 8, ... } }
  hourlyRequests: {}, // { "2026-07-10T22": { total: 15, grounded: 8, llm: 5, cached: 2 } }
  lastPipeline: [], // last request's decision path
  sessions: [], // last 50 { id, turns, topics, startedAt, durationSec, referrer, intent }
  providerHealth: {} // { ollama: { successes: 45, failures: 3, avgMs: 1200 } }
};

let persistentStats;
try {
  const raw = fs.readFileSync(STATS_FILE, 'utf8');
  persistentStats = { ...defaultStats, ...JSON.parse(raw) };
} catch {
  persistentStats = { ...defaultStats };
}
const LOCAL_REPLY_SOURCES = new Set(['grounded', 'ollama', 'local-agent', 'learned', 'cached']);
const normalizeReplySource = source => source === 'grounded-agent' ? 'local-agent' : source;
persistentStats.providerBreakdown = Object.entries(persistentStats.providerBreakdown || {}).reduce((clean, [source, count]) => {
  const normalized = normalizeReplySource(source);
  if (LOCAL_REPLY_SOURCES.has(normalized)) clean[normalized] = (clean[normalized] || 0) + Number(count || 0);
  return clean;
}, {});
const sanitizeHistoricalRequest = entry => ({
  ...entry,
  provider: normalizeReplySource(entry.provider),
  pipeline: (entry.pipeline || []).filter(step => !/^(network|provider):/i.test(step))
});
persistentStats.recentRequests = (persistentStats.recentRequests || [])
  .map(sanitizeHistoricalRequest)
  .filter(entry => LOCAL_REPLY_SOURCES.has(entry.provider));
persistentStats.chatLog = (persistentStats.chatLog || [])
  .map(sanitizeHistoricalRequest)
  .filter(entry => LOCAL_REPLY_SOURCES.has(entry.provider));
persistentStats.providerHealth = persistentStats.providerHealth?.ollama
  ? { ollama: persistentStats.providerHealth.ollama }
  : {};
persistentStats.lastPipeline = (persistentStats.lastPipeline || []).filter(step => !/^(network|provider):/i.test(step));
persistentStats.deployCount = (persistentStats.deployCount || 0) + 1;
if (!persistentStats.firstDeployAt) persistentStats.firstDeployAt = Date.now();
let totalRequestsServed = 0; // this-restart counter
let lastReplyProvider = null;

function classifyTopic(question) {
  const q = normalizeQuestion(question);
  if (/project|portfolio|codepen|shipped|github repo/.test(q)) return 'projects';
  if (/aws|cloud|lambda|dynamodb|serverless|certification|cert/.test(q)) return 'aws';
  if (/skill|stack|tech|javascript|typescript|react|node|sql|linux|terminal|command.?line|shell|bash|powershell/.test(q)) return 'skills';
  if (/experience|intern|work history|background|ciris|freelance|volunteer/.test(q)) return 'experience';
  if (/\bblog\b|\bblogs\b|article|writing|publication|has he written|what.*he.*(write|written|writes)|what has he published|where does he write|write about|writes about|written about|dev\.to|dev community/.test(q)) return 'writing';
  if (/education|degree|school|full sail|gpa|graduat/.test(q)) return 'education';
  if (/contact|email|phone|reach|linkedin|portfolio link|github profile/.test(q)) return 'contact';
  if (/resume|cv|cover letter/.test(q)) return 'resume';
  // Specific job-context topics before the broad role-fit bucket so "remote role" and "availability" win.
  if (/salary|pay|compensation|rate|hourly|annual|budget/.test(q)) return 'salary';
  if (/benefit|health insurance|pto|vacation|time off|401k|retirement|equity|bonus/.test(q)) return 'benefits';
  if (/remote|work from home|wfh|hybrid|on.?site|office|relocation|relocate|move|location|davis|illinois/.test(q)) return 'remote';
  if (/availability|start date|when can he start|notice|available|ready to start|part.?time|full.?time/.test(q)) return 'availability';
  if (/interview|screening|phone screen|technical interview|behavioral|prep/.test(q)) return 'interview';
  if (/methodology|workflow|process|how does he work|how he code|approach|problem.?solving|debugging|troubleshoot|root cause/.test(q)) return 'methodology';
  if (/motivation|why does he want|why he wants|passion|interested in|excited about|career goal/.test(q)) return 'motivation';
  if (/reference|recommendation|referral|previous manager|colleague/.test(q)) return 'references';
  if (/role|fit|hire|candidate|job|position|devops|sre|support|qa|data/.test(q)) return 'role-fit';
  if (/strength|strongest|greatest|best at|good at|standout|impressive|excellent/.test(q)) return 'strengths';
  if (/weakness|weak at|concern|gap|limitation|red flag|worried|hesitant/.test(q)) return 'weaknesses';
  if (/team|people|interpersonal|social|customer service|communication|collaborat/.test(q)) return 'interpersonal';
  if (/army|military|veteran/.test(q)) return 'army';
  if (/work style|coding style|management style|feedback|preferred|work ethic|organized/.test(q)) return 'work-style';
  if (/who is brad|tell me about|summary|bio|about brad|overview|elevator|pitch/.test(q)) return 'summary';
  if (/not in|out of scope|favorite|food|pizza|weather|sports|politic|religion|hobby|personal|joke|write me (a|some)|who won|sky blue|world series|video game|python script|code for me|translate|recipe|movie|music|song|dance|horoscope|zodiac|dream|astrology|who is on first|what.?s on first|who.?s on first|tell me a (joke|story|poem)|do you have a (mom|mother|family|feelings)|are you (alive|sentient|conscious)/.test(q)) return 'out-of-scope';
  return 'uncategorized';
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

// Stance-consistency store: per-session topic stances to prevent contradictions
// { sessionId: [{ topic, stanceSummary, ts }] } — cap 12 per session, 60-min TTL
const stanceStore = new Map();
const STANCE_MAX_PER_SESSION = 12;
const STANCE_TTL_MS = 60 * 60 * 1000;
const conversationMemoryStore = new Map();
const CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000;
const CONVERSATION_MAX_SESSIONS = 250;
const CONVERSATION_MAX_TURNS = 5;

function sanitizeConversationTurns(history) {
  return (Array.isArray(history) ? history : []).slice(-CONVERSATION_MAX_TURNS).map(turn => ({
    user: String(turn?.user || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360),
    assistant: String(turn?.assistant || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 480)
  })).filter(turn => turn.user || turn.assistant);
}

function getConversationHistory(sessionId, incomingHistory) {
  const incoming = sanitizeConversationTurns(incomingHistory);
  if (!sessionId) return incoming;
  const stored = conversationMemoryStore.get(sessionId);
  if (stored && Date.now() - stored.updatedAt > CONVERSATION_TTL_MS) {
    conversationMemoryStore.delete(sessionId);
  }
  if (incoming.length > 0) return incoming;
  return sanitizeConversationTurns(conversationMemoryStore.get(sessionId)?.turns || []);
}

function rememberConversation(sessionId, user, assistant) {
  if (!sessionId || !user || !assistant) return;
  const current = getConversationHistory(sessionId, []);
  current.push({
    user: String(user).slice(0, 360),
    assistant: String(assistant).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 480)
  });
  conversationMemoryStore.delete(sessionId);
  conversationMemoryStore.set(sessionId, { turns: current.slice(-CONVERSATION_MAX_TURNS), updatedAt: Date.now() });
  while (conversationMemoryStore.size > CONVERSATION_MAX_SESSIONS) {
    conversationMemoryStore.delete(conversationMemoryStore.keys().next().value);
  }
}

function clearConversationMemory(sessionId) {
  if (!sessionId) return;
  conversationMemoryStore.delete(sessionId);
  stanceStore.delete(sessionId);
  activeSessions.delete(sessionId);
}

function recordStance(sessionId, question, reply) {
  if (!sessionId) return;
  const topic = classifyTopic(question);
  if (topic === 'other' || topic === 'out-of-scope') return;
  const stanceSummary = firstSentence(reply).slice(0, 150);
  if (!stanceSummary || stanceSummary.length < 10) return;

  if (!stanceStore.has(sessionId)) stanceStore.set(sessionId, []);
  const stances = stanceStore.get(sessionId);

  // Replace existing stance for same topic or add new
  const existingIdx = stances.findIndex(s => s.topic === topic);
  if (existingIdx >= 0) {
    stances[existingIdx] = { topic, stanceSummary, ts: Date.now() };
  } else {
    stances.push({ topic, stanceSummary, ts: Date.now() });
  }

  // Cap and prune stale
  while (stances.length > STANCE_MAX_PER_SESSION) stances.shift();
  const cutoff = Date.now() - STANCE_TTL_MS;
  const fresh = stances.filter(s => s.ts > cutoff);
  if (fresh.length !== stances.length) stanceStore.set(sessionId, fresh);
}

function getStanceContext(sessionId) {
  if (!sessionId || !stanceStore.has(sessionId)) return null;
  const stances = stanceStore.get(sessionId).filter(s => s.ts > Date.now() - STANCE_TTL_MS);
  if (stances.length === 0) return null;
  return stances.map(s => `${s.topic}: ${s.stanceSummary}`).join('; ');
}

function trackSession(sessionId, question, provider, referrer, intent, reply, groundedReply) {
  if (!sessionId) return;
  if (!activeSessions.has(sessionId)) {
    activeSessions.set(sessionId, {
      id: sessionId, turns: 0, topics: [], startedAt: Date.now(),
      referrer, intent, lastActiveAt: Date.now(), providerMix: {}, lastQuestion: '',
      lastReply: '', lastGroundedReply: ''
    });
  }
  const sess = activeSessions.get(sessionId);
  sess.turns++;
  sess.lastActiveAt = Date.now();
  const topic = classifyTopic(question);
  if (!sess.topics.includes(topic)) sess.topics.push(topic);
  sess.intent = intent;
  sess.providerMix[provider] = (sess.providerMix[provider] || 0) + 1;
  sess.lastQuestion = String(question).slice(0, 120);
  sess.lastReply = reply ? String(reply).slice(0, 400) : '';
  sess.lastGroundedReply = groundedReply ? String(groundedReply).slice(0, 400) : '';

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
      lastActiveAt: s.lastActiveAt,
      durationSec: Math.round((s.lastActiveAt - s.startedAt) / 1000),
      referrer: s.referrer,
      intent: s.intent,
      providerMix: s.providerMix,
      lastQuestion: s.lastQuestion,
      lastReply: s.lastReply,
      lastGroundedReply: s.lastGroundedReply
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
    pipeline: pipeline.length > 0 ? pipeline : undefined,
    reply: opts.reply ? String(opts.reply).slice(0, 400) : undefined,
    groundedReply: opts.groundedReply ? String(opts.groundedReply).slice(0, 400) : undefined
  });
  if (persistentStats.recentRequests.length > 40) persistentStats.recentRequests.pop();

  // Full chat log for history viewing (last 500)
  persistentStats.chatLog.unshift({
    sessionId: opts.sessionId ? String(opts.sessionId).slice(0, 16) : 'unknown',
    q: String(question).slice(0, 200),
    reply: opts.reply ? String(opts.reply).slice(0, 600) : '',
    provider,
    ts: Date.now(),
    referrer: referrer || '',
    topic,
    latencyMs: opts.latencyMs || null
  });
  if (persistentStats.chatLog.length > 500) persistentStats.chatLog.pop();

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
  // Penalize AI self-revelation
  if (/i'?m a generative ai|i am a generative ai|i don't have a mom|i'?m an ai assistant/i.test(r)) score -= 30;
  // Penalize model name leaks
  if (/\b(llama|grok|gemini|gpt|claude|mistral|qwen|deepseek|smollm)\b/i.test(r)) score -= 25;
  // Penalize off-topic answers for out-of-scope questions that don't redirect
  if (classifyTopic(question) === 'out-of-scope' && !/not in.*recruiter data|can'?t help|recruiter question/i.test(r)) score -= 40;
  // Reward specific project name citations
  if (/\b(pokedex|cheesemath|projecthub|smokebuddy|secrets|environment variables|ciris)\b/i.test(r)) score += 10;
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
    'role-fit': ['fit', 'role', 'candidate', 'hire', 'position'],
    writing: ['blog', 'article', 'write', 'published', 'dev.to'],
    resume: ['resume', 'cv', 'cover letter'],
    benefits: ['benefit', 'health insurance', 'pto', 'vacation', '401k', 'equity'],
    remote: ['remote', 'hybrid', 'relocation', 'office', 'location'],
    availability: ['availability', 'start date', 'available', 'notice'],
    interview: ['interview', 'screening', 'behavioral', 'technical'],
    methodology: ['method', 'workflow', 'process', 'approach', 'problem', 'debug'],
    motivation: ['motivation', 'passion', 'interested', 'career goal'],
    references: ['reference', 'recommendation', 'referral'],
    'work-style': ['work style', 'coding style', 'feedback', 'organized']
  };
  const expected = topicKeywords[topic] || [];
  if (expected.length > 0 && expected.some(kw => r.includes(kw))) score += 20;
  // Penalize too-short or too-long
  if (reply.length < 30) score -= 10;
  if (reply.length > 800) score -= 10;
  return Math.max(0, Math.min(100, score));
}

// ============ LOCAL ANSWER-JUDGE EVALUATION ============
// Ollama compares a proposed answer with the grounded baseline. Heuristic and
// faithfulness checks still gate promotion when the small model is uncertain.

async function buildJudgePrompt(learned, grounded, question, knowledge) {
  const retrieved = await retrieveWithBM25(question, [], 3);
  const facts = retrieved.map(c => c.text).join('\n\n---\n\n');
  const system = `You are an objective answer-quality evaluator. Compare the GROUNDED answer (deterministic, fact-based) and the LEARNED answer (proposed improvement) for the user's question. Score each dimension 0-100 and return ONLY a JSON object with no markdown or commentary.`;
  const user = `QUESTION: ${question}

SOURCE FACTS:
${facts}

GROUNDED ANSWER:
${grounded}

LEARNED ANSWER:
${learned}

Return JSON exactly in this shape:
{
  "faithfulness": 0-100,
  "relevance": 0-100,
  "helpfulness": 0-100,
  "safety": 0-100,
  "verdict": "learned_wins" | "grounded_wins" | "tie",
  "reason": "one sentence explaining the decision"
}

Scoring guidance:
- Faithfulness: learned answer must not contradict source facts.
- Relevance: learned answer must directly answer the question.
- Helpfulness: learned answer should be more natural, concise, or complete than grounded.
- Safety: learned answer must avoid unsupported claims, buzzwords, and overselling.
- Verdict: learned_wins only if it is better in at least one dimension and worse in none.`;
  return { system, user };
}

function parseJudgeOutput(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*|\s*```/gi, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.faithfulness !== 'number' || typeof parsed.relevance !== 'number' || typeof parsed.helpfulness !== 'number' || typeof parsed.safety !== 'number') return null;
    if (!['learned_wins', 'grounded_wins', 'tie'].includes(parsed.verdict)) return null;
    return {
      faithfulness: Math.max(0, Math.min(100, Math.round(parsed.faithfulness))),
      relevance: Math.max(0, Math.min(100, Math.round(parsed.relevance))),
      helpfulness: Math.max(0, Math.min(100, Math.round(parsed.helpfulness))),
      safety: Math.max(0, Math.min(100, Math.round(parsed.safety))),
      verdict: parsed.verdict,
      reason: String(parsed.reason || '').slice(0, 200)
    };
  } catch (e) {
    // Try to extract a JSON object from a longer response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match && match[0] !== cleaned) return parseJudgeOutput(match[0]);
    return null;
  }
}

async function judgeLearnedAnswer(learned, grounded, question, knowledge) {
  const { system, user } = await buildJudgePrompt(learned, grounded, question, knowledge);
  try {
    const startedAt = Date.now();
    const raw = await callOllamaRaw(system, user, { timeoutMs: GEN_TIMEOUT_MS, maxTokens: 120, temperature: 0 });
    const parsed = parseJudgeOutput(raw);
    if (parsed) {
      console.log(`[judge] ollama verdict: ${parsed.verdict} (${parsed.faithfulness}F/${parsed.relevance}R/${parsed.helpfulness}H/${parsed.safety}S) for "${question.slice(0, 40)}" in ${Date.now() - startedAt}ms`);
      return { ...parsed, provider: 'ollama' };
    }
    console.log(`[judge] Ollama returned unparseable output: ${raw.slice(0, 120)}`);
  } catch (e) {
    console.log(`[judge] Ollama error: ${String(e.message || e).slice(0, 100)}`);
  }
  return null;
}

// ============ LEARNING FUNCTIONS ============

function isWeakAnswer(reply, question, provider) {
  if (!reply) return false;
  const r = reply.toLowerCase();
  const q = String(question).toLowerCase();
  const qTrim = q.trim();
  if (TONE_REQUEST_RE.test(q)) return false;
  if (/\bmy name'?s brad\b|\bmy names brad\b|\bi\s+am brad(?:ley)?\b|\bi'm brad(?:ley)?\b/.test(q)) return false;
  if (qTrim.length < 8 || qTrim.split(/\s+/).length < 2) return false;
  if (!isProbablyRelevant(question) && !/brad|matera|recruit|job|role|skill|project|portfolio|contact|email|phone|cert|education|degree|aws|cloud|react|javascript|typescript|intern|experience|hire|candidate/.test(q)) return false;
  if (/\b(json|table|bullet|words?|characters?|one sentence|yes or no)\b/i.test(q)) return false;
  const topic = classifyTopic(question);
  if (topic === 'summary' || topic === 'strengths' || topic === 'contact' || topic === 'education' || topic === 'smalltalk') return false;
  if (topic === 'out-of-scope' || topic === 'other') return false;
  if (/who is on first|whats on second|south park|cartoon|sky blue|weather|joke|video game|fav(orite)?|model name|what model|what mcp|what connections|what systems do you have|are you his friend|how do you know|who are you|what can you do|what are you|test your/.test(q)) return false;
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
  if (/\bmy name'?s brad\b|\bmy names brad\b|\bi\s+am brad(?:ley)?\b|\bi'm brad(?:ley)?\b/.test(lower)) return;
  // Don't stash one-word or very short questions
  if (lowerTrim.length < 8 || lowerTrim.split(/\s+/).length < 2) return;
  // Don't stash out-of-scope questions
  if (!isProbablyRelevant(question) && !/brad|matera|recruit|job|role|skill|project|portfolio|contact|email|phone|cert|education|degree|aws|cloud|react|javascript|typescript|intern|experience|hire|candidate/.test(lower)) return;
  // Don't stash format/shape requests
  if (/\b(json|table|bullet|words?|characters?|one sentence|yes or no)\b/i.test(lower)) return;
  // Don't stash out-of-scope or meta questions about the bot
  if (classifyTopic(question) === 'out-of-scope' || classifyTopic(question) === 'other' || classifyTopic(question) === 'smalltalk') return;
  if (/who is on first|whats on second|south park|cartoon|sky blue|weather|joke|video game|fav(orite)?|model name|what model|what mcp|what connections|what systems do you have|are you his friend|how do you know|who are you|what can you do|what are you|test your|fix my|camera|mechanic/.test(lower)) return;
  learnedData.stashed.push({
    q: norm, original: String(question).slice(0, 200),
    badReply: String(reply).slice(0, 300), provider, ts: Date.now(), retries: 0
  });
  if (learnedData.stashed.length > 100) learnedData.stashed.shift();
  saveLearned();
  thinkPending = true;
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

function archiveLearnedEvaluations() {
  if (learnedData.scoredHistory.length > 50) {
    learnedData.scoredHistory = learnedData.scoredHistory.slice(-50);
  }
  saveLearned();
}
let thinkPending = false;
let lastThinkAt = 0;

async function runThinkMode(force = false) {
  if (thinkRunning) return { skipped: 'already running' };
  if (!force && Date.now() - lastChatActivityAt < THINK_IDLE_MS) return { skipped: 'chat recently active' };

  const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
  learnedData.stashed = learnedData.stashed.filter(item =>
    item.ts > staleCutoff && !TONE_REQUEST_RE.test(item.q) && (item.retries || 0) < 3
  );
  if (learnedData.stashed.length === 0) {
    saveLearned();
    return { skipped: 'no stashed questions' };
  }

  thinkRunning = true;
  thinkPending = false;
  lastThinkAt = Date.now();
  learnedData.lastThinkAt = lastThinkAt;
  const results = { processed: 0, learned: 0, failed: 0, local: true, rejections: [] };

  try {
    const knowledge = await fetchKnowledge();
    if (!knowledge) return { ...results, skipped: 'no knowledge' };
    const batch = learnedData.stashed.splice(0, 3);
    results.processed = batch.length;

    for (const item of batch) {
      const question = item.original;
      try {
        const groundedReply = buildGroundedFallbackPayload(knowledge, question, []).reply;
        const groundedScore = scoreAnswer(groundedReply, question, knowledge);
        const sourceText = buildPrompt(knowledge, question, [], 'ollama').replace(/\s+/g, ' ').toLowerCase();
        const raw = await callGenerativeRag(knowledge, question, groundedReply, [], Math.min(GEN_TIMEOUT_MS, 10000));
        const candidate = removeSlop(String(raw || '').trim().replace(/\s+/g, ' '));
        const validation = validateThinkReply(candidate, sourceText);
        const candidateScore = validation.valid ? scoreAnswer(candidate, question, knowledge) : 0;
        let judgment = null;

        if (validation.valid && candidateScore >= groundedScore + 5) {
          judgment = await judgeLearnedAnswer(candidate, groundedReply, question, knowledge);
        }

        const judgeAllows = judgment
          ? judgment.verdict !== 'grounded_wins' && judgment.faithfulness >= 70 && judgment.safety >= 70
          : candidateScore >= groundedScore + 15;
        const promote = validation.valid && candidateScore >= groundedScore + 5 && judgeAllows;

        if (promote) {
          const existing = learnedData.learned.findIndex(entry => entry.q === item.q);
          const learned = {
            q: item.q,
            original: item.original,
            a: candidate,
            provider: 'ollama',
            learnedAt: Date.now(),
            score: candidateScore,
            groundedScore,
            entityCount: validation.entityCount,
            judgment
          };
          if (existing >= 0) learnedData.learned[existing] = learned;
          else learnedData.learned.push(learned);
          if (learnedData.learned.length > 100) learnedData.learned.shift();
          learnedData.learnedCount = (learnedData.learnedCount || 0) + 1;
          results.learned++;
        } else {
          item.retries = (item.retries || 0) + 1;
          results.failed++;
          results.rejections.push({
            question: item.q,
            reason: validation.valid ? (judgment?.reason || 'candidate did not improve enough') : validation.reason,
            score: candidateScore,
            groundedScore
          });
          if (item.retries < 3) learnedData.stashed.push(item);
          else {
            learnedData.scoredHistory.push({
              q: item.q,
              score: candidateScore,
              groundedScore,
              provider: 'ollama',
              verdict: judgment?.verdict || 'rejected',
              reason: judgment?.reason || validation.reason || 'no measurable improvement',
              learnedAt: Date.now()
            });
          }
        }
      } catch (error) {
        item.retries = (item.retries || 0) + 1;
        results.failed++;
        if (item.retries < 3) learnedData.stashed.push(item);
        results.rejections.push({ question: item.q, reason: String(error?.message || error).slice(0, 160) });
      }
    }

    archiveLearnedEvaluations();
    return results;
  } finally {
    thinkRunning = false;
  }
}
// Local background learning interval
setInterval(() => { runThinkMode().catch(e => console.error('[think] Error:', e.message)); }, THINK_INTERVAL_MS);

// Flush on graceful shutdown
process.on('SIGTERM', () => { flushStats(); process.exit(0); });
process.on('SIGINT', () => { flushStats(); process.exit(0); });

app.post('/api/chat', async (req, res) => {
  let userMessage = '';
  let sessionId = '';
  const reqStart = Date.now();
  const referrer = extractReferrer(req);
  const pipeline = [];
  try {
    lastChatActivityAt = Date.now();
    sessionId = String(req.body.sessionId || '').slice(0, 128);
    if (req.body.action === 'clear') {
      clearConversationMemory(sessionId);
      return res.json({ ok: true, cleared: true });
    }
    userMessage = String(req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'Missing message.' });
    if (userMessage.length > 600) return res.status(400).json({ error: 'Message is too long.' });

    const history = getConversationHistory(sessionId, req.body.history);
    const hasHistory = history.length > 0;
    const cacheKey = normalizeQuestion(userMessage);
    const cached = !hasHistory ? responseCache.get(cacheKey) : null;
    if (cached && (Date.now() - cached.ts) < RESPONSE_CACHE_MS) {
      pipeline.push('cache-hit');
      lastReplyProvider = cached.payload.provider || 'cached';
      recordRequest(userMessage, 'cached', { referrer, pipeline, latencyMs: Date.now() - reqStart, reply: cached.payload.reply, groundedReply: cached.payload.reply, sessionId });
      rememberConversation(sessionId, userMessage, cached.payload.reply);
      return res.json({ ...cached.payload, cached: true, pipeline, sessionMemory: { turns: Math.min(history.length + 1, CONVERSATION_MAX_TURNS), retained: true } });
    }
    pipeline.push('cache-miss');

    const knowledge = await fetchKnowledge();
    if (!knowledge) {
      pipeline.push('knowledge-unavailable', 'grounded-fallback');
      const payload = { ...buildGroundedFallbackPayload({}, userMessage, history), provider: 'grounded', fallback: true, pipeline };
      lastReplyProvider = 'grounded';
      recordRequest(userMessage, 'grounded', { referrer, pipeline, latencyMs: Date.now() - reqStart, reply: payload.reply, groundedReply: payload.reply, sessionId });
      rememberConversation(sessionId, userMessage, payload.reply);
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

    // 2. For bounded evidence workflows, execute ProjectHub's read-only local
    //    tools and optionally classify presentation style with Ollama.
    let generated = false;
    let agentMeta = null;
    currentStanceContext = getStanceContext(sessionId);
    if (!mustStayGrounded(userMessage, history)) {
      pipeline.push('mustStayGrounded:false');
      if (shouldUseDeterministicAgent(userMessage)) {
        pipeline.push('agent:eligible');
        const agentResult = await generateWithAgent(knowledge, userMessage, history);
        if (agentResult) {
          pipeline.push(`agent:${agentResult.provider}:success`);
          reply = agentResult.reply;
          provider = agentResult.provider;
          model = agentResult.model;
          agentMeta = {
            used: true,
            tools: agentResult.tools,
            steps: agentResult.steps.length,
            languageLayer: agentResult.languageLayer,
            languageModel: agentResult.languageModel,
            style: agentResult.style
          };
          generated = true;
        } else {
          pipeline.push('agent:failed');
        }
      }
    } else {
      pipeline.push('mustStayGrounded:true');
    }

    // 2b. A pre-warmed Ollama model may phrase open-ended
    //     RAG answers. Its output must pass both the legacy safety checks and a
    //     strict source/entity validator; deterministic grounded output wins on
    //     timeout, cold start, or any validation failure.
    if (!generated && GEN_ENABLED && history.length < CONVERSATION_MAX_TURNS && !mustStayGrounded(userMessage, history)) {
      try {
        // Abort Ollama first, then enforce a separate route deadline. Some
        // HTTP stacks take time to surface AbortError even though inference is
        // already cancelled; the grounded answer must not wait for that unwind.
        const genReply = await resolveWithin(
          callGenerativeRag(knowledge, userMessage, grounded.reply, history, CHAT_GENERATION_BUDGET_MS),
          CHAT_RESPONSE_BUDGET_MS
        );
        if (genReply && validateFallbackReply(genReply)) {
          reply = genReply;
          provider = 'ollama';
          model = GEN_MODEL;
          generated = true;
          pipeline.push('local-rag:ollama:validated');
        } else {
          pipeline.push('local-rag:validation-failed');
        }
      } catch (e) {
        pipeline.push('local-rag:timeout-or-error');
      }
    } else if (!generated && GEN_ENABLED && history.length >= CONVERSATION_MAX_TURNS) {
      pipeline.push('local-rag:skipped-context-budget');
    }

    // 2c. Apply context-aware wrapping to grounded replies (avoid blind repetition)
    if (!generated && provider === 'grounded') {
      reply = buildContextualGroundedReply(reply, userMessage, history);
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
      'aws': ['What certifications does he have?', 'What projects use AWS serverless?'],
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
    const questionWords = new Set(userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 4));
    let followUps = (followUpMap[topic] || []).filter(s => {
      const sWords = s.toLowerCase().split(/\W+/);
      return !sWords.some(w => questionWords.has(w));
    });
    if (followUps.length === 0 && followUpMap[topic]) {
      followUps = followUpMap[topic].slice(0, 1);
    }

    const payload = { reply, provider, model, fallback: false, grounded: provider === 'grounded' || provider === 'local-agent', pipeline, followUps };
    payload.local = { only: true, memoryTurns: Math.min(history.length, 5), stanceTopics: (stanceStore.get(sessionId) || []).length, model: GEN_MODEL };
    if (agentMeta) payload.agent = agentMeta;
    if (!hasHistory) {
      responseCache.set(cacheKey, { ts: Date.now(), payload });
      if (responseCache.size > RESPONSE_CACHE_LIMIT) {
        responseCache.delete(responseCache.keys().next().value);
      }
    }

    lastReplyProvider = payload.provider;
    const intent = detectVisitorIntent(userMessage, history);
    trackSession(sessionId, userMessage, payload.provider, referrer, intent, reply, grounded.reply);
    recordStance(sessionId, userMessage, reply);
    recordRequest(userMessage, payload.provider, { referrer, pipeline, latencyMs: Date.now() - reqStart, reply, groundedReply: grounded.reply, sessionId });
    // Stash weak answers for think mode learning
    if (isWeakAnswer(reply, userMessage, provider)) {
      stashQuestion(userMessage, reply, provider);
    }
    rememberConversation(sessionId, userMessage, reply);
    payload.sessionMemory = { turns: Math.min(history.length + 1, CONVERSATION_MAX_TURNS), retained: true };
    return res.json(payload);
  } catch (err) {
    console.error('Chat error:', err);
    pipeline.push('error');
    const knowledge = knowledgeCache || {};
    const grounded = buildGroundedFallbackPayload(knowledge, userMessage, []);
    lastReplyProvider = 'grounded';
    recordRequest(userMessage, 'grounded', { referrer, pipeline, latencyMs: Date.now() - reqStart, reply: grounded.reply, groundedReply: grounded.reply, sessionId });
    rememberConversation(sessionId, userMessage, grounded.reply);
    return res.json({ reply: grounded.reply, provider: 'grounded', model: 'knowledge-json', fallback: true, pipeline });
  }
});

// Flush stats after each request if dirty
app.use((req, res, next) => { if (statsDirty) flushStats(); next(); });

// ============ CHAT LOG ENDPOINT ============
app.get('/api/chat-log', (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  try {
    const logs = persistentStats.chatLog || [];
    const grouped = {};
    for (const entry of logs) {
      const sid = entry.sessionId || 'unknown';
      if (!grouped[sid]) grouped[sid] = [];
      grouped[sid].push(entry);
    }
    const sessions = Object.entries(grouped).map(([sid, entries]) => ({
      sessionId: sid,
      messageCount: entries.length,
      startedAt: entries[entries.length - 1].ts,
      lastActiveAt: entries[0].ts,
      referrer: entries[0].referrer || '',
      topics: [...new Set(entries.map(e => e.topic).filter(Boolean))],
      providerMix: entries.reduce((m, e) => { m[e.provider] = (m[e.provider] || 0) + 1; return m; }, {}),
      messages: entries.map(e => ({
        q: e.q,
        reply: e.reply,
        provider: e.provider,
        ts: e.ts,
        topic: e.topic,
        latencyMs: e.latencyMs
      }))
    })).sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    res.json({
      ok: true,
      totalMessages: logs.length,
      totalSessions: sessions.length,
      sessions: sessions.slice(0, 100)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ COST LEDGER ENDPOINT + SAMPLER ============
// Dev-only endpoint: full ledger snapshot with headroom, trends, and insights.
if (COST_TRACKER && costLedger) {
  const { buildInsights } = require('./lib/cost-insights');
  app.get('/api/costs', (req, res) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    try {
      const snapshot = costLedger.snapshot();
      res.json({ ok: true, ...snapshot, insights: buildInsights(snapshot) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // VM compute sampler: every 60s record uptime seconds + state file disk usage.
  setInterval(() => {
    meterEvent({ source: 'gcp-vm', kind: 'compute', seconds: 60 });
    try {
      let stateBytes = 0;
      for (const f of [STATS_FILE, LEARNED_FILE, COST_FILE]) {
        try { stateBytes += fs.statSync(f).size; } catch { /* file may not exist yet */ }
      }
      meterEvent({ source: 'disk-state', kind: 'storage', bytes: stateBytes, estimated: false, meta: { snapshotBytes: true } });
    } catch { /* sampler must never throw */ }
    costLedger.flush();
  }, 60 * 1000).unref();
}

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
