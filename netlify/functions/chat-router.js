const DEFAULT_GCP_API_URL = 'https://projecthub-chat.bradleymatera.dev/api/chat';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 180;
const GCP_TIMEOUT_MS = 8500;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const SESSION_MEMORY_LIMIT = 240;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://bradleymatera.dev,https://www.bradleymatera.dev,https://bradleymatera.github.io')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const responseCache = new Map();
const sessionMemory = new Map();
let neonSqlPromise = null;

function corsHeaders(origin) {
  const allowedOrigin = !origin || ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[^/]+\.codepen\.io$/.test(origin)
    ? origin || ALLOWED_ORIGINS[0]
    : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json'
  };
}

function normalizeQuestion(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/bradly|bradely|bradlee/g, 'bradley')
    .replace(/materra|matara/g, 'matera')
    .replace(/recuriter|recruter|recuiter/g, 'recruiter')
    .replace(/engeneer|enginer|enginering/g, 'engineer')
    .replace(/jorgon/g, 'jargon')
    .replace(/project hub/g, 'projecthub')
    .replace(/poke ?dex/g, 'pokedex')
    .replace(/cirus|cirrus|siris/g, 'ciris')
    .replace(/code pen/g, 'codepen')
    .replace(/red flags?/g, 'red flag')
    .replace(/ats|applicant tracking system/g, 'recruiter screen')
    .replace(/[^a-z0-9\s#.+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cacheKey(message) {
  return normalizeQuestion(message).slice(0, 220);
}

function safeSessionId(value) {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return cleaned || `anon-${Date.now().toString(36)}`;
}

async function getNeonSql() {
  const connectionString = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) return null;
  if (!neonSqlPromise) {
    neonSqlPromise = import('@neondatabase/serverless')
      .then(({ neon }) => neon(connectionString))
      .catch(error => {
        console.warn('Neon session memory disabled:', error.message);
        return null;
      });
  }
  return neonSqlPromise;
}

async function ensureSessionTable(sql) {
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS projecthub_chat_sessions (
      session_id text PRIMARY KEY,
      memory jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

function trimMemory(memory) {
  return (Array.isArray(memory) ? memory : [])
    .filter(item => item && typeof item === 'object')
    .slice(-10)
    .map(item => ({
      role: String(item.role || '').slice(0, 16),
      content: String(item.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 420),
      intent: item.intent ? String(item.intent).slice(0, 40) : undefined,
      at: Number(item.at) || Date.now()
    }));
}

async function readSession(sessionId) {
  const sql = await getNeonSql();
  if (sql) {
    try {
      await ensureSessionTable(sql);
      const rows = await sql`SELECT memory FROM projecthub_chat_sessions WHERE session_id = ${sessionId}`;
      return trimMemory(rows[0]?.memory || []);
    } catch (error) {
      console.warn('Neon read failed:', error.message);
    }
  }

  const cached = sessionMemory.get(sessionId);
  if (!cached || Date.now() - cached.at > SESSION_TTL_MS) return [];
  return trimMemory(cached.memory);
}

async function writeSession(sessionId, memory) {
  const trimmed = trimMemory(memory);
  const sql = await getNeonSql();
  if (sql) {
    try {
      await ensureSessionTable(sql);
      await sql`
        INSERT INTO projecthub_chat_sessions (session_id, memory, updated_at)
        VALUES (${sessionId}, ${JSON.stringify(trimmed)}::jsonb, now())
        ON CONFLICT (session_id)
        DO UPDATE SET memory = EXCLUDED.memory, updated_at = now()
      `;
      return 'neon';
    } catch (error) {
      console.warn('Neon write failed:', error.message);
    }
  }

  sessionMemory.set(sessionId, { at: Date.now(), memory: trimmed });
  while (sessionMemory.size > SESSION_MEMORY_LIMIT) {
    sessionMemory.delete(sessionMemory.keys().next().value);
  }
  return 'memory';
}

async function clearSession(sessionId) {
  const sql = await getNeonSql();
  if (sql) {
    try {
      await ensureSessionTable(sql);
      await sql`DELETE FROM projecthub_chat_sessions WHERE session_id = ${sessionId}`;
    } catch (error) {
      console.warn('Neon clear failed:', error.message);
    }
  }
  sessionMemory.delete(sessionId);
}

function sessionHint(memory) {
  const recentUserTurns = trimMemory(memory).filter(item => item.role === 'user').slice(-2).map(item => item.content);
  return recentUserTurns.length ? `Recent session context: ${recentUserTurns.join(' | ')}` : '';
}

function isContextDependent(message) {
  return /\b(it|that|this|those|they|them|same|more|again|previous|above|follow up|followup)\b/i.test(message);
}

function getCached(message) {
  const key = cacheKey(message);
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.at > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return cached.payload;
}

function setCached(message, payload) {
  responseCache.set(cacheKey(message), { at: Date.now(), payload });
  while (responseCache.size > CACHE_LIMIT) {
    responseCache.delete(responseCache.keys().next().value);
  }
}

function classify(message) {
  const question = normalizeQuestion(message);
  if (!question) return 'empty';
  if (/moon cheese|pizza engines|weather|sports|politics|recipe|movie|song/.test(question)) return 'off-topic';
  if (/contact|email|phone|reach|linkedin|github/.test(question)) return 'contact';
  if (/projecthub|pokedex|cheesemath|shader|serverless|ciris|ethical ai|project|portfolio|codepen/.test(question)) return 'project';
  if (/aws|cloud|lambda|dynamo|s3|amplify|support|ticket|on call|production/.test(question)) return 'cloud-support';
  if (/ats|recruiter screen|jargon|red flag|downside|gap|concern|hire|candidate|fit|role|job/.test(question)) return 'recruiter-fit';
  if (/skill|stack|technical|debug|api|crud|sdlc|team|work style/.test(question)) return 'technical';
  if (/bradley|matera|resume|education|degree|cert|experience|army|military/.test(question)) return 'profile';
  return 'unknown';
}

function json(statusCode, body, headers) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
}

async function callGcp(message, origin, memory, options) {
  const hint = sessionHint(memory);
  const augmentedMessage = hint ? `${message}\n\n${hint}` : message;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GCP_TIMEOUT_MS);
  try {
    const response = await fetch(process.env.GCP_CHAT_API_URL || DEFAULT_GCP_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Origin': origin || 'https://bradleymatera.dev'
      },
      body: JSON.stringify({ message: augmentedMessage, options })
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = { reply: text };
    }
    if (!response.ok) throw new Error(payload.error || `GCP HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

exports.handler = async function handler(event) {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' }, headers);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Invalid JSON.' }, headers);
  }

  const sessionId = safeSessionId(body.sessionId || event.headers['x-nf-client-connection-ip'] || 'anonymous');
  if (body.action === 'clearMemory') {
    await clearSession(sessionId);
    return json(200, { ok: true, cleared: true, router: 'netlify', sessionId }, headers);
  }

  const message = String(body.message || '').trim();
  const options = body.options && typeof body.options === 'object' ? body.options : {};
  const memoryEnabled = options.memoryEnabled !== false;
  const clientContext = memoryEnabled ? trimMemory(body.context || []) : [];
  if (!message) return json(400, { error: 'Missing message.' }, headers);
  if (message.length > 600) return json(400, { error: 'Message is too long.' }, headers);

  const intent = classify(message);
  const priorMemory = memoryEnabled ? await readSession(sessionId) : [];
  const mergedMemory = trimMemory([...priorMemory, ...clientContext, { role: 'user', content: message, intent, at: Date.now() }]);
  const cached = isContextDependent(message) ? null : getCached(message);
  if (cached) {
    let store = 'disabled';
    if (memoryEnabled) {
      store = await writeSession(sessionId, [...mergedMemory, { role: 'assistant', content: cached.reply, intent, at: Date.now() }]);
    }
    return json(200, {
      ...cached,
      cached: true,
      router: 'netlify',
      intent,
      source: cached.source || 'gcp-cache',
      sessionMemory: { enabled: memoryEnabled, store, turns: memoryEnabled ? trimMemory(mergedMemory).length : 0 }
    }, headers);
  }

  try {
    const gcpPayload = await callGcp(message, origin, memoryEnabled ? mergedMemory : [], options);
    const store = memoryEnabled
      ? await writeSession(sessionId, [...mergedMemory, { role: 'assistant', content: gcpPayload.reply, intent, at: Date.now() }])
      : 'disabled';
    const payload = {
      ...gcpPayload,
      cached: false,
      router: 'netlify',
      intent,
      source: 'gcp-grounded',
      sessionMemory: { enabled: memoryEnabled, store, turns: memoryEnabled ? trimMemory(mergedMemory).length + 1 : 0 },
      budget: {
        netlifyTokensUsed: 0,
        policy: 'grounded-first; tiny GCP flavor labels enabled; Neon session memory optional'
      }
    };
    setCached(message, payload);
    return json(200, payload, headers);
  } catch (error) {
    const fallback = {
      reply: 'I can still help from Bradley Matera\'s verified profile details. Try asking about his projects, AWS experience, CIRIS work, technical skills, target roles, education, certifications, or contact links.',
      fallback: true,
      cached: false,
      router: 'netlify',
      intent,
      source: 'router-fallback',
      detail: String(error.message || error)
    };
    return json(200, fallback, headers);
  }
};
