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
  const { identity, summary, goals, skills, projects, experience, education, certifications } = knowledge || {};
  const name = identity?.name || 'Bradley Matera';
  const title = identity?.title || 'junior software engineer';
  const location = identity?.location || 'Davis, Illinois';
  
  const lowerQuestion = String(question || '').toLowerCase();
  
  // Dynamic contact info from knowledge base
  if (/contact|email|phone|reach|linkedin|github/.test(lowerQuestion)) {
    const contact = [];
    if (identity?.email) contact.push(`email at ${identity.email}`);
    if (identity?.phone) contact.push(`phone ${identity.phone}`);
    if (identity?.portfolioUrl) contact.push(`portfolio at ${identity.portfolioUrl}`);
    if (identity?.linkedInUrl) contact.push(`LinkedIn at ${identity.linkedInUrl}`);
    if (identity?.gitHubUrl) contact.push(`GitHub at ${identity.gitHubUrl}`);
    return { reply: `You can reach ${name} by ${contact.join(', ')}.` };
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
  
  // Dynamic roles from knowledge base
  if (/role|target|job|looking/.test(lowerQuestion)) {
    const roles = goals?.targetRoles || [];
    if (roles.length > 0) {
      const reply = `${name} is targeting ${sentenceList(roles.slice(0, 4), 4)} roles`;
      if (goals?.relocation) reply += `, ${goals.relocation.toLowerCase()}`;
      return { reply: reply + '.' };
    }
    return { reply: `${name} is looking for junior software engineering roles.` };
  }
  
  // Dynamic skills from knowledge base
  if (/skill|stack|technical|background/.test(lowerQuestion)) {
    const skillGroups = [];
    if (skills?.languagesAndFrameworks?.length) {
      skillGroups.push(`${skills.languagesAndFrameworks.slice(0, 6).join(', ')}`);
    }
    if (skills?.cloudAndInfrastructure?.length) {
      skillGroups.push(`cloud: ${skills.cloudAndInfrastructure.slice(0, 4).join(', ')}`);
    }
    if (skills?.toolsAndWorkflows?.length) {
      skillGroups.push(`tools: ${skills.toolsAndWorkflows.slice(0, 4).join(', ')}`);
    }
    if (skillGroups.length > 0) {
      return { reply: `${name}'s technical background includes ${skillGroups.join('; ')}.` };
    }
    return { reply: `${name}'s skills are detailed in his full profile.` };
  }
  
  // Dynamic projects from knowledge base
  if (/project|portfolio|work/.test(lowerQuestion)) {
    const projectList = projects?.slice(0, 5) || [];
    if (projectList.length > 0) {
      const projectNames = projectList.map(p => p.name).join(', ');
      return { reply: `${name}'s notable projects include ${projectNames}. You can see his full portfolio at ${identity?.portfolioUrl || 'https://bradleymatera.dev/'}.` };
    }
    return { reply: `${name}'s projects are showcased in his portfolio.` };
  }
  
  // Dynamic AWS/cloud from knowledge base
  if (/aws|cloud|lambda|dynamo|s3|amplify/.test(lowerQuestion)) {
    const cloudSkills = skills?.cloudAndInfrastructure || [];
    if (cloudSkills.length > 0) {
      let reply = `${name} has AWS experience with ${sentenceList(cloudSkills, 5)}.`;
      const awsExp = experience?.find(e => e.role?.toLowerCase().includes('aws') || e.company?.toLowerCase().includes('aws'));
      if (awsExp) {
        reply += ` He completed an ${awsExp.role} at ${awsExp.company}.`;
      }
      return { reply: reply };
    }
    return { reply: `${name}'s AWS experience is detailed in his profile.` };
  }
  
  // Dynamic experience from knowledge base
  if (/experience|intern|work history|background/.test(lowerQuestion)) {
    const expList = experience?.slice(0, 3) || [];
    if (expList.length > 0) {
      const roles = expList.map(e => `${e.role}${e.company ? ` at ${e.company}` : ''}`).join(', ');
      return { reply: `${name}'s recent experience includes ${roles}.` };
    }
    return { reply: `${name}'s work history is available in his full profile.` };
  }
  
  // Dynamic summary from knowledge base
  if (/summary|who is|about|tell me about/.test(lowerQuestion)) {
    if (summary?.whoIAm) {
      return { reply: `${name} is a ${title} based in ${location}. ${summary.whoIAm}` };
    }
    return { reply: `${name} is a ${title} based in ${location}.` };
  }
  
  // Default to basic info
  return { reply: `${name} is a ${title} based in ${location}. ${summary?.whoIAm || 'See his portfolio for more details.'}` };
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
