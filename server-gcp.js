require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

const PORT = process.env.PORT || 3000;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'tinyllama:latest';
const KNOWLEDGE_URL = process.env.KNOWLEDGE_URL || 'https://raw.githubusercontent.com/BradleyMatera/ProjectHub/master/data/recruiter-knowledge.json';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://bradleymatera.dev,https://www.bradleymatera.dev').split(',').map(s => s.trim()).filter(Boolean);

// In-memory knowledge cache
let knowledgeCache = null;
let knowledgeCacheAt = 0;
const KNOWLEDGE_CACHE_MS = 5 * 60 * 1000; // 5 minutes

app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
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
  res.json({ ok: true, service: 'Bradley Matera Recruiter Chat API', status: 'online' });
});

app.get('/health', async (req, res) => {
  try {
    const ollamaReady = await fetch(`${OLLAMA_BASE_URL}/`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok)
      .catch(() => false);
    res.json({
      ok: true,
      ollamaConfigured: ollamaReady,
      model: OLLAMA_MODEL,
      knowledgeUrl: KNOWLEDGE_URL,
      mode: 'ollama-generate'
    });
  } catch (err) {
    res.json({ ok: true, ollamaConfigured: false, model: OLLAMA_MODEL, knowledgeUrl: KNOWLEDGE_URL, mode: 'ollama-generate' });
  }
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
    return knowledgeCache; // fallback to stale cache
  }
}

function buildPrompt(knowledge, question) {
  const identity = knowledge?.identity || {};
  const projects = (knowledge?.projects || []).slice(0, 5);
  const skills = (knowledge?.topSkills || knowledge?.skills?.languagesAndFrameworks || []).slice(0, 12);
  const certs = knowledge?.certifications || [];
  const faq = (knowledge?.faq || []).find(f => question.toLowerCase().includes(f.question.toLowerCase().slice(0, 12)));

  const projectLines = projects.map(p => `- ${p.name}: ${p.description}`).join('\n');
  const skillLine = skills.join(', ');
  const certLine = Array.isArray(certs) ? certs.slice(0, 2).map(c => typeof c === 'string' ? c : c.name).join(', ') : '';

  let prompt = `You are a concise recruiter assistant answering questions about ${identity.name || 'Bradley Matera'}, a ${identity.title || 'junior software engineer'}.\n`;
  prompt += `Use only the facts below. Answer in third person as an assistant, never as Bradley. Be natural, specific, honest, and professional. Keep the answer to 2 complete short sentences.\n`;
  prompt += `Do not mention Python, Java, C++, pressure, or traits not listed in the facts.\n\n`;
  prompt += `Name: ${identity.name || 'Bradley Matera'}\n`;
  prompt += `Title: ${identity.title || 'Junior Software Engineer'}\n`;
  prompt += `Location: ${identity.location || 'Davis, Illinois'}\n`;
  if (skillLine) prompt += `Top skills: ${skillLine}\n`;
  if (certLine) prompt += `Certifications: ${certLine}\n`;
  if (projectLines) prompt += `Recent projects:\n${projectLines}\n`;
  if (faq) prompt += `Quick fact: ${faq.answer}\n`;
  prompt += `\nQuestion: ${question}\nAnswer:`;
  return prompt;
}

function buildGroundedFallback(knowledge, question) {
  const identity = knowledge?.identity || {};
  const name = identity.name || 'Bradley Matera';
  const title = identity.title || 'Junior Software Engineer';
  const location = identity.location || 'Davis, Illinois';
  const skills = (knowledge?.topSkills || knowledge?.skills?.languagesAndFrameworks || []).slice(0, 8);
  const certs = (knowledge?.certifications || []).slice(0, 2).map(c => typeof c === 'string' ? c : c.name).filter(Boolean);
  const lowerQuestion = question.toLowerCase();

  if (/why|good|fit|candidate|hire|ready/.test(lowerQuestion)) {
    return `${name} is a strong ${title.toLowerCase()} candidate because he has a focused web-development base in ${skills.join(', ')} and current AWS training that recruiters can verify through real portfolio work. He is based in ${location} and brings practical strengths in debugging, documentation, and building clear project demos.`;
  }

  if (/skill|stack|technical|background/.test(lowerQuestion)) {
    return `${name}'s strongest technical background is ${skills.join(', ')}, with additional AWS project experience around serverless services and support workflows. ${certs.length ? `His certifications include ${certs.join(' and ')}, which backs up that cloud foundation.` : 'That gives him a practical junior-level foundation for web, support, and cloud-adjacent roles.'}`;
  }

  return `${name} is a ${title} based in ${location}, open to relocation, with a practical foundation in ${skills.join(', ')}. He combines that with AWS training, debugging habits, documentation skills, and project work that gives recruiters concrete examples to review.`;
}

function cleanModelReply(reply, knowledge, question) {
  const cleaned = String(reply || '').trim().replace(/\s+/g, ' ');
  const forbidden = /\b(Python|C\+\+|Java\b|under pressure|various programming languages|business applications|employers|following skills|highly valued)\b/i;
  const badFormat = /\*\*|\b\d+\.|\n|:/.test(cleaned);
  const looksIncomplete = /[,;:]$|\b(and|or|including|Additionally|because|with|to|able to|he can)$/i.test(cleaned);
  if (!cleaned || cleaned.length < 40 || forbidden.test(cleaned) || badFormat || looksIncomplete) {
    return { reply: buildGroundedFallback(knowledge, question), fallback: true };
  }
  return { reply: cleaned, fallback: false };
}

app.post('/api/chat', async (req, res) => {
  let userMessage = '';
  try {
    userMessage = String(req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'Missing message.' });
    if (userMessage.length > 1000) return res.status(400).json({ error: 'Message is too long.' });

    const knowledge = await fetchKnowledge();
    const prompt = buildPrompt(knowledge, userMessage);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: {
          num_predict: 38,
          num_ctx: 192,
          num_thread: 2,
          temperature: 0.05
        }
      })
    });

    clearTimeout(timeout);

    if (!ollamaResponse.ok) {
      const text = await ollamaResponse.text();
      return res.status(502).json({ error: 'Ollama upstream failed.', detail: text.slice(0, 500) });
    }

    const data = await ollamaResponse.json();
    const result = cleanModelReply(data.response, knowledge, userMessage);

    return res.json({
      reply: result.reply,
      model: OLLAMA_MODEL,
      fallback: result.fallback
    });
  } catch (err) {
    console.error('Chat error:', err);
    // If Ollama timed out or failed, still return a useful local answer from the
    // knowledge base instead of a broken error message.
    if (err.name === 'AbortError' || String(err.message || '').includes('abort')) {
      const knowledge = knowledgeCache || await fetchKnowledge().catch(() => ({}));
      return res.json({ reply: buildGroundedFallback(knowledge, userMessage), model: OLLAMA_MODEL, fallback: true });
    }
    return res.status(500).json({ error: 'Server error.', detail: String(err.message || err) });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Recruiter chat API running on http://127.0.0.1:${PORT}`);
});
