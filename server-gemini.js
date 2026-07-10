require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const KNOWLEDGE_URL = process.env.KNOWLEDGE_URL || 'https://raw.githubusercontent.com/BradleyMatera/ProjectHub/master/data/recruiter-knowledge.json';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://bradleymatera.dev,https://www.bradleymatera.dev').split(',').map(s => s.trim()).filter(Boolean);

let knowledgeCache = null;
let knowledgeCacheAt = 0;
const KNOWLEDGE_CACHE_MS = 5 * 60 * 1000;
const RESPONSE_CACHE_MS = 10 * 60 * 1000;
const RESPONSE_CACHE_LIMIT = 120;
const GEMINI_TIMEOUT_MS = 15000;
const MAX_ACTIVE_GENERATIONS = 1;
const responseCache = new Map();
let activeGenerations = 0;

app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    if (ALLOWED_ORIGINS.includes('https://*.codepen.io') && /^https:\/\/[^/]+\.codepen\.io$/.test(origin)) return callback(null, true);
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) return callback(null, true);
    return callback(new Error('Blocked by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use('/api/chat', rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many chat requests. Please slow down.' }
}));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Bradley Matera Recruiter Chat API', status: 'online', backend: 'Gemini' });
});

app.get('/health', async (req, res) => {
  const geminiReady = !!GEMINI_API_KEY && GEMINI_API_KEY.length > 10;
  res.json({
    ok: true,
    geminiConfigured: geminiReady,
    model: GEMINI_MODEL,
    knowledgeUrl: KNOWLEDGE_URL,
    mode: 'gemini-generate'
  });
});

async function fetchKnowledge() {
  const now = Date.now();
  if (knowledgeCache && (now - knowledgeCacheAt) < KNOWLEDGE_CACHE_MS) {
    return knowledgeCache;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(KNOWLEDGE_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    knowledgeCache = json;
    knowledgeCacheAt = now;
    return json;
  } catch (err) {
    console.error('Failed to fetch knowledge:', err.message);
    return knowledgeCache;
  }
}

function normalizeQuestion(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/bradly|bradely|bradlee/g, 'bradley')
    .replace(/materra|matara|matera/g, 'matera')
    .replace(/recuriter|recruter|recuiter/g, 'recruiter')
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

function buildPrompt(knowledge, question) {
  const { identity, summary, goals, education, certifications, experience, skills, projects, rules, shortPitch, faq } = knowledge || {};
  const name = identity?.name || 'Bradley Matera';
  const title = identity?.title || 'junior software engineer';
  const location = identity?.location || 'Davis, Illinois';
  
  let context = `You are ${name}, a ${title} based in ${location}. Answer recruiter questions concisely (under 40 words) using ONLY the verified facts below. Do not invent skills, projects, or experience.\n\n`;
  
  if (summary?.whoIAm) context += `About: ${summary.whoIAm}\n`;
  if (goals?.targetRoles) context += `Target roles: ${goals.targetRoles.join(', ')}\n`;
  if (skills?.languagesAndFrameworks) context += `Key skills: ${skills.languagesAndFrameworks.slice(0, 6).join(', ')}\n`;
  if (education?.degree) context += `Education: ${education.degree} from ${education.school}\n`;
  if (certifications?.list?.length) context += `Certifications: ${certifications.list.slice(0, 3).join(', ')}\n`;
  if (projects?.length) context += `Notable projects: ${projects.slice(0, 3).map(p => p.name).join(', ')}\n`;
  
  context += `\nRules: ${rules?.do?.join('; ') || 'Stay factual, concise, and recruiter-focused.'}\n`;
  context += `\nQuestion: ${question}\n\nAnswer as ${name} in first person:`;
  
  return context;
}

function buildGroundedFallbackPayload(knowledge, question) {
  const { identity, summary, goals, skills, projects, experience } = knowledge || {};
  const name = identity?.name || 'Bradley Matera';
  const title = identity?.title || 'junior software engineer';
  const location = identity?.location || 'Davis, Illinois';
  
  const lowerQuestion = String(question || '').toLowerCase();
  
  if (/contact|email|phone|reach|linkedin|github/.test(lowerQuestion)) {
    return { reply: `You can reach ${name} at bradmatera@gmail.com or (360) 970-0581. His portfolio is https://bradleymatera.dev/, LinkedIn is https://www.linkedin.com/in/bradmatera, and GitHub is https://github.com/BradleyMatera.` };
  }
  
  if (/education|degree|school|full sail|gpa/.test(lowerQuestion)) {
    const edu = knowledge?.education;
    return { reply: `${name} holds a B.S. in Web Development from Full Sail University (GPA 3.64).` };
  }
  
  if (/cert|certificate|certification/.test(lowerQuestion)) {
    const certs = knowledge?.certifications?.list || [];
    return { reply: `${name} is certified as an AWS Solutions Architect - Associate and AWS Certified AI Practitioner.` };
  }
  
  if (/role|target|job|looking/.test(lowerQuestion)) {
    const roles = goals?.targetRoles || ['junior software engineer', 'frontend developer', 'cloud support engineer'];
    return { reply: `${name} is targeting ${roles.slice(0, 3).join(', ')} roles, open to relocation.` };
  }
  
  if (/skill|stack|technical|background/.test(lowerQuestion)) {
    const techSkills = skills?.languagesAndFrameworks || [];
    return { reply: `${name}'s strongest technical background is ${sentenceList(techSkills, 6)}.` };
  }
  
  if (/project|portfolio|work/.test(lowerQuestion)) {
    const projectList = projects?.slice(0, 4).map(p => p.name) || ['ProjectHub', 'AWS serverless workflow', 'CIRIS Ethical AI contributions'];
    return { reply: `${name}'s notable projects include ${sentenceList(projectList, 4)}. You can see his full portfolio at https://bradleymatera.dev/.` };
  }
  
  if (/aws|cloud|lambda|dynamo|s3|amplify/.test(lowerQuestion)) {
    const cloudSkills = skills?.cloudAndInfrastructure || ['AWS Lambda', 'Amazon DynamoDB', 'Amazon S3', 'AWS Amplify'];
    return { reply: `${name} has AWS training and project experience with ${sentenceList(cloudSkills, 4)}. He completed an AWS Cloud Support Engineer internship with guided troubleshooting labs.` };
  }
  
  if (/experience|intern|work history|background/.test(lowerQuestion)) {
    const exp = experience?.slice(0, 2).map(e => e.role) || ['Freelance junior frontend contributor at CIRIS Ethical AI', 'AWS Cloud Support Engineer internship'];
    return { reply: `${name}'s recent experience includes ${sentenceList(exp, 2)}. He also has prior roles in case management, construction, and the U.S. Army.` };
  }
  
  return { reply: `${name} is a ${title} based in ${location}. ${summary?.whoIAm || 'He combines web development, AWS training, and practical project work.'}` };
}

function buildGroundedFallback(knowledge, question) {
  return buildGroundedFallbackPayload(knowledge, question).reply;
}

function shouldUseGroundedAnswer(question) {
  const rawQuestion = String(question || '').toLowerCase();
  // Only use grounded fallback for simple factual lookups, let Gemini handle complex questions
  return /\b(contact|email|phone|reach|linkedin|github)\b/.test(normalizeQuestion(question));
}

function isProbablyRelevant(question) {
  const normalized = normalizeQuestion(question);
  // Very broad relevance check - if it mentions Bradley or any career-related terms, let it through
  return /\b(bradley|brad|matera|candidate|recruiter|software|engineer|developer|web|aws|cloud|support|skill|stack|project|portfolio|contact|email|phone|role|job|education|cert|resume|ciris|ethical|freelance|contributor|intern|internship|work|experience|debug|troubleshoot|document|learn|communication|army|military|construction|case|manager|approach|style|strength|weakness)\b/.test(normalized) || normalized.includes('bradley');
}

function cleanModelReply(reply, knowledge, question) {
  const cleaned = String(reply || '').trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length < 10) {
    return { reply: buildGroundedFallback(knowledge, question), fallback: true };
  }
  return { reply: cleaned, fallback: false };
}

app.post('/api/chat', async (req, res) => {
  let userMessage = '';
  try {
    userMessage = String(req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'Missing message.' });
    if (userMessage.length > 600) return res.status(400).json({ error: 'Message is too long.' });

    const cached = responseCache.get(userMessage);
    if (cached && (Date.now() - cached.ts) < RESPONSE_CACHE_MS) {
      return res.json({ ...cached.payload, cached: true });
    }

    const knowledge = await fetchKnowledge();
    if (!knowledge) {
      const payload = { ...buildGroundedFallbackPayload({}, userMessage), model: GEMINI_MODEL, fallback: true };
      responseCache.set(userMessage, { ts: Date.now(), payload });
      return res.json(payload);
    }

    // Skip off-topic check - let everything through to grounded fallback when Gemini is down

    if (activeGenerations >= MAX_ACTIVE_GENERATIONS) {
      const payload = { ...buildGroundedFallbackPayload(knowledge, userMessage), model: GEMINI_MODEL, fallback: true, queued: false };
      responseCache.set(userMessage, { ts: Date.now(), payload });
      return res.json(payload);
    }

    const prompt = buildPrompt(knowledge, userMessage);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    activeGenerations++;

    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 60,
          temperature: 0.3,
          topK: 1,
          topP: 0.8
        }
      })
    });

    clearTimeout(timeout);
    activeGenerations = Math.max(0, activeGenerations - 1);

    if (!geminiResponse.ok) {
      const text = await geminiResponse.text();
      console.error('Gemini upstream failed:', text.slice(0, 500));
      const payload = { ...buildGroundedFallbackPayload(knowledge, userMessage), model: GEMINI_MODEL, fallback: true };
      responseCache.set(userMessage, { ts: Date.now(), payload });
      return res.json(payload);
    }

    const data = await geminiResponse.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || buildGroundedFallback(knowledge, userMessage);
    const result = cleanModelReply(reply, knowledge, userMessage);
    const payload = {
      reply: result.reply,
      model: GEMINI_MODEL,
      fallback: result.fallback
    };
    responseCache.set(userMessage, { ts: Date.now(), payload });

    if (responseCache.size > RESPONSE_CACHE_LIMIT) {
      const oldest = [...responseCache.keys()][0];
      responseCache.delete(oldest);
    }

    return res.json(payload);
  } catch (err) {
    activeGenerations = Math.max(0, activeGenerations - 1);
    console.error('Chat error:', err);
    if (err.name === 'AbortError' || String(err.message || '').includes('abort')) {
      const knowledge = knowledgeCache || await fetchKnowledge().catch(() => ({}));
      return res.json({ reply: buildGroundedFallback(knowledge, userMessage), model: GEMINI_MODEL, fallback: true });
    }
    return res.status(500).json({ error: 'Server error.', detail: String(err.message || err) });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Recruiter chat API running on http://127.0.0.1:${PORT} with Gemini backend`);
});
