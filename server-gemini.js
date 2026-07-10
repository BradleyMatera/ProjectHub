require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

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
  const provider = LLM_PROVIDER;
  const model = provider === 'ollama' ? OLLAMA_MODEL : provider === 'openai' ? OPENAI_MODEL : GEMINI_MODEL;
  const providerReady = provider === 'ollama' ? true : provider === 'openai' ? !!OPENAI_API_KEY && OPENAI_API_KEY.length > 10 : !!GEMINI_API_KEY && GEMINI_API_KEY.length > 10;
  res.json({
    ok: true,
    provider,
    providerConfigured: providerReady,
    model,
    knowledgeUrl: KNOWLEDGE_URL,
    mode: provider + '-generate'
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
    .replace(/bradly|bradely|bradlee|bradlee/g, 'bradley')
    .replace(/materra|matara|matera/g, 'matera')
    .replace(/recuriter|recruter|recuiter|recrutier/g, 'recruiter')
    .replace(/exprience|experince|experiance|experiance|experiance/g, 'experience')
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
  // Remove common AI slop phrases and inflated language
  const slopPatterns = [
    /^(certainly|absolutely|great question|of course|sure!|sure,)/i,
    /\b(certainly|absolutely|of course)\b/gi,
    /\b(extensive expertise|proven leader|deep mastery|robust|dynamic|synergy|leverage|passionate|passion)\b/gi,
    /\b(groundbreaking|cutting-edge|innovative|world-class|best-in-class)\b/gi,
    /as an ai\b/gi,
    /as bradley matera's recruiter assistant\b/gi,
  ];
  let cleaned = reply;
  slopPatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, match => {
      if (/^(certainly|absolutely|great question|of course|sure!|sure,)/i.test(match)) return '';
      return match.toLowerCase() === 'passionate' ? 'interested' : '';
    });
  });
  return cleaned.replace(/\s+/g, ' ').trim().replace(/^[\.,\s]+/, '');
}

function wordCount(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

async function callOpenAICompatible(knowledge, question, history, model) {
  const apiKey = OPENAI_API_KEY;
  if (!apiKey || apiKey.length < 10) {
    throw new Error('OpenAI-compatible API key not configured');
  }
  const prompt = buildPrompt(knowledge, question, history, 'openai');
  const messages = [];
  if (knowledge?.identity?.name) {
    messages.push({ role: 'system', content: prompt });
  }
  // Add history if provided
  if (Array.isArray(history) && history.length > 0) {
    history.forEach(turn => {
      if (turn.user) messages.push({ role: 'user', content: turn.user });
      if (turn.assistant) messages.push({ role: 'assistant', content: turn.assistant });
    });
  }
  messages.push({ role: 'user', content: question });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 120,
      temperature: 0.7,
      top_p: 0.9
    })
  });
  clearTimeout(timeout);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI-compatible provider failed: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
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

async function callGemini(knowledge, question, history, model) {
  const prompt = buildPrompt(knowledge, question, history, 'gemini');
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
        maxOutputTokens: 120,
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
    throw new Error(`Gemini failed: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
  const { skills, projects, experience, goals, summary } = knowledge || {};
  const roleLower = role.toLowerCase();
  
  // Extract all skill keywords
  const allSkills = [
    ...(skills?.languagesAndFrameworks || []),
    ...(skills?.cloudAndInfrastructure || []),
    ...(skills?.toolsAndWorkflows || []),
    ...(skills?.aiAndAutomation || []),
    ...(skills?.learningOrAdjacent || [])
  ].map(s => s.toLowerCase());
  
  const projectNames = (projects || []).map(p => p.name.toLowerCase());
  const projectTech = (projects || []).flatMap(p => (p.tech || []).map(t => t.toLowerCase()));
  const targetRoles = (goals?.targetRoles || []).map(r => r.toLowerCase());
  
  // Determine role fit
  const isSenior = /senior|lead|principal|staff|architect|manager|director|head of|vp|chief/.test(roleLower);
  const isCloud = /cloud|aws|devops|sre|site reliability|infrastructure|platform/.test(roleLower);
  const isFrontend = /frontend|web|react|javascript|typescript|ui|ux|html|css/.test(roleLower);
  const isBackend = /backend|node|python|java|c#|\.net|php|ruby|go|rust|sql|database/.test(roleLower);
  const isSupport = /support|help desk|helpdesk|technical support|it support|customer support|service desk/.test(roleLower);
  const isQA = /qa|test|quality assurance|automation/.test(roleLower);
  const isMobile = /mobile|ios|android|react native|swift|kotlin|flutter/.test(roleLower);
  const isData = /data|analytics|machine learning|ml|ai engineer|data engineer|data scientist|bi|etl/.test(roleLower);
  const isSecurity = /security|cyber|infosec|penetration|soc/.test(roleLower);
  
  const matchedSkills = [];
  const gaps = [];
  
  if (isFrontend) {
    const frontendSkills = ['javascript', 'typescript', 'react', 'next.js', 'html', 'css'];
    frontendSkills.forEach(s => {
      if (allSkills.includes(s)) matchedSkills.push(s);
    });
    if (projectTech.includes('react') || projectNames.some(n => n.includes('react'))) matchedSkills.push('react projects');
  }
  
  if (isBackend) {
    const backendSkills = ['node.js', 'sql', 'javascript', 'typescript'];
    backendSkills.forEach(s => {
      if (allSkills.includes(s)) matchedSkills.push(s);
    });
  }
  
  if (isCloud || isSupport) {
    const cloudSkills = ['aws lambda', 'amazon dynamodb', 'amazon s3', 'aws amplify', 'cloud troubleshooting', 'networking fundamentals'];
    cloudSkills.forEach(s => {
      if (allSkills.includes(s)) matchedSkills.push(s);
    });
    const awsExp = experience?.find(e => e.role?.toLowerCase().includes('aws') || e.company?.toLowerCase().includes('aws'));
    if (awsExp) matchedSkills.push('aws internship');
  }
  
  if (isQA) {
    if (allSkills.includes('debugging')) matchedSkills.push('debugging');
    if (allSkills.includes('documentation')) matchedSkills.push('documentation');
  }
  
  if (isData) {
    if (allSkills.includes('sql')) matchedSkills.push('sql');
    if (allSkills.includes('python')) matchedSkills.push('python');
  }
  
  if (isMobile) {
    gaps.push('no mobile-specific skills or projects listed');
  }
  
  if (isSecurity) {
    gaps.push('no security-specific training or certifications listed');
  }
  
  if (isSenior) {
    gaps.push('junior-level with limited production ownership');
    // For senior roles, the gap is critical so downgrade the overall fit
    if (matchedSkills.length > 0) {
      return { fit: 'poor', matchedSkills, gaps };
    }
  }
  
  const isTargetRole = targetRoles.some(r => r.includes(roleLower.replace(/senior|junior|lead|staff/g, '').trim()));
  if (isTargetRole) {
    return { fit: 'good', matchedSkills, gaps };
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
  
  const isPitch = /how should.*recruiter pitch|how do you pitch|pitch him/.test(lower);
  const isVerify = /what should.*verify|verify on a call|check on a call|what to verify/.test(lower);
  const isMissing = /what would be missing|what is missing|missing for|gaps|not a fit for|bad fit/.test(lower);
  const isFit = /is.*a fit|would.*fit|should.*fit|fit for|good fit/.test(lower);
  
  const fitStatement = roleAnalysis.fit === 'good' 
    ? `likely a good fit` 
    : roleAnalysis.fit === 'partial' 
      ? `a partial fit` 
      : `not a strong fit`;
  
  if (isPitch) {
    if (roleAnalysis.matchedSkills.length > 0) {
      return { reply: `${name} is ${fitStatement} for ${role}. Pitch: ${title} with ${sentenceList(roleAnalysis.matchedSkills, 4)}. ${roleAnalysis.gaps.length > 0 ? 'Be honest about gaps: ' + sentenceList(roleAnalysis.gaps, 2) + '.' : ''}` };
    }
    return { reply: `${name} is not a strong fit for ${role}. He is a ${title} with web, AWS, and support skills. If the role is junior, check whether training is provided.` };
  }
  
  if (isVerify) {
    if (roleAnalysis.gaps.length > 0) {
      return { reply: `For ${role}, verify: ${sentenceList(roleAnalysis.gaps, 3)}. Also confirm his hands-on experience with ${roleAnalysis.matchedSkills.length > 0 ? sentenceList(roleAnalysis.matchedSkills, 3) : 'his listed projects'}.` };
    }
    return { reply: `For ${role}, verify his hands-on experience with ${roleAnalysis.matchedSkills.length > 0 ? sentenceList(roleAnalysis.matchedSkills, 3) : 'his listed projects'} and ask about production work.` };
  }
  
  if (isMissing) {
    if (roleAnalysis.gaps.length > 0) {
      return { reply: `For ${role}, he would be missing ${sentenceList(roleAnalysis.gaps, 3)}.` };
    }
    return { reply: `He does not have major listed gaps for ${role}, but he is still junior. Verify depth on a call.` };
  }
  
  // Default is-fit question
  if (roleAnalysis.matchedSkills.length > 0) {
    return { reply: `${name} is ${fitStatement} for ${role} based on ${sentenceList(roleAnalysis.matchedSkills, 3)}. ${roleAnalysis.gaps.length > 0 ? 'Gaps: ' + sentenceList(roleAnalysis.gaps, 2) + '.' : 'He is junior, so verify depth on a call.'}` };
  }
  return { reply: `${name} is not a strong fit for ${role} based on current data. His background is ${title}-level with web, AWS, and support skills.` };
}

function buildPrompt(knowledge, question, history, provider) {
  const { identity, summary, goals, education, certifications, experience, skills, projects, rules, faq, conversationQualityStandards } = knowledge || {};
  const name = identity?.name || 'Bradley Matera';
  const preferredName = identity?.preferredName || 'Brad';
  const title = identity?.title || 'junior software engineer';
  const location = identity?.location || 'Davis, Illinois';

  let context = `You are the assistant for Bradley Matera, an approachable recruiter-side helper named "Scout". You answer questions about Bradley from the verified facts below. You are NOT Bradley, but you represent him in a warm, human, and direct way. You are in a chat widget on his portfolio site.\n\n`;
  context += `Bradley is a ${title} based in ${location}. He goes by ${preferredName}.\n\n`;

  // RAG context
  context += `VERIFIED FACTS ABOUT BRADLEY:\n`;
  if (summary?.whoIAm) context += `- About: ${summary.whoIAm}\n`;
  if (summary?.whatIDo) context += `- What he does: ${summary.whatIDo}\n`;
  if (summary?.whatIAmLookingFor) context += `- Looking for: ${summary.whatIAmLookingFor}\n`;
  if (goals?.targetRoles) context += `- Target roles: ${goals.targetRoles.join(', ')}\n`;
  if (skills?.languagesAndFrameworks) context += `- Frontend stack: ${skills.languagesAndFrameworks.join(', ')}\n`;
  if (skills?.cloudAndInfrastructure) context += `- Cloud: ${skills.cloudAndInfrastructure.join(', ')}\n`;
  if (skills?.toolsAndWorkflows) context += `- Tools: ${skills.toolsAndWorkflows.join(', ')}\n`;
  if (education?.degree) context += `- Education: ${education.degree} from ${education.school} (GPA ${education.gpa || 'not listed'}, graduated ${education.graduationDate || '2025'})\n`;
  if (certifications?.length) context += `- Certifications: ${certifications.map(c => c.name).join(', ')}\n`;
  if (projects?.length) context += `- Projects: ${projects.slice(0, 6).map(p => `${p.name} (${p.category})`).join('; ')}\n`;
  if (experience?.length) context += `- Experience: ${experience.map(e => `${e.role} at ${e.company} (${e.dates})`).join('; ')}\n`;
  if (identity?.shortPitch) context += `- Short pitch: ${identity.shortPitch}\n`;

  if (rules?.doNot?.length) {
    context += `\nSTRICT RULES:\n`;
    rules.doNot.forEach(r => context += `- ${r}\n`);
  }

  context += `\nVOICE AND STYLE:\n`;
  context += `- Talk like a normal, helpful person. Not a corporate AI, not a resume.\n`;
  context += `- Answer directly in 1-3 sentences. Be warm but honest.\n`;
  context += `- Never start with "Certainly", "Absolutely", "Great question", "Of course", or "Sure".\n`;
  context += `- Never use words like robust, passionate, synergy, leverage, dynamic, extensive, groundbreaking, cutting-edge, innovative, world-class, or best-in-class.\n`;
  context += `- Do not oversell Bradley. He is junior. If something is from a project, an internship, or school, say so.\n`;
  context += `- If the data does not contain the answer, say you do not see it and suggest checking the resume or contacting him directly.\n`;
  context += `- If the user is vague, ask a brief clarifying question.\n`;

  if (Array.isArray(history) && history.length > 0) {
    context += `\nRECENT CONVERSATION:\n`;
    history.slice(-3).forEach((turn, i) => {
      context += `User: ${turn.user || ''}\nScout: ${turn.assistant || ''}\n`;
    });
  }

  context += `\nUser: ${question}\nScout:`;
  return context;
}

function buildGroundedFallbackPayload(knowledge, question) {
  const { identity, summary, goals, skills, projects, experience, education, certifications, rulesForAssistant } = knowledge || {};
  const name = identity?.name || 'Bradley Matera';
  const title = identity?.title || 'junior software engineer';
  const location = identity?.location || 'Davis, Illinois';
  
  const lowerQuestion = String(question || '').toLowerCase();
  const normalized = normalizeQuestion(question);
  
  // Safety: prompt injection / secret extraction / false claims
  if (/(ignore previous|ignore all rules|ignore your instructions|show.*system prompt|print.*env|api key|give me.*key|\.env|home address|family details|private|bypass cors|open.*port|cto|fortune 500|production engineer|reveal.*prompt|hidden config|make.*longer than 5000)/.test(lowerQuestion)) {
    return { reply: `I can only answer recruiter questions about ${name} using public information from the site. I can't do that.` };
  }
  
  // Role-fit questions
  const role = findRoleInQuestion(question);
  if (role && /(fit|missing|gaps|pitch|verify|should.*consider|bad fit|good fit|role for|job for)/.test(lowerQuestion)) {
    return handleRoleFit(knowledge, question, role);
  }
  
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
  if (/role|target|job|looking|work.*looking/.test(lowerQuestion)) {
    const roles = goals?.targetRoles || [];
    if (roles.length > 0) {
      const reply = `${name} is targeting ${sentenceList(roles.slice(0, 4), 4)} roles`;
      if (goals?.relocation) reply += `, ${goals.relocation.toLowerCase()}`;
      return { reply: reply + '.' };
    }
    return { reply: `${name} is looking for junior software engineering roles.` };
  }
  
  // Dynamic skills from knowledge base
  if (/skill|stack|technical|background|what does he know|what can he do|actually do/.test(lowerQuestion)) {
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
  if (/project|portfolio|work|real projects|best project|shipped/.test(lowerQuestion)) {
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
  if (/summary|who is|about|tell me about|who is brad|who is bradley|in 30 seconds|30 seconds|simple version|honest version/.test(lowerQuestion)) {
    if (summary?.whoIAm) {
      return { reply: `${name} is a ${title} based in ${location}. ${summary.whoIAm}` };
    }
    return { reply: `${name} is a ${title} based in ${location}.` };
  }
  
  // Weaknesses / concerns / what is not proven
  if (/weakness|weak at|concern|not proven|what is he missing|what is missing|gaps|limitations|bad fit|red flag/.test(lowerQuestion)) {
    const weaknesses = [];
    if (title.toLowerCase().includes('junior')) weaknesses.push('junior-level');
    if (!skills?.cloudAndInfrastructure?.includes('live production support')) weaknesses.push('no live production AWS ownership');
    if (experience?.length <= 2) weaknesses.push('limited work experience');
    if (weaknesses.length > 0) {
      return { reply: `Honest limitations: ${sentenceList(weaknesses, 3)}. He is strongest in hands-on learning, documentation, and frontend/cloud support projects.` };
    }
    return { reply: `Main caution is that he is junior, so verify depth on a call.` };
  }
  
  // What should I not claim
  if (/not claim|should not claim|rules.*assistant|what.*not say/.test(lowerQuestion)) {
    if (rulesForAssistant?.length) {
      return { reply: `Do not claim: ${sentenceList(rulesForAssistant, 3)}.` };
    }
    return { reply: `Do not claim senior, production AWS, or experience not in the public data.` };
  }
  
  // Interview questions
  if (/interview question|what.*ask him|what.*verify/.test(lowerQuestion)) {
    return { reply: `Ask about his AWS capstone, how he debugs a broken React component, his experience with CI/CD or Docker, and how he handles unknown tech.` };
  }
  
  // Naturalness / no-bs / why should I care
  if (/no bs|no bullshit|why should i care|worth calling|is he worth|is he good|is he legit|real projects|does he write|can he talk|can he troubleshoot|does he write docs/.test(lowerQuestion)) {
    return { reply: `${name} is a junior developer with real projects in React/Next.js, AWS training, and support-lab experience. Good fit for junior web, cloud support, or IT support roles. Call if you need a careful learner who documents and debugs.` };
  }
  
  // Salary / private data
  if (/salary|address|home|current salary|pay|compensation/.test(lowerQuestion)) {
    return { reply: `I don't see salary or address details in the public data. Check his resume or contact him directly.` };
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
  let cleaned = String(reply || '').trim().replace(/\s+/g, ' ');
  cleaned = removeSlop(cleaned);
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

    const history = Array.isArray(req.body.history) ? req.body.history : [];
    const cached = responseCache.get(userMessage);
    if (cached && (Date.now() - cached.ts) < RESPONSE_CACHE_MS) {
      return res.json({ ...cached.payload, cached: true });
    }

    const knowledge = await fetchKnowledge();
    if (!knowledge) {
      const payload = { ...buildGroundedFallbackPayload({}, userMessage), provider: 'fallback', fallback: true };
      responseCache.set(userMessage, { ts: Date.now(), payload });
      return res.json(payload);
    }

    let provider = LLM_PROVIDER;
    let model = provider === 'ollama' ? OLLAMA_MODEL : provider === 'openai' ? OPENAI_MODEL : GEMINI_MODEL;
    let reply = '';

    try {
      if (provider === 'openai') {
        reply = await callOpenAICompatible(knowledge, userMessage, history, model);
      } else if (provider === 'ollama') {
        reply = await callOllama(knowledge, userMessage, history, model);
      } else {
        reply = await callGemini(knowledge, userMessage, history, model);
      }
    } catch (err) {
      console.error(`${provider} failed:`, err.message);
      // Try Ollama fallback if available
      if (provider !== 'ollama') {
        try {
          provider = 'ollama';
          model = OLLAMA_MODEL;
          reply = await callOllama(knowledge, userMessage, history, model);
        } catch (ollamaErr) {
          console.error('Ollama fallback failed:', ollamaErr.message);
        }
      }
    }

    const result = cleanModelReply(reply, knowledge, userMessage);
    const payload = {
      reply: result.reply,
      provider: result.fallback ? 'fallback' : provider,
      model,
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
      return res.json({ reply: buildGroundedFallback(knowledge, userMessage), provider: 'fallback', model: OLLAMA_MODEL, fallback: true });
    }
    return res.status(500).json({ error: 'Server error.', detail: String(err.message || err) });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Recruiter chat API running on http://127.0.0.1:${PORT} with Gemini backend`);
});
