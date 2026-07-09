const DEFAULT_GCP_API_URL = 'https://projecthub-chat.bradleymatera.dev/api/chat';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 180;
const GCP_TIMEOUT_MS = 8500;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://bradleymatera.dev,https://www.bradleymatera.dev,https://bradleymatera.github.io')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const responseCache = new Map();

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

async function callGcp(message, origin) {
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
      body: JSON.stringify({ message })
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

  const message = String(body.message || '').trim();
  if (!message) return json(400, { error: 'Missing message.' }, headers);
  if (message.length > 600) return json(400, { error: 'Message is too long.' }, headers);

  const intent = classify(message);
  const cached = getCached(message);
  if (cached) {
    return json(200, {
      ...cached,
      cached: true,
      router: 'netlify',
      intent,
      source: cached.source || 'gcp-cache'
    }, headers);
  }

  try {
    const gcpPayload = await callGcp(message, origin);
    const payload = {
      ...gcpPayload,
      cached: false,
      router: 'netlify',
      intent,
      source: 'gcp-grounded',
      budget: {
        netlifyTokensUsed: 0,
        policy: 'grounded-first; paid polish disabled unless explicitly configured'
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
