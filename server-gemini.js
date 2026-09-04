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
const { understandQuery, classifyTopic, isRelevant, normalizeQuery } = require('./lib/query-understanding');
const { searchBm25WithRrf } = require('./lib/rrf');
const { executeAgentTool, getAgentToolDefinitions, selectAgentToolNames } = require('./lib/agent-tools');
const { buildLocalConversationMemory, extractCompleteSentences, validateLocalConversationReply } = require('./lib/local-conversation');
const { findDirectAnswer } = require('./lib/knowledge-access');
const localModelRouter = require('./lib/local-model-router');
const cloudflareProvider = require('./lib/cloudflare-provider');
const { runAgentLoop, probeAgent } = require('./lib/agent-engine');
const { runLiteAgent, rewriteQuery } = require('./lib/lite-agent');
const { runRagPrimaryAgent } = require('./lib/rag-agent');
const { buildReasoningPacket, buildSynthesisPacket, estimateTokens } = require('./lib/context-packet');
const { validateAnswer, validateToolDecision, attemptJsonRepair } = require('./lib/grounding-validator');
const { buildFalseClaimsRegex, shouldAbortGeneration, validateFallbackReply } = require('./lib/response-validator');
const { classifyResponsePolicy, findRoleInQuestion: policyFindRole } = require('./lib/response-policy');
const { buildResponseContract } = require('./lib/response-contract');
const sessionState = require('./lib/session-state');

// Legacy Think Mode data stub — learning/Think Mode removed from runtime.
// These objects are kept only so /health and /api/knowledge-health continue
// to return well-formed telemetry without undefined variable errors.
let learnedData = { stashed: [], learned: [], scoredHistory: [], learnedCount: 0, lastThinkAt: 0 };
let thinkRunning = false;
let lastThinkAt = 0;
const THINK_INTERVAL_MS = 20 * 60 * 1000;

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
const HOST = process.env.HOST || '127.0.0.1';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';
const OLLAMA_AGENT_ENABLED = process.env.OLLAMA_AGENT_ENABLED === 'true';
const OLLAMA_AGENT_MODEL = process.env.OLLAMA_AGENT_MODEL || OLLAMA_MODEL;
const OLLAMA_AGENT_TIMEOUT_MS = Math.max(1000, Math.min(parseInt(process.env.OLLAMA_AGENT_TIMEOUT_MS || '2500', 10), 5000));
const OLLAMA_AGENT_CONTEXT = Math.max(512, Math.min(parseInt(process.env.OLLAMA_AGENT_CONTEXT || '1536', 10), 4096));
const OLLAMA_AGENT_KEEP_ALIVE_RAW = process.env.OLLAMA_AGENT_KEEP_ALIVE || '-1';
const OLLAMA_AGENT_KEEP_ALIVE = /^-?\d+$/.test(OLLAMA_AGENT_KEEP_ALIVE_RAW)
  ? Number(OLLAMA_AGENT_KEEP_ALIVE_RAW)
  : OLLAMA_AGENT_KEEP_ALIVE_RAW;

const AGENT_ENABLED = process.env.AGENT_ENABLED !== 'false';
const SCOUT_AGENT_ENGINE_ENABLED = process.env.SCOUT_AGENT_ENGINE_ENABLED === 'true';
// Release mode is LITE: it is validated on the GCP e2-micro target, uses deterministic
// pre-routing, a compact context packet, and a single generation + repair — all within
// the 15s end-to-end deadline. FULL (agent-engine.js) remains available for development
// but is not the production default.
const SCOUT_AGENT_MODE = process.env.SCOUT_AGENT_MODE || (SCOUT_AGENT_ENGINE_ENABLED ? 'lite' : 'legacy');
const DIRECT_KB_ENABLED = process.env.SCOUT_DIRECT_KB_ENABLED === 'true';
const FEATURE_PREVIEW_ENABLED = process.env.FEATURE_PREVIEW_ENABLED === 'true';
const KNOWLEDGE_FILE = path.join(__dirname, process.env.KNOWLEDGE_FILE || 'data/recruiter-knowledge.json');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// Build provenance — set by the deploy script into data/deploy-source.json
let buildInfo = null;
function loadBuildInfo() {
  const buildFile = path.join(__dirname, 'data', 'deploy-source.json');
  try {
    if (fs.existsSync(buildFile)) {
      buildInfo = JSON.parse(fs.readFileSync(buildFile, 'utf8').replace(/^\uFEFF/, ''));
    }
  } catch (e) {
    console.error('[build] failed to read deploy-source.json:', e.message);
  }
  return buildInfo;
}
loadBuildInfo();

let knowledgeCache = null;
let knowledgeCacheAt = 0;
let bm25Index = null;
let ragChunks = null;
const KNOWLEDGE_CACHE_MS = 15 * 60 * 1000;

// Module-level subject/assistant name config — set when knowledge loads
let _moduleSubjectNameAlt = '';
let _modulePreferredName = 'the candidate';
let _moduleAssistantName = 'Scout';

// Readiness state — service is not ready until model verified and knowledge loaded
let modelVerified = false;
let knowledgeReady = false;
const USE_BM25_RETRIEVAL = process.env.USE_BM25_RETRIEVAL !== 'false';
const RESPONSE_CACHE_MS = 30 * 60 * 1000; // 30 min — more cache hits = fewer LLM calls
const RESPONSE_CACHE_LIMIT = 200;
const responseCache = new Map();

// Deterministic technical-error prose. ProseSource is TECHNICAL_ERROR; this is not
// a chatbot fallback and is only emitted when generative inference is unavailable.
const INFERENCE_UNAVAILABLE_REPLY = "I couldn't generate a reliable answer right now. Please try again or rephrase your question.";

// ============ LEARNING SYSTEM ============
// Learning / Think Mode state removed. Scout no longer runs a background
// self-improvement loop that rewrites and caches answers. All visible prose
// comes from DIRECT_KB, MODEL_GENERATION, or TECHNICAL_ERROR.

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
  const provider = process.env.SCOUT_INFERENCE_PROVIDER || 'ollama';
  res.json({ ok: true, service: 'Recruiter Chat API', status: 'online', backend: `scout-rag-memory-tools:${provider}` });
});

// Liveness probe — process is alive
app.get('/health/live', (req, res) => {
  res.status(200).json({ ok: true, status: 'alive' });
});

// Readiness probe — service is ready to accept traffic only when model verified and knowledge loaded
app.get('/health/ready', (req, res) => {
  const ready = modelVerified && knowledgeReady;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    status: ready ? 'ready' : 'warming',
    modelVerified,
    knowledgeReady,
  });
});

const DEPLOYED_AT = Date.now();

function configuredInferenceHealth() {
  const provider = process.env.SCOUT_INFERENCE_PROVIDER || 'auto';
  const localFallbackModel = localModelRouter.ollamaModel() || GEN_MODEL;
  const cloudflareModel = cloudflareProvider.configuredModel();
  const primaryModel = provider === 'cloudflare'
    ? cloudflareModel
    : provider === 'ollama'
      ? localFallbackModel
      : (process.env.CLOUDFLARE_MODEL || cloudflareModel || localFallbackModel);

  return {
    provider,
    primaryModel,
    cloudflareModel,
    localFallbackModel,
    requestDeadlineMs: parseInt(process.env.REQUEST_DEADLINE_MS || '15000', 10),
    generationTimeoutMs: parseInt(process.env.GEN_TIMEOUT_MS || '12500', 10)
  };
}

app.get('/health', async (req, res) => {
  const inferenceHealth = configuredInferenceHealth();
  res.json({
    ok: true,
    status: 'online',
    deployedAt: DEPLOYED_AT,
    build: buildInfo || { sourceCommit: 'unknown' },
    buildEnv: {
      sourceRepository: process.env.SCOUT_SOURCE_REPOSITORY || (buildInfo?.sourceRepository || 'BradleyMatera/ProjectHub'),
      sourceBranch: process.env.SCOUT_SOURCE_BRANCH || (buildInfo?.sourceBranch || 'develop'),
      sourceCommit: process.env.SCOUT_SOURCE_COMMIT || (buildInfo?.sourceCommit || 'unknown'),
      agentMode: SCOUT_AGENT_MODE,
      provider: inferenceHealth.provider,
      primaryModel: inferenceHealth.primaryModel,
      cloudflareModel: inferenceHealth.cloudflareModel,
      localFallbackModel: inferenceHealth.localFallbackModel,
      deadlineMs: inferenceHealth.requestDeadlineMs,
      generationTimeoutMs: inferenceHealth.generationTimeoutMs
    },
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
    local: {
      only: inferenceHealth.provider === 'ollama',
      generation: inferenceHealth.provider,
      deterministicWork: ['session-context', 'bm25-rrf', 'evidence-selection', 'factual-validation'],
      embeddings: 'hash-vector-local',
      persistence: true
    },
    execution: {
      generationProvider: inferenceHealth.provider,
      generationLocation: inferenceHealth.provider === 'cloudflare' ? 'cloud' : (inferenceHealth.provider === 'ollama' ? 'local' : 'external-or-none'),
      ragRetrieval: 'local',
      validation: 'local'
    },
    models: [{ engine: inferenceHealth.provider, model: inferenceHealth.primaryModel, local: inferenceHealth.provider === 'ollama' }],
    agent: {
      enabled: AGENT_ENABLED,
      scoutEngineEnabled: SCOUT_AGENT_ENGINE_ENABLED,
      agentMode: SCOUT_AGENT_MODE,
      ollamaControllerEnabled: OLLAMA_AGENT_ENABLED,
      ollamaModel: OLLAMA_AGENT_MODEL,
      deterministicFallback: false,
      mode: SCOUT_AGENT_ENGINE_ENABLED ? (SCOUT_AGENT_MODE === 'lite' ? 'scout-lite-agent' : 'scout-agent-engine') : 'ollama-rag-tools-memory',
      pinnedModels: localModelRouter.listPinnedModels()
    },
    genModel: process.env.GEN_MODEL || localModelRouter.ollamaModel() || 'qwen2.5:1.5b',
    genTimeoutMs: parseInt(process.env.GEN_TIMEOUT_MS || '12500', 10),
    knowledgeSource: 'bundled-local-json',
    memory: {
      recentTurns: CONVERSATION_MAX_TURNS,
      retainedSessions: conversationMemoryStore.size,
      conversationTtlMinutes: CONVERSATION_TTL_MS / 60000,
      stanceTopics: STANCE_MAX_PER_SESSION,
      stanceTtlMinutes: STANCE_TTL_MS / 60000,
      sessionStateStore: sessionState.storeSize()
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
    const bm25Results = bm25Index
      ? (history.length > 0
          ? searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 6)
          : bm25Index.search(understood.rewritten, 6))
      : [];
    const legacyResults = retrieveChunks(q, ragChunks || buildRagChunks(knowledge), 6);
    res.json({
      ok: true,
      query: q,
      rewritten: understood.rewritten,
      normalized: understood.normalized,
      intent: understood.intent,
      retrievalMethod: history.length > 0 ? 'local-bm25-rrf' : 'local-bm25',
      bm25: bm25Results.map(r => ({ tag: r.tag, text: r.text.slice(0, 120), score: r.score, ranks: r.rrfRanks })),
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

    const testQuestion = `What is the candidate's tech stack?`;
    const startedAt = Date.now();
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
        raw = await callGenerativeRag(knowledge, testQuestion, '', [], Math.min(GEN_TIMEOUT_MS, 8000));
      } catch {}
    }
    const valid = !!raw && validateFallbackReply(raw, knowledge, _moduleSubjectNameAlt, _moduleAssistantName);
    res.json({ ok: true, testQuestion, ollama: { model: GEN_MODEL, reachable: ollamaReachable, connectivityLatencyMs, latencyMs: Date.now() - startedAt, validated: valid, replyPreview: raw.slice(0, 160) } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Agent probe: tests the local Ollama model's reachability and structured-JSON
// capability. Used by the no-cloud test and the private engineering console.
app.get('/api/agent-probe', async (req, res) => {
  try {
    const probe = await probeAgent(localModelRouter.agentModel());
    const tags = await localModelRouter.listLocalModels(3000);
    res.json({
      ok: true,
      engine: SCOUT_AGENT_ENGINE_ENABLED ? (SCOUT_AGENT_MODE === 'lite' ? 'scout-lite-agent' : 'scout-agent-engine') : 'legacy',
      agentMode: SCOUT_AGENT_MODE,
      model: probe.model,
      reachable: probe.reachable,
      structuredOk: probe.structuredOk,
      latencyMs: probe.latencyMs,
      error: probe.error,
      ollamaModels: tags.models,
      pinnedModels: localModelRouter.listPinnedModels(),
      sessionStateStore: sessionState.storeSize()
    });
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
      const words = String(item.q || '').toLowerCase().split(/\s+/).filter(w => w.length > 3 && !/about|what|does|know|tell|please|would|could|should/.test(w));
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

async function fetchKnowledge() {
  const now = Date.now();
  if (knowledgeCache && (now - knowledgeCacheAt) < KNOWLEDGE_CACHE_MS) {
    return knowledgeCache;
  }
  try {
    const json = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));

    // Rebuild the BM25 index FIRST so no concurrent call can return a
    // knowledgeCache while ragChunks/bm25Index are still null. Then publish
    // the cache and clear stale response entries.
    // Rebuild BM25 index and RAG chunks when knowledge refreshes
    try {
      ragChunks = buildRagChunks(json);
      bm25Index = new BM25Index(ragChunks);
      console.log(`[retrieval] BM25 index built: ${ragChunks.length} chunks`);
    } catch (e) {
      console.error('[retrieval] Index build failed:', e.message);
    }
    if (ragChunks && bm25Index) {
      knowledgeCache = json;
      knowledgeCacheAt = now;
      knowledgeReady = true;
      responseCache.clear();
    }

    // Configure claim-extractor with knowledge-derived entity names
    try {
      const claimExtractor = require('./lib/claim-extractor');
      const knowledgeAccess = require('./lib/knowledge-access');
      const scoutIdentity = require('./lib/scout-identity');
      const subjectName = json.identity?.name || '';
      const subjectParts = subjectName ? subjectName.split(/\s+/).map(s => s.toLowerCase()) : [];
      const aliases = (json.subjectAliases || []).map(a => String(a).toLowerCase());
      const assistantName = scoutIdentity.getAssistantName().toLowerCase();
      const projectNames = (json.projects || []).map(p => p.name).filter(Boolean);

      // Set module-level variables for standalone functions
      const preferredName = json.identity?.preferredName || subjectName.split(/\s+/)[0] || 'the candidate';
      _modulePreferredName = preferredName;
      _moduleAssistantName = scoutIdentity.getAssistantName();
      const allAliases = [preferredName.toLowerCase(), ...aliases].filter(Boolean);
      _moduleSubjectNameAlt = allAliases.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      // Rebuild GEN_ABORT_PATTERNS with dynamic assistant name
      GEN_ABORT_PATTERNS = [
        /\b(I\b|I'm|I've|my\b|we\b|our\b)/i,
        /\b(great question|as an ai|i'?m glad|excellent opportunity|showcase|enthusiasm|passionate|robust|synergy|leverage|dynamic|world-class|game.?changer)/i,
        /\b(long history|years of experience|many years|several years|seasoned|expert in|expertise|well.?versed|veteran|deep experience|extensive|highly experienced|accomplished|proven track|at the company|this year|last year|currently employed|notable projects across|exceptional|scalable software|highly skilled|mastery|advanced knowledge)/i,
        /\b(senior engineer|senior developer|10\+? years|worked at (google|amazon|meta|microsoft|apple)|fortune 500|production owner|led a team|cto|principal|master'?s|phd|security clearance)/i,
        new RegExp(`"|\\*|pause|${_moduleAssistantName.toLowerCase()} here|as ${_moduleAssistantName.toLowerCase()}|hi,|hello,`, 'i'),
        /\b\d{4,}\b/
      ];
      claimExtractor.configureEntityNames({
        subjectNames: [...subjectParts, ...aliases],
        assistantNames: [assistantName],
        projectNames
      });
      // Configure completeness-check with subject names
      try {
        const completenessCheck = require('./lib/completeness-check');
        completenessCheck.configureSubjectNames([...subjectParts, ...aliases]);
      } catch (e) {
        console.error('[completeness-check] Configuration failed:', e.message);
      }
      // Configure grounding-validator stopwords with subject names
      try {
        const groundingValidator = require('./lib/grounding-validator');
        groundingValidator.configureStopwords([...subjectParts, ...aliases]);
        groundingValidator.configureAssistantName(assistantName);
      } catch (e) {
        console.error('[grounding-validator] Configuration failed:', e.message);
      }
      // Configure local-conversation stopwords with subject names
      try {
        const localConversation = require('./lib/local-conversation');
        localConversation.configureStopwords([...subjectParts, ...aliases]);
      } catch (e) {
        console.error('[local-conversation] Configuration failed:', e.message);
      }
      // Configure query-understanding with subject names
      try {
        const queryUnderstanding = require('./lib/query-understanding');
        queryUnderstanding.configureSubjectNames([...subjectParts, ...aliases]);
      } catch (e) {
        console.error('[query-understanding] Configuration failed:', e.message);
      }
      // Configure relationship-validator with entity names
      try {
        const relationshipValidator = require('./lib/relationship-validator');
        relationshipValidator.configureEntityNames({
          subjectNames: [...subjectParts, ...aliases],
          assistantNames: [assistantName]
        });
      } catch (e) {
        console.error('[relationship-validator] Configuration failed:', e.message);
      }
      // Configure response-contract with subject names
      try {
        const responseContract = require('./lib/response-contract');
        responseContract.configureSubjectNames([...subjectParts, ...aliases]);
      } catch (e) {
        console.error('[response-contract] Configuration failed:', e.message);
      }
    } catch (e) {
      console.error('[claim-extractor] Configuration failed:', e.message);
    }
    return json;
  } catch (err) {
    console.error('Failed to fetch knowledge:', err.message);
    return knowledgeCache;
  }
}

// Pre-compute grounded replies for common questions so users get fast, consistent answers.
function warmResponseCache(knowledge) {
  // Cache warming removed — cache should only contain generated+validated replies.
  // Deterministic prose is no longer used as final user-visible text.
  console.log('Response cache warming skipped (generative-only policy)');
}

function sentenceList(items, max = 5) {
  if (!items || !items.length) return '';
  const list = items.slice(0, max);
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return list.slice(0, -1).join(', ') + `, and ${list[list.length - 1]}`;
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
    const name = knowledge?.identity?.name || 'the candidate';
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

function buildKnowledgeContext(knowledge) {
  const { identity, summary, goals, education, certifications, experience, skills, projects, rules, interviewStories, blogCatalog } = knowledge || {};
  const name = identity?.name || 'the candidate';
  const title = identity?.title || 'candidate';
  const location = identity?.location || 'their location';
  const preferredName = identity?.preferredName || name.split(/\s+/)[0] || 'the candidate';
  const pronouns = require('./lib/knowledge-access').getSubjectPronouns(knowledge);
  const subj = pronouns.subject || 'they';
  const poss = pronouns.possessive || 'their';

  let context = `${name} is a ${title} based in ${location}. ${subj.charAt(0).toUpperCase() + subj.slice(1)} goes by ${preferredName}.\n\n`;
  context += `VERIFIED FACTS:\n`;
  if (summary?.whoIAm) context += `- Who ${subj} is: ${summary.whoIAm}\n`;
  if (summary?.whatIDo) context += `- What ${subj} does: ${summary.whatIDo}\n`;
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
    const platforms = [...new Set(posts.map(p => p.platform).filter(Boolean))];
    const platformCounts = platforms.map(p => `${p} (${posts.filter(post => post.platform === p).length})`).join(', ');
    context += `- Writing: ${posts.length} posts on ${platformCounts}. Topics include ${posts.slice(0, 5).map(p => p.title).join('; ')}${posts.length > 5 ? '; ...' : ''}\n`;
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
  const name = identity?.name || 'the candidate';
  const preferredName = identity?.preferredName || name.split(/\s+/)[0] || 'the candidate';
  const title = identity?.title || 'candidate';
  const location = identity?.location || 'their location';

  const scoutIdentity = require('./lib/scout-identity');
  const knowledgeAccess = require('./lib/knowledge-access');
  const assistantName = scoutIdentity.getAssistantName();
  const pronouns = knowledgeAccess.getSubjectPronouns(knowledge);
  const subj = pronouns.subject || 'they';
  const poss = pronouns.possessive || 'their';
  let context = `You are ${assistantName}, the assistant for ${name}. You're an approachable recruiter-side helper in a chat widget on the portfolio site. You answer questions about ${name} from verified facts. You are NOT ${name}, but you represent them honestly and warmly.\n\n`;
  context += `${name} is a ${title} based in ${location}. They go by ${preferredName}.\n\n`;

  // RAG context — shared with the grounded fallback so answers stay aligned
  context += buildKnowledgeContext(knowledge);

  context += `\nVOICE AND STYLE:\n`;
  context += `- Answer directly in 1-3 short sentences. More detail only when warranted.\n`;
  context += `- Talk like a normal, helpful person. Not corporate, not a resume, not a sales pitch.\n`;
  context += `- Use verified facts as grounding. Label inferences clearly ("That's not directly stated, but based on...").\n`;
  context += `- Never start with "Certainly", "Absolutely", "Great question", "Of course", "Sure", or "As an AI".\n`;
  context += `- Vary sentence openers. Alternate "${subj.charAt(0).toUpperCase() + subj.slice(1)}...", "${poss.charAt(0).toUpperCase() + poss.slice(1)}...", "From the data...", "Based on...".\n`;
  context += `- Never use: robust, passionate, synergy, leverage, dynamic, extensive, groundbreaking, cutting-edge, innovative, world-class, seasoned, guru.\n`;
  const seniorityBoundaries = require('./lib/knowledge-access').getBoundariesByCategory(knowledge, 'seniority');
  context += `- Don't oversell ${name}. ${seniorityBoundaries.length > 0 ? seniorityBoundaries[0].correction : 'Be honest about experience level.'}\n`;
  context += `- Don't repeat the user's question. Don't end with a sales pitch or vague disclaimer.\n`;
  context += `\nCONVERSATION RULES:\n`;
  context += `- Reference prior context. Resolve pronouns from preceding turns.\n`;
  context += `- Vary phrasing. Don't repeat sentence structure from previous turns.\n`;
  context += `- Add a follow-up question only for open-ended exploration, not direct factual questions.\n`;
  context += `- Include relevant links when useful.\n`;

  if (Array.isArray(history) && history.length > 0) {
    context += `\nRECENT CONVERSATION:\n`;
    history.slice(-3).forEach((turn, i) => {
      context += `User: ${turn.user || ''}\n${assistantName}: ${turn.assistant || ''}\n`;
    });
    if (history.length >= 3) {
      const topicsCovered = history.slice(-3).map(t => classifyTopic(t.user || '', knowledge)).filter(t => t !== 'uncategorized');
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


// ============ RAG GENERATIVE LAYER ============
// Retrieval over the full knowledge JSON + constrained generation on the local
// warm local model, hard-capped at GEN_TIMEOUT_MS so answers stay
// inside the configured budget. Grounded answer is the guaranteed fallback.
const GEN_MODEL = process.env.GEN_MODEL || 'qwen2.5:1.5b';
const GEN_TIMEOUT_MS = Math.max(1000, Math.min(parseInt(process.env.GEN_TIMEOUT_MS || '12500', 10), 60000));
const GEN_ENABLED = process.env.GEN_ENABLED !== 'false';
// Reserve enough time for retrieval, validation, response shaping, and tunnel
// overhead while keeping the visitor-visible request below the configured deadline.
const CHAT_GENERATION_BUDGET_MS = Math.min(GEN_TIMEOUT_MS, 60000);
const CHAT_RESPONSE_BUDGET_MS = Math.min(CHAT_GENERATION_BUDGET_MS + 1000, 61000);

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
  const qWords = normalizeQuery(question, knowledgeCache).split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
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
// contextual rewrite) and RRF-fused BM25 views, with a substring scorer as the
// safe fallback. All retrieval remains local and dependency-free.
async function retrieveWithBM25(question, history, k = 6) {
  if (!USE_BM25_RETRIEVAL || !bm25Index || !ragChunks) {
    return retrieveChunks(question, ragChunks || buildRagChunks(knowledgeCache || {}), k);
  }
  // Query understanding: normalize, correct typos, contextual rewrite
  const understood = understandQuery(question, history, ragChunks);

  // Fuse literal, alias-expanded, and conversation-aware BM25 rankings. The
  // literal view preserves an explicit subject such as COBOL while the context
  // view contributes relevant learning/debugging evidence from prior turns.
  const bm25Results = Array.isArray(history) && history.length > 0
    ? searchBm25WithRrf(
        bm25Index,
        [understood.normalized, understood.expanded, understood.rewritten],
        k,
        { smoothing: 60 }
      )
    : bm25Index.search(understood.rewritten, k);

  if (bm25Results.length === 0) {
    return retrieveChunks(question, ragChunks, k);
  }
  return bm25Results;
}

async function callGenerativeRag(knowledge, question, groundedReply, history, timeoutMs) {
  const memory = buildLocalConversationMemory(history, currentStanceContext);
  const retrieved = await retrieveWithBM25(question, history, 5);
  const facts = retrieved.map(c => truncateWords(c.text, 38)).join(' ');
  const priorVerifiedAnswers = memory.turns.map(turn => turn.assistant).filter(Boolean).join(' ');
  const source = `${truncateWords(groundedReply.replace(/<[^>]+>/g, ' '), 70)} ${facts} ${truncateWords(priorVerifiedAnswers, 65)}`;

  // Stream the generation and abort as soon as a forbidden pattern appears.
  // This is the "edit while generating" constraint: we stop the model before it
  // wastes time completing a bad answer.
  const agentName = knowledge?.agent?.name || require('./lib/scout-identity').getAssistantName();
  const agentPersona = knowledge?.agent?.persona || 'the helpful, honest site assistant';
  const subjectName = knowledge?.identity?.name || 'the candidate';
  const pronouns = require('./lib/knowledge-access').getSubjectPronouns(knowledge);
  const pronounSubj = pronouns.subject || 'they';
  const pronounPoss = pronouns.possessive || 'their';
  const system = `A recruiter is asking about a job candidate named ${subjectName}. You are ${agentName}, ${agentPersona}. You are not ${subjectName}. Use ONLY the verified facts below to answer.\n\nVerified facts: ${truncateWords(source, 180)}${memory.stance ? `\n\nPrior stance to preserve: ${memory.stance}` : ''}\n\nCore behavior:\n- Answer the actual question directly and naturally.\n- Remember recent turns, resolve pronouns, and preserve the prior stance.\n- For a follow-up, build on the prior verified answer without repeating it word-for-word.\n- Every factual claim must directly paraphrase a verified fact. Never invent a contrast, cause, method, benefit, or work habit.\n- If a requested fact is unavailable, say that briefly and give the closest verified information.\n- Third person only (${pronounSubj}/${pronounPoss}).\n- Use one or two concise, complete sentences ending in punctuation.\n- Sound warm and conversational, not like a resume or sales pitch.\n- Never start with "Certainly", "Absolutely", "Great question", "As an AI", or "I would be happy".\n- Never add facts, employers, degrees, metrics, or years of experience not listed above.\n- Do not overstate the experience level beyond what the verified facts support.`;
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
            if (shouldAbortGeneration(clean, knowledge, _moduleSubjectNameAlt, _moduleAssistantName)) {
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
    const cleaned = (complete || accumulated).replace(/\s+/g, ' ').trim();
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
  referrerBreakdown: {}, // { "example.com": 45, "codepen.io": 12 }
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
  // Casual: asks "what is this", "who is the candidate"
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

const CONTROL_TURN_RE = /^(visitor name captured|user profile updated|control|system|memory|note):?/i;

function sanitizeConversationTurns(history) {
  return (Array.isArray(history) ? history : []).slice(-CONVERSATION_MAX_TURNS).map(turn => ({
    user: String(turn?.user || (turn?.role === 'user' ? turn?.content : '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360),
    assistant: String(turn?.assistant || (turn?.role === 'assistant' ? turn?.content : '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 480)
  })).filter(turn => {
    if (!turn.user && !turn.assistant) return false;
    if (turn.assistant && CONTROL_TURN_RE.test(turn.assistant)) return false;
    if (turn.assistant && turn.assistant.length < 8) return false;
    return true;
  });
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
  const topic = classifyTopic(question, knowledgeCache);
  if (topic === 'uncategorized' || topic === 'out-of-scope') return;
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

function safeContractProjection(contract) {
  if (!contract || typeof contract !== 'object') return { error: 'no_plan' };
  if (contract.error) return { error: contract.error, detail: contract.detail };
  return {
    intent: contract.intent,
    subIntent: contract.subIntent,
    policyMode: contract.policyMode,
    directAnswer: contract.directAnswer,
    factState: contract.factState,
    evidenceStrength: contract.evidenceStrength,
    claimCeiling: contract.claimCeiling,
    requestedRole: contract.requestedRole,
    requestedTopic: contract.requestedTopic,
    boundary: contract.boundary,
    forbiddenClaims: contract.forbiddenClaims,
    visitorName: contract.visitorName,
    userName: contract.userName
  };
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
  const topic = classifyTopic(question, knowledgeCache);
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
  const topic = classifyTopic(question, knowledgeCache);
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

// Think Mode removed. Scout does not run a background self-improvement loop
// that stashes, rewrites, or caches visible answers.

// Flush on graceful shutdown
process.on('SIGTERM', () => { flushStats(); process.exit(0); });
process.on('SIGINT', () => { flushStats(); process.exit(0); });

// --- Client-Local Mode Endpoints ---
// These endpoints support browser-local inference:
// 1. /api/client-packet: Server prepares a compact evidence packet for browser generation
// 2. /api/client-validate: Server validates a browser-generated answer against the same evidence

const { preRoute, compressToolResult, buildLitePacket, detectAdversarialCaveat } = require('./lib/lite-agent');
const { buildCompactProfileSummary } = require('./lib/profile-summary');

// In-memory store for evidence packets (short TTL, identified by runId)
const clientPacketStore = new Map();
const CLIENT_PACKET_TTL_MS = 60000; // 1 minute

app.post('/api/client-packet', async (req, res) => {
  try {
    const userMessage = String(req.body.message || '').trim();
    const sessionId = String(req.body.sessionId || '').slice(0, 128);
    if (!userMessage) return res.status(400).json({ error: 'Missing message.' });
    if (userMessage.length > 600) return res.status(400).json({ error: 'Message too long.' });

    const knowledge = await fetchKnowledge();
    if (!knowledge) return res.status(503).json({ error: 'Knowledge not loaded.' });

    const history = getConversationHistory(sessionId, req.body.history);
    const convState = sessionState.getState(sessionId);

    // BM25 retrieval
    const chunks = ragChunks || buildRagChunks(knowledge);
    const understood = understandQuery(userMessage, history, chunks);
    const bm25Results = bm25Index
      ? searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 5)
      : [];
    const evidence = bm25Results.map(r => ({
      kind: r.tag, name: '', description: r.text, evidenceScore: r.rrfScore
    }));

    // Query rewrite (resolve references)
    const { rewritten, changed } = rewriteQuery(userMessage, convState);

    // Pre-route (deterministic tool selection)
    const route = preRoute(rewritten, convState, knowledge);

    // Execute tool
    let toolResult;
    try {
      toolResult = executeAgentTool(route.tool, route.args, knowledge);
    } catch (err) {
      toolResult = { error: 'Tool execution failed.' };
    }

    // Compress evidence
    let compressed = compressToolResult(route.tool, toolResult, 240);

    // Supplement with BM25 evidence if tool result is thin
    if (evidence.length && compressed.length < 200) {
      const evidenceText = evidence.slice(0, 3)
        .map(e => String(e.description || '').slice(0, 120))
        .filter(t => t).join('\n');
      if (evidenceText) compressed = compressed + '\n' + evidenceText;
    }

    // Adversarial caveat — obtain a structured contract, not a pre-written sentence.
    const adversarial = detectAdversarialCaveat(rewritten, compressed, knowledge);

    // Add profile summary for better conversation quality
    const profileSummary = buildCompactProfileSummary();
    if (profileSummary) {
      compressed = profileSummary + '\n\n' + compressed;
    }

    // Build compact packet
    const packet = buildLitePacket({
      question: rewritten,
      compressedEvidence: compressed,
      operation: route.operation,
      maxTokens: 200,
      responseContract: adversarial || undefined
    });

    // For client mode, use plain-text output (better for small models)
    // The buildLitePacket already uses conversational prompt without JSON requirement
    const clientSystemPrompt = packet.systemPrompt;

    // Create a CLIENT_SAFE evidence boundary
    // Only include public-facing evidence, never internal analytics/logs/secrets
    const clientSafeEvidence = {
      systemPrompt: clientSystemPrompt,
      userPrompt: packet.userPrompt,
      operation: route.operation,
      rewritten: changed,
      rewrittenQuery: rewritten,
      adversarial: !!adversarial,
      contextTokens: packet.estimatedTokens
    };

    // Store the full evidence for validation (server-side only)
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    clientPacketStore.set(runId, {
      compressedEvidence: compressed,
      systemPrompt: clientSafeEvidence.systemPrompt,
      toolResult,
      question: rewritten,
      originalQuestion: userMessage,
      sessionId,
      createdAt: Date.now()
    });

    // Clean up expired packets
    const now = Date.now();
    for (const [key, val] of clientPacketStore) {
      if (now - val.createdAt > CLIENT_PACKET_TTL_MS) clientPacketStore.delete(key);
    }

    meterEvent({ source: 'client-local', kind: 'packet', meta: { operation: route.operation, tokens: packet.estimatedTokens } });

    res.json({
      ok: true,
      runId,
      packet: clientSafeEvidence
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/client-validate', async (req, res) => {
  try {
    const runId = String(req.body.runId || '').slice(0, 64);
    const answer = String(req.body.answer || '').trim().slice(0, 600);
    const sessionId = String(req.body.sessionId || '').slice(0, 128);

    if (!runId || !answer) return res.status(400).json({ error: 'Missing runId or answer.' });

    const stored = clientPacketStore.get(runId);
    if (!stored) return res.status(404).json({ ok: false, verdict: 'expired', valid: false });

    // Validate the browser-generated answer against the SAME evidence
    // Include the system prompt in the source text so candidate name and
    // assistant identity are always grounded
    const sourceText = stored.systemPrompt + ' ' + stored.compressedEvidence + ' ' + JSON.stringify(stored.toolResult).slice(0, 2000);
    const knowledge = knowledgeCache || await fetchKnowledge();
    const validation = validateAnswer(answer, sourceText, stored.question, knowledge);

    // Check for forbidden claims in adversarial questions
    // The caveat contract carries forbiddenClaims from the question. If the answer
    // contains any forbidden claim in a non-negated clause, the model has confirmed
    // the false premise.
    const adversarialCaveat = detectAdversarialCaveat(stored.question, stored.compressedEvidence, knowledge);
    let forbidden = false;
    if (adversarialCaveat?.forbiddenClaims?.length) {
      const { hasNegation, splitSentences, splitClauses } = require('./lib/grounding-validator');
      const sentences = splitSentences(answer);
      for (const sent of sentences) {
        const clauses = splitClauses(sent);
        for (const clause of clauses) {
          if (hasNegation(clause)) continue; // refuting clauses are safe
          const lower = clause.toLowerCase();
          for (const claim of adversarialCaveat.forbiddenClaims) {
            if (lower.includes(claim.toLowerCase())) { forbidden = true; break; }
          }
          if (forbidden) break;
        }
        if (forbidden) break;
      }
    }

    const valid = validation.valid && !forbidden;

    meterEvent({
      source: 'client-local',
      kind: 'validation',
      meta: { verdict: validation.verdict, valid, forbidden, reasons: validation.reasons }
    });

    // Update session state if valid
    if (valid) {
      sessionState.updateState(sessionId, stored.originalQuestion, answer, await fetchKnowledge());
    }

    res.json({
      ok: true,
      valid,
      verdict: forbidden ? 'forbidden' : validation.verdict,
      reasons: validation.reasons,
      forbidden
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/client-status', (req, res) => {
  res.json({
    ok: true,
    mode: 'client-local',
    supported: true,
    model: 'Qwen2.5-0.5B-Instruct (ONNX, q4)',
    runtime: 'transformers.js v4 + WebGPU',
    packetStoreSize: clientPacketStore.size
  });
});

app.post('/api/chat', async (req, res) => {
  let userMessage = '';
  let sessionId = '';
  const reqStart = Date.now();
  const referrer = extractReferrer(req);
  const pipeline = [];
  let agentResult = null;

  // 15-second absolute request deadline with propagated cancellation.
  // The AbortController is request-scoped and passed through runLiteAgent
  // → router.generate → Ollama fetch. When the timer fires, controller.abort()
  // terminates all outstanding inference calls immediately.
  const REQUEST_DEADLINE_MS = Math.min(parseInt(process.env.REQUEST_DEADLINE_MS || '15000', 10), 15000);
  const deadlineAt = reqStart + REQUEST_DEADLINE_MS;
  let deadlineFired = false;
  let policy = { mode: 'UNKNOWN' };
  let resolvedMessage = '';
  let queryRewritten = false;
  let evidence = [];
  let agentMeta = null;
  let contractSummary = null;

  // SCOUT_GATE_DEBUG: attach detailed per-turn diagnostics to the response only when requested.
  const gateDebug = process.env.SCOUT_GATE_DEBUG === 'true' || req.body?.gateDebug === true || req.query?.gateDebug === '1';
  if (gateDebug) {
    const origJson = res.json.bind(res);
    res.json = function (obj) {
      if (obj && typeof obj === 'object') {
        obj.diagnostics = {
          question: userMessage,
          resolvedQuery: resolvedMessage || userMessage,
          queryRewritten,
          policy: {
            mode: policy?.mode || 'UNKNOWN',
            directAnswer: policy?.directAnswer || null,
            activeEntity: policy?.activeEntity || null,
            evidenceStatus: policy?.evidenceStatus || null,
            boundary: policy?.boundary || null,
            forbiddenClaims: policy?.forbiddenClaims || []
          },
          contract: contractSummary,
          evidence: (evidence || []).slice(0, 10).map((e, i) => ({
            id: `${e.kind || 'evidence'}-${i + 1}`,
            kind: e.kind || null,
            name: e.name || '',
            snippet: (e.description || '').slice(0, 120)
          })),
          agentMeta,
          pipeline: pipeline.slice(),
          latencyMs: Date.now() - reqStart,
          deadlineFired,
          failureStage: obj.error ? (obj.failureStage || 'UNKNOWN') : null,
          generationCalls: agentMeta?.generationCalls || [],
          proseSource: obj.proseSource || null
        };
      }
      return origJson(obj);
    };
  }

  const requestAbortController = new AbortController();
  const deadlineTimer = setTimeout(() => {
    if (!res.headersSent) {
      deadlineFired = true;
      requestAbortController.abort();
      pipeline.push('deadline-exceeded');
      console.error(`[chat] ${REQUEST_DEADLINE_MS / 1000}s deadline exceeded for session ${sessionId}`);
      res.json({
        ok: false,
        error: 'INFERENCE_UNAVAILABLE',
        pipeline,
        provider: 'deadline',
        latencyMs: Date.now() - reqStart
      });
    }
  }, REQUEST_DEADLINE_MS);

  // Ensure timer doesn't keep process alive
  if (deadlineTimer.unref) deadlineTimer.unref();

  try {
    sessionId = String(req.body.sessionId || '').slice(0, 128);
    if (req.body.action === 'clear') {
      clearTimeout(deadlineTimer);
      clearConversationMemory(sessionId);
      return res.json({ ok: true, cleared: true });
    }
    userMessage = String(req.body.message || '').trim();
    if (!userMessage) { clearTimeout(deadlineTimer); return res.status(400).json({ error: 'Missing message.' }); }
    if (userMessage.length > 600) { clearTimeout(deadlineTimer); return res.status(400).json({ error: 'Message is too long.' }); }

    const history = getConversationHistory(sessionId, req.body.history);
    const hasHistory = history.length > 0;

    const knowledge = await fetchKnowledge();
    if (!knowledge) {
      clearTimeout(deadlineTimer);
      pipeline.push('knowledge-unavailable');
      return res.json({
        ok: false,
        error: 'TENANT_KNOWLEDGE_UNAVAILABLE',
        pipeline,
        provider: 'none',
        latencyMs: Date.now() - reqStart
      });
    }
    pipeline.push('knowledge-loaded');

    // Resolve anaphoric references using the server-owned conversation state and
    // history BEFORE routing or direct-answer matching. This makes "What
    // technology does it use?" resolve to "What technology does ProjectHub (Scout)
    // use?" and prevents broad direct-answer patterns from misfiring.
    const preGenerationState = sessionState.getState(sessionId);
    resolvedMessage = userMessage;
    queryRewritten = false;

    // Classify the conversational act FIRST. Greetings, small talk, request-to-say,
    // and clarification do not require candidate evidence and must not be rewritten
    // into candidate queries by anaphora resolution.
    const NO_RETRIEVAL_MODES = new Set(['GREETING', 'USER_PROFILE_UPDATE', 'USER_PROFILE_QUERY', 'THANKS', 'FAREWELL', 'HELP', 'CONVERSATIONAL', 'SMALL_TALK', 'REQUEST_TO_SAY', 'CLARIFY_PREVIOUS_ASSISTANT']);
    policy = classifyResponsePolicy(userMessage, history, knowledge);

    if (SCOUT_AGENT_ENGINE_ENABLED && !NO_RETRIEVAL_MODES.has(policy.mode)) {
      const rewrite = rewriteQuery(userMessage, preGenerationState, knowledge, history);
      if (rewrite && rewrite.rewritten_ && rewrite.rewritten !== userMessage) {
        resolvedMessage = rewrite.rewritten;
        queryRewritten = true;
        pipeline.push('query-rewrite');
      }
      policy = classifyResponsePolicy(resolvedMessage, history, knowledge);
    }
    pipeline.push(`policy:${policy.mode}`);
    // expose policy for diagnostics
    policy = Object.assign({}, policy);

    const cacheKey = normalizeQuery(resolvedMessage, knowledge);

    // Direct KB short-circuit (opt-in): if the question matches a non-adversarial
    // directAnswer record, return it immediately. RAG-first mode keeps this OFF so
    // all substantive answers are generated from retrieved evidence.
    const directAnswer = (DIRECT_KB_ENABLED && SCOUT_AGENT_ENGINE_ENABLED) ? findDirectAnswer(knowledge, resolvedMessage) : null;
    const directIntentAllowed = Array.isArray(directAnswer?.intents) && (directAnswer.intents.includes('direct') || directAnswer.intents.includes('adversarial_deny') || directAnswer.intents.includes('negation_confirm'));
    const policyBlocksDirect = policy.mode === 'REFUSAL' || policy.mode === 'OUT_OF_SCOPE';
    if (DIRECT_KB_ENABLED && directAnswer && directAnswer.answer && directIntentAllowed && !policyBlocksDirect) {
      pipeline.push('direct-kb');
      const directReply = directAnswer.answer;
      const directEvidence = (directAnswer?.answer || '');
      let directContract = null;
      try {
        directContract = buildResponseContract(resolvedMessage, directEvidence, knowledge, history || []);
      } catch (e) { directContract = { error: 'contract_build_failed', detail: e.message }; }
      // A direct answer is semantically applicable only if it matches the resolved plan.
      // Example: a historical seniority boundary must not answer a future-potential question.
      const isAdversarialDenial = Array.isArray(directAnswer.intents) && directAnswer.intents.includes('adversarial_deny');
      const isFutureQuestion = ['FUTURE_CAPABILITY', 'FUTURE_ROLE'].includes(directContract?.intent);
      const directApplicable = !(isAdversarialDenial && isFutureQuestion);
      if (!directApplicable) {
        pipeline.push('direct-kb-skipped');
      } else {
      const directPayload = {
        ok: true,
        reply: directReply,
        provider: 'knowledge-base',
        model: 'direct',
        fallback: false,
        grounded: true,
        pipeline,
        followUps: [],
        proseSource: 'DIRECT_KB',
        direct: true,
        sourceIds: directAnswer.sourceIds || [],
        sessionMemory: { turns: Math.min(history.length + 1, CONVERSATION_MAX_TURNS), retained: true },
        contract: directContract
      };
      if (!hasHistory) {
        responseCache.set(cacheKey, { ts: Date.now(), payload: directPayload });
      }
      rememberConversation(sessionId, userMessage, directReply);
      sessionState.updateState(sessionId, userMessage, directReply, knowledge, null);
      recordRequest(userMessage, 'knowledge-base', { referrer, pipeline, latencyMs: Date.now() - reqStart, reply: directReply, groundedReply: directReply, sessionId });
      clearTimeout(deadlineTimer);
      if (!res.headersSent) return res.json(directPayload);
      }
    }

    const cached = !hasHistory && !gateDebug ? responseCache.get(cacheKey) : null;
    if (cached && (Date.now() - cached.ts) < RESPONSE_CACHE_MS) {
      clearTimeout(deadlineTimer);
      pipeline.push('cache-hit');
      lastReplyProvider = cached.payload.provider || 'cached';
      recordRequest(userMessage, 'cached', { referrer, pipeline, latencyMs: Date.now() - reqStart, reply: cached.payload.reply, groundedReply: cached.payload.reply, sessionId });
      rememberConversation(sessionId, userMessage, cached.payload.reply);
      sessionState.updateState(sessionId, userMessage, cached.payload.reply, knowledge, null);
      return res.json({ ...cached.payload, cached: true, pipeline, sessionMemory: { turns: Math.min(history.length + 1, CONVERSATION_MAX_TURNS), retained: true } });
    }
    pipeline.push('cache-miss');

    // 1. Classify response policy — deterministic code decides WHAT to say,
    //    not the final prose. The policy contract guides generative inference.
    //    (Policy was already classified earlier; it is reused here.)

    // Commit any conversational control intent (greeting, name update, etc.)
    // BEFORE generation, so the model can see the just-introduced user state.
    sessionState.applyControlIntent(sessionId, resolvedMessage, knowledge, policy.mode);

    // Default reply is NOT set — all prose must come from generative inference.
    // If inference fails, we return INFERENCE_UNAVAILABLE.
    let reply = null;
    let provider = 'pending';
    let model = 'pending';

    // 2. ALL queries go through generative inference. Deterministic code
    //    classifies, retrieves, and builds contracts but does NOT write prose.
    let generated = false;
    let agentEvents = null;
    let inferenceProvider = localModelRouter.inferenceProvider || 'ollama';
    currentStanceContext = getStanceContext(sessionId);

    // 2a. Scout Agent Engine — the ONLY generative path. Policy contract
    //     from classifyResponsePolicy is injected into the lite agent prompt.
    //     No mustStayGrounded gate — all queries go through generation.
    if (SCOUT_AGENT_ENGINE_ENABLED) {
      pipeline.push(`scout-agent-${SCOUT_AGENT_MODE}:eligible`);
      try {
        // Retrieve evidence via BM25 for the agent context packet.
        // Retrieval is always performed; the agent decides whether to use it.
        const understood = understandQuery(resolvedMessage, history, ragChunks || buildRagChunks(knowledge));
        const _bm25Results = bm25Index
          ? searchBm25WithRrf(bm25Index, [understood.normalized, understood.expanded, understood.rewritten], 10)
          : [];
        evidence = _bm25Results.map(r => ({
          kind: r.tag || r.chunk?.kind || 'evidence',
          name: r.chunk?.title || r.chunk?.name || '',
          description: r.text || r.chunk?.text || r.chunk?.description || '',
          tech: r.chunk?.tech || [],
          skills: r.chunk?.skills || [],
          category: r.chunk?.category || null,
          url: r.chunk?.url || null,
          evidenceScore: r.rrfScore || r.score
        })).filter(e => e.description);

        // Policy-driven evidence backfill: some policy modes require chunk
        // categories that BM25 may not surface for terse phrasings (e.g.
        // "give me links" needs the contact chunk). Append any missing
        // required chunks so the agent sees the evidence the contract
        // promises, rather than answering from an empty retrieval set.
        const POLICY_REQUIRED_TAGS = {
          CONTACT: ['contact', 'identity']
        };
        const requiredTags = POLICY_REQUIRED_TAGS[policy.mode];
        if (requiredTags) {
          const allChunks = ragChunks || buildRagChunks(knowledge);
          const presentTags = new Set(evidence.map(e => e.kind));
          for (const chunk of allChunks) {
            if (requiredTags.includes(chunk.tag) && !presentTags.has(chunk.tag) && chunk.text) {
              evidence.push({
                kind: chunk.tag,
                name: chunk.title || '',
                description: chunk.text,
                tech: chunk.tech || [],
                skills: chunk.skills || [],
                category: chunk.category || null,
                url: chunk.url || null,
                evidenceScore: 0
              });
              presentTags.add(chunk.tag);
            }
          }
        }

        // Get server-owned structured conversation state (now includes any just-
        // committed conversational-control intent, e.g. userName).
        const convState = sessionState.getState(sessionId);

        // Select execution strategy based on SCOUT_AGENT_MODE
        // Policy contract from classifyResponsePolicy is injected to guide generation
        const policyContract = {
          mode: policy.mode,
          ...policy,
        };
        delete policyContract.contract; // flatten — no nested contract object
        agentResult = SCOUT_AGENT_MODE === 'lite'
          ? await runRagPrimaryAgent({
              question: resolvedMessage,
              conversationState: convState,
              evidence,
              knowledge,
              sessionId,
              model: localModelRouter.agentModel(),
              policyContract,
              deadlineAt,
              abortSignal: requestAbortController.signal
            })
          : await runAgentLoop({
              question: userMessage,
              conversationState: convState,
              evidence,
              knowledge,
              sessionId,
              model: localModelRouter.agentModel()
            });

        // Derive actual inference provider from router (not hardcoded)
        inferenceProvider = localModelRouter.inferenceProvider || 'ollama';

        // Meter each actual provider call from the agent's canonical accounting.
        for (const call of (agentResult.generationCalls || [])) {
          meterEvent({
            source: call.provider || inferenceProvider,
            kind: 'llm',
            tokensIn: call.inputTokens || 0,
            tokensOut: call.outputTokens || 0,
            meta: {
              attemptIndex: call.attemptIndex,
              attemptType: call.attemptType,
              model: call.model,
              ok: call.ok,
              accepted: call.accepted,
              actualNeurons: call.actualNeurons ?? null,
              estimatedNeurons: call.estimatedNeurons ?? null
            }
          });
        }

        if (!agentResult.fallback && agentResult.reply) {
          pipeline.push(`scout-agent-${SCOUT_AGENT_MODE}:${inferenceProvider}:${agentResult.outcome || 'success'}`);
          reply = agentResult.reply;
          provider = inferenceProvider;
          model = agentResult.model;
          const _validationVerdict = agentResult.validation?.verdict;
          agentMeta = {
            used: true,
            engine: SCOUT_AGENT_MODE === 'lite' ? 'scout-lite' : 'scout-agent',
            agentMode: SCOUT_AGENT_MODE,
            inferenceProvider,
            tools: (agentResult.toolResults || []).map(t => t.tool),
            steps: agentResult.steps.length,
            contextTokens: agentResult.contextTokens,
            validation: _validationVerdict || null,
            outcome: agentResult.outcome || 'accepted',
            executionEngine: SCOUT_AGENT_MODE === 'lite' ? 'scout-lite' : 'scout-agent',
            languageLayer: inferenceProvider,
            languageModel: agentResult.model,
            ...(SCOUT_AGENT_MODE === 'lite' ? {
              operation: agentResult.operation,
              queryRewritten: agentResult.rewritten,
              rewrittenQuery: agentResult.rewrittenQuery,
              generationCalls: agentResult.generationCalls || [],
              actualProviderCalls: agentResult.actualProviderCalls ?? null,
              retrievalCandidates: agentResult.retrievalCandidates || [],
              selectedEvidence: agentResult.selectedEvidence || [],
              toolEnrichment: agentResult.toolEnrichment || '',
              rawPrimary: agentResult.rawPrimary || null,
              rawRepair: agentResult.rawRepair || null
            } : {})
          };
          agentEvents = agentResult.events;
          generated = true;
        } else if (agentResult.inferenceUnavailable) {
          agentMeta = agentMeta || {};
          // All generative attempts failed — return typed service-unavailable response
          pipeline.push(`scout-agent-${SCOUT_AGENT_MODE}:inference-unavailable`);
          agentEvents = agentResult.events;
          agentMeta = {
            used: true,
            engine: SCOUT_AGENT_MODE === 'lite' ? 'scout-lite' : 'scout-agent',
            executionEngine: SCOUT_AGENT_MODE === 'lite' ? 'scout-lite' : 'scout-agent',
            agentMode: SCOUT_AGENT_MODE,
            inferenceProvider,
            tools: (agentResult.toolResults || []).map(t => t.tool),
            steps: agentResult.steps.length,
            contextTokens: agentResult.contextTokens,
            outcome: 'inference_unavailable',
            generationAttempts: agentResult.generationAttempts || 0,
            ...(SCOUT_AGENT_MODE === 'lite' ? {
              operation: agentResult.operation,
              queryRewritten: agentResult.rewritten,
              generationCalls: agentResult.generationCalls || [],
              actualProviderCalls: agentResult.actualProviderCalls ?? null,
              retrievalCandidates: agentResult.retrievalCandidates || [],
              selectedEvidence: agentResult.selectedEvidence || [],
              toolEnrichment: agentResult.toolEnrichment || '',
              rawPrimary: agentResult.rawPrimary || null,
              rawRepair: agentResult.rawRepair || null
            } : {})
          };
          if (res.headersSent) return;
          return res.json({
            ok: false,
            error: 'INFERENCE_UNAVAILABLE',
            failureStage: 'GENERATION',
            reply: INFERENCE_UNAVAILABLE_REPLY,
            proseSource: 'TECHNICAL_ERROR',
            pipeline,
            provider: inferenceProvider,
            model: agentResult.model,
            latencyMs: Date.now() - reqStart,
            agentMeta,
            agentEvents,
            retrievalCandidates: agentMeta?.retrievalCandidates || evidence.slice(0, 10).map((e, i) => ({ kind: e.kind || 'evidence', tag: e.kind || 'evidence', name: e.name || '', id: `${e.kind || 'evidence'}-${i + 1}` })) || [],
            generationAttempts: agentResult.generationAttempts || 0,
            contract: safeContractProjection(agentResult.responseContract)
          });
        } else {
          pipeline.push(`scout-agent-${SCOUT_AGENT_MODE}:fallback:${agentResult.fallback ? 'true' : 'false'}`);
          // Store events even on fallback for diagnostics
          agentEvents = agentResult.events;
          agentMeta = {
            used: true,
            engine: SCOUT_AGENT_MODE === 'lite' ? 'scout-lite' : 'scout-agent',
            executionEngine: SCOUT_AGENT_MODE === 'lite' ? 'scout-lite' : 'scout-agent',
            agentMode: SCOUT_AGENT_MODE,
            inferenceProvider,
            tools: (agentResult.toolResults || []).map(t => t.tool),
            steps: agentResult.steps.length,
            contextTokens: agentResult.contextTokens,
            validation: 'fallback',
            fallbackReason: agentResult.events?.find(e => e.type === 'agent_fallback' || e.type === 'lite_fallback')?.reason || 'unknown',
            ...(SCOUT_AGENT_MODE === 'lite' ? {
              operation: agentResult.operation,
              queryRewritten: agentResult.rewritten,
              generationCalls: agentResult.generationCalls || [],
              actualProviderCalls: agentResult.actualProviderCalls ?? null,
              retrievalCandidates: agentResult.retrievalCandidates || [],
              selectedEvidence: agentResult.selectedEvidence || [],
              toolEnrichment: agentResult.toolEnrichment || '',
              rawPrimary: agentResult.rawPrimary || null,
              rawRepair: agentResult.rawRepair || null
            } : {})
          };
        }
      } catch (e) {
        pipeline.push(`scout-agent-${SCOUT_AGENT_MODE}:error:${String(e?.message || e).slice(0, 60)}`);
      }
    } else {
      // Agent engine not enabled — no chatbot fallback.
      pipeline.push('agent-engine-unavailable');
      clearTimeout(deadlineTimer);
      if (res.headersSent) return;
      return res.json({
        ok: false,
        error: 'AGENT_ENGINE_UNAVAILABLE',
        reply: INFERENCE_UNAVAILABLE_REPLY,
        proseSource: 'TECHNICAL_ERROR',
        pipeline,
        provider: 'none',
        latencyMs: Date.now() - reqStart
      });
    }

    // 2b. If no generative path succeeded, return INFERENCE_UNAVAILABLE.
    //     No deterministic prose fallback — server is transport only.
    if (!generated) {
      pipeline.push('inference-unavailable:no-generative-path');
      if (res.headersSent) return;
      return res.json({
        ok: false,
        error: 'INFERENCE_UNAVAILABLE',
        reply: INFERENCE_UNAVAILABLE_REPLY,
        proseSource: 'TECHNICAL_ERROR',
        pipeline,
        provider: inferenceProvider || 'none',
        model: agentResult?.model || localModelRouter.defaultModel() || GEN_MODEL,
        latencyMs: Date.now() - reqStart,
        agentMeta,
        agentEvents,
        retrievalCandidates: agentResult?.retrievalCandidates || evidence.slice(0, 10) || [],
        failureStage: 'GENERATION',
        generationAttempts: agentResult?.generationAttempts ?? 0,
        contract: safeContractProjection(agentResult?.responseContract)
      });
    }

    // 3. Deterministic format compliance (one sentence, bullets, JSON, word caps, tone controls)
    //     shapeReply transforms the generated reply's FORMAT but does NOT write new prose.
    if (reply) reply = shapeReply(reply, userMessage, knowledge);
    pipeline.push('shaped');

    // 3b. Frustration detection — switch to ultra-direct mode
    const frustrationPatterns = /not making sense|makes no sense|just answer|why can't you|you.?re not|stop avoiding|answer the question|just tell me|be direct/;
    if (frustrationPatterns.test(userMessage.toLowerCase())) {
      pipeline.push('frustration-detected');
      // Strip any preamble or suggestions — just give the answer
      reply = reply.replace(/^(sorry|apolog|my bad)[^.]*\.\s*/i, '').replace(/\s*(ask me about|try asking|you can also ask).*$/i, '').trim();
    }

    // 3c. Follow-up suggestions are model-generated or KB-driven, not hardcoded
    const followUps = [];

    // Build a client-safe contract summary from the executed semantic plan.
    // The lite agent already computed and returned the authoritative responseContract.
    // Rebuilding it here is only a defensive fallback and must not become the primary source.
    let contractSummary = null;
    const executedPlan = agentResult?.responseContract;
    if (executedPlan && !executedPlan.error) {
      contractSummary = {
        intent: executedPlan.intent,
        subIntent: executedPlan.subIntent,
        policyMode: executedPlan.policyMode,
        directAnswer: executedPlan.directAnswer,
        factState: executedPlan.factState,
        evidenceStrength: executedPlan.evidenceStrength,
        claimCeiling: executedPlan.claimCeiling,
        requestedRole: executedPlan.requestedRole,
        requestedTopic: executedPlan.requestedTopic,
        boundary: executedPlan.boundary,
        forbiddenClaims: executedPlan.forbiddenClaims
      };
    } else {
      const compressedEvidence = (evidence || []).map(e => e.description || '').filter(Boolean).join('\n');
      try {
        const responseContract = buildResponseContract(agentResult?.rewrittenQuery || userMessage, compressedEvidence, knowledge, history || []);
        contractSummary = {
          intent: responseContract.intent,
          subIntent: responseContract.subIntent,
          policyMode: responseContract.policyMode,
          directAnswer: responseContract.directAnswer,
          factState: responseContract.factState,
          evidenceStrength: responseContract.evidenceStrength,
          claimCeiling: responseContract.claimCeiling,
          requestedRole: responseContract.requestedRole,
          requestedTopic: responseContract.requestedTopic,
          boundary: responseContract.boundary,
          forbiddenClaims: responseContract.forbiddenClaims
        };
      } catch (e) {
        contractSummary = { error: 'contract_build_failed', detail: e.message };
      }
    }

    const payload = { ok: true, reply, provider, model, fallback: false, grounded: provider === 'grounded' || provider === 'local-agent', pipeline, followUps, proseSource: agentResult?.proseSource || 'MODEL_GENERATION', contract: contractSummary };
    payload.local = { only: true, memoryTurns: Math.min(history.length, 5), stanceTopics: (stanceStore.get(sessionId) || []).length, model: model || localModelRouter.defaultModel() };
    if (agentMeta) payload.agent = agentMeta;
    if (agentEvents) payload.agentEvents = agentEvents;
    if (!hasHistory) {
      responseCache.set(cacheKey, { ts: Date.now(), payload });
      if (responseCache.size > RESPONSE_CACHE_LIMIT) {
        responseCache.delete(responseCache.keys().next().value);
      }
    }

    lastReplyProvider = payload.provider;
    const intent = detectVisitorIntent(userMessage, history);
    trackSession(sessionId, userMessage, payload.provider, referrer, intent, reply, null);
    recordRequest(userMessage, payload.provider, { referrer, pipeline, latencyMs: Date.now() - reqStart, reply, groundedReply: null, sessionId });
    rememberConversation(sessionId, userMessage, reply);
    // Update server-owned structured conversation state (topic, projects, job, references)
    sessionState.updateState(sessionId, userMessage, reply, knowledge, null);
    payload.sessionMemory = { turns: Math.min(history.length + 1, CONVERSATION_MAX_TURNS), retained: true };
    clearTimeout(deadlineTimer);
    if (!res.headersSent) return res.json(payload);
  } catch (err) {
    console.error('Chat error:', err);
    pipeline.push('error');
    clearTimeout(deadlineTimer);
    if (!res.headersSent)    return res.json({
      ok: false,
      error: 'INTERNAL_ERROR',
      proseSource: 'TECHNICAL_ERROR',
      pipeline,
      provider: 'none',
      latencyMs: Date.now() - reqStart,
      failureStage: 'INTERNAL_ERROR',
      contract: safeContractProjection(agentResult?.responseContract)
    });
  }
  // If we reach here without sending a response, the deadline timer fired
  // and already sent INFERENCE_UNAVAILABLE. Nothing more to do.
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
// Cost ledger endpoint: full snapshot with headroom, trends, and insights when
// the tracker is enabled. When disabled, mount a stub that returns 200 so the
// analytics dashboard sees a clean "offline" state instead of a 404.
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
} else {
  app.get('/api/costs', (req, res) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.json({ ok: false, offline: true, reason: 'COST_TRACKER is not enabled on this backend' });
  });
}

// Model/image digest enforcement — verify the exact model image is loaded
// at startup to prevent silent model drift in production.
// In qualification mode (SCOUT_QUALIFICATION_MODE=true), a pinned digest
// is REQUIRED. In development mode, the digest pin is optional.
async function verifyModelDigest() {
  // When using Cloudflare Workers AI, there is no local Ollama model to verify.
  if (process.env.SCOUT_INFERENCE_PROVIDER === 'cloudflare') {
    const cfModel = process.env.CLOUDFLARE_MODEL || cloudflareProvider.configuredModel();
    console.log(`[startup] Cloudflare Workers AI provider active, model: ${cfModel} (no local digest verification needed)`);
    modelVerified = true;
    return;
  }
  const expectedModel = process.env.GEN_MODEL || 'qwen2.5:1.5b';
  const expectedDigest = process.env.OLLAMA_MODEL_DIGEST || '';
  const qualificationMode = process.env.SCOUT_QUALIFICATION_MODE === 'true';

  if (qualificationMode && !expectedDigest) {
    console.error('[startup] QUALIFICATION MODE: OLLAMA_MODEL_DIGEST is required but not set.');
    console.error('[startup] Set OLLAMA_MODEL_DIGEST to the known-qualified digest or disable SCOUT_QUALIFICATION_MODE.');
    if (process.env.SCOUT_QUALIFICATION_FAIL_OPEN !== 'true') {
      console.error('[startup] STARTUP FAILED: qualification requires pinned digest.');
      process.exit(1);
    }
  }

  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' });
    if (!resp.ok) {
      console.error(`[startup] Ollama /api/tags returned ${resp.status} — model verification skipped`);
      return;
    }
    const data = await resp.json();
    const models = data.models || [];
    const found = models.find(m => m.name === expectedModel);
    if (!found) {
      console.error(`[startup] MODEL NOT FOUND: expected "${expectedModel}", available: [${models.map(m => m.name).join(', ')}]`);
      console.error(`[startup] Pull the model with: ollama pull ${expectedModel}`);
      if (qualificationMode && process.env.SCOUT_QUALIFICATION_FAIL_OPEN !== 'true') {
        console.error('[startup] STARTUP FAILED: qualification requires model to be present.');
        process.exit(1);
      }
      return;
    }
    const digest = found.digest || 'unknown';
    const size = found.size || 0;
    const details = found.details || {};
    console.log(`[startup] Model verified: ${found.name} (digest: ${digest}, size: ${(size / 1e9).toFixed(2)}GB, quant: ${details.quantization_level || 'unknown'})`);
    if (expectedDigest && digest !== expectedDigest) {
      console.error(`[startup] DIGEST MISMATCH: expected ${expectedDigest}, got ${digest}`);
      console.error(`[startup] Repull with: ollama pull ${expectedModel}`);
      if (qualificationMode && process.env.SCOUT_QUALIFICATION_FAIL_OPEN !== 'true') {
        console.error('[startup] STARTUP FAILED: qualification requires exact digest match.');
        process.exit(1);
      }
    } else if (expectedDigest) {
      console.log(`[startup] Digest matches expected pin: ${expectedDigest}`);
    } else if (!qualificationMode) {
      console.log('[startup] Development mode: digest not pinned (set OLLAMA_MODEL_DIGEST to pin)');
    }
    modelVerified = true;
  } catch (e) {
    console.error(`[startup] Model verification failed: ${e.message}`);
    if (qualificationMode && process.env.SCOUT_QUALIFICATION_FAIL_OPEN !== 'true') {
      console.error('[startup] STARTUP FAILED: qualification requires model verification.');
      process.exit(1);
    }
  }
}

(async function start() {
  // Load knowledge and build the BM25 index before accepting traffic so the
  // first request does not consume its generation deadline on index build.
  try {
    await fetchKnowledge();
    console.log('Knowledge cache pre-warmed');
  } catch (e) {
    console.error('Pre-warm failed:', e.message);
  }

  app.listen(PORT, HOST, () => {
    const _provider = process.env.SCOUT_INFERENCE_PROVIDER || 'ollama';
    console.log(`Recruiter chat API running on http://${HOST}:${PORT} with ${_provider} backend`);
    // Verify model digest and start loading the model into memory early
    if (GEN_ENABLED) {
      setTimeout(() => {
        verifyModelDigest();
        if (process.env.SCOUT_INFERENCE_PROVIDER === 'cloudflare') {
          console.log('Cloudflare Workers AI provider active — skipping Ollama reachability check');
        } else {
          fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' })
            .then(r => r.ok ? console.log('Ollama is reachable') : console.log('Ollama ping returned', r.status))
            .catch(e => console.log('Ollama ping failed:', e.message));
        }
      }, 2000);
    }
  });
})();
