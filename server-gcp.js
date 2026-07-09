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
const RESPONSE_CACHE_MS = 10 * 60 * 1000;
const RESPONSE_CACHE_LIMIT = 120;
const OLLAMA_TIMEOUT_MS = 9000;
const FLAVOR_TIMEOUT_MS = 2400;
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

function normalizeQuestion(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/\bbrads\b|\bbrad\b/g, 'bradley')
    .replace(/bradly|bradely|bradlee/g, 'bradley')
    .replace(/materra|matara|matera/g, 'matera')
    .replace(/recuriter|recruter|recuiter/g, 'recruiter')
    .replace(/engeneer|enginer|enginering/g, 'engineer')
    .replace(/javscript|java script/g, 'javascript')
    .replace(/typescipt|type script/g, 'typescript')
    .replace(/pok[eé] ?dex/g, 'pokedex')
    .replace(/project hub/g, 'projecthub')
    .replace(/cheese math/g, 'cheesemath')
    .replace(/code pen/g, 'codepen')
    .replace(/cirus|ciris ai|cirrus|siris/g, 'ciris')
    .replace(/intetnion|intention|intentions/g, 'intent')
    .replace(/jorgon/g, 'jargon')
    .replace(/red flags?/g, 'red flag')
    .replace(/\bats\b|applicant tracking system/g, 'recruiter screen')
    .replace(/ramp up|onboard|onboarding/g, 'work style onboarding')
    .replace(/sdlc|software development life cycle/g, 'software workflow')
    .replace(/prod|production/g, 'production')
    .replace(/on call|oncall/g, 'on call')
    .replace(/ci cd|cicd/g, 'ci cd')
    .replace(/[^a-z0-9\s#.+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cacheKey(question) {
  return normalizeQuestion(question).slice(0, 180);
}

function getCachedReply(question) {
  const key = cacheKey(question);
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.at > RESPONSE_CACHE_MS) {
    responseCache.delete(key);
    return null;
  }
  return cached.payload;
}

function setCachedReply(question, payload) {
  const key = cacheKey(question);
  responseCache.set(key, { at: Date.now(), payload });
  while (responseCache.size > RESPONSE_CACHE_LIMIT) {
    responseCache.delete(responseCache.keys().next().value);
  }
}

function sentenceList(items, limit = 4) {
  const values = (items || []).filter(Boolean).slice(0, limit);
  if (values.length <= 1) return values.join('');
  if (values.length === 2) return values.join(' and ');
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function certNames(certs) {
  return (certs || []).map(c => typeof c === 'string' ? c : c.name).filter(Boolean);
}

function projectNames(projects, limit = 4) {
  return (projects || []).map(p => p.name).filter(Boolean).slice(0, limit);
}

function matchProject(knowledge, question) {
  const lowerQuestion = normalizeQuestion(question);
  return (knowledge?.projects || []).find(project => {
    const name = normalizeQuestion(project.name);
    const compactName = name.replace(/\s+/g, '');
    const aliases = {
      'interactive pokedex': ['pokedex', 'poke dex', 'pokemon demo'],
      'projecthub': ['project hub', 'chat widget', 'recruiter chat'],
      'cheesemath': ['cheese math'],
      'triangle shader lab': ['shader lab', 'triangle demo', 'webgpu demo'],
      'aws serverless metadata extraction workflow': ['aws serverless workflow', 'metadata extraction', 'lambda workflow'],
      'aws infrastructure cost-analysis model': ['cost analysis', 'cost model'],
      'secrets & environment variables demo': ['secrets demo', 'environment variables demo', 'env variables demo']
    };
    return lowerQuestion.includes(name)
      || lowerQuestion.includes(compactName)
      || (aliases[name] || []).some(alias => lowerQuestion.includes(normalizeQuestion(alias)));
  });
}

function matchExperience(knowledge, pattern) {
  return (knowledge?.experience || []).find(item => pattern.test(`${item.role || ''} ${item.company || ''} ${item.summary || ''}`));
}

function answerWithFollowUps(reply, followUps) {
  const uniqueFollowUps = [...new Set((followUps || []).filter(Boolean))].slice(0, 3);
  return { reply, followUps: uniqueFollowUps };
}

function hashText(value) {
  let hash = 0;
  for (const char of String(value || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

function fallbackFlavor(question) {
  const phrases = [
    'Practical recruiter signal',
    'Grounded quick read',
    'Useful hiring context',
    'Worth a closer look',
    'Concrete project evidence',
    'Clear junior signal',
    'Verified profile note'
  ];
  return phrases[hashText(`${question}:${Date.now()}`) % phrases.length];
}

function cleanFlavor(value) {
  const cleaned = String(value || '')
    .replace(/["'`*_#<>]/g, '')
    .replace(/[^a-zA-Z0-9 .-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!-]+$/g, '');
  const words = cleaned.split(' ').filter(Boolean);
  const forbidden = /python|java\b|c\+\+|senior|guaranteed|perfect|hire him|best ever/i;
  if (words.length < 3 || words.length > 5 || forbidden.test(cleaned)) return null;
  return words.map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

async function generateFlavor(question) {
  if (activeGenerations >= MAX_ACTIVE_GENERATIONS) return { flavor: fallbackFlavor(question), source: 'fallback-flavor' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLAVOR_TIMEOUT_MS);
  activeGenerations++;
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: `Write exactly 3 to 5 professional words as a tiny label for this recruiter chat answer. No punctuation. No facts. Question: ${String(question).slice(0, 180)}\nLabel:`,
        stream: false,
        options: {
          num_predict: 8,
          num_ctx: 96,
          num_thread: 2,
          temperature: 0.45
        }
      })
    });
    if (!response.ok) return { flavor: fallbackFlavor(question), source: 'fallback-flavor' };
    const data = await response.json();
    return { flavor: cleanFlavor(data.response) || fallbackFlavor(question), source: cleanFlavor(data.response) ? 'ollama-flavor' : 'fallback-flavor' };
  } catch (error) {
    return { flavor: fallbackFlavor(question), source: 'fallback-flavor' };
  } finally {
    clearTimeout(timeout);
    activeGenerations = Math.max(0, activeGenerations - 1);
  }
}

async function addFlavor(payload, question, options = {}) {
  if (!payload || payload.offTopic || options.flavorEnabled === false) return payload;
  const flavor = await generateFlavor(question);
  return { ...payload, flavor: flavor.flavor, flavorSource: flavor.source };
}

function describeProject(project, question) {
  const lowerQuestion = normalizeQuestion(question);
  const tech = sentenceList(project.tech || [], 5);
  const url = project.url ? ` Recruiters can review it here: ${project.url}.` : '';
  const techSentence = tech ? ` It uses ${tech}.` : '';
  if (/tech|stack|built with|use|uses/.test(lowerQuestion)) {
    return `${project.name}'s main stack is ${tech || 'not listed in the public project data'}. In recruiter terms, the useful signal is not just the tool list, but that Bradley packaged the work into a public, inspectable project instead of leaving it as a private exercise.${url}`;
  }
  if (/tradeoff|decision|challenge|hard|improve|next/.test(lowerQuestion)) {
    return `A good discussion angle for ${project.name} is how Bradley balanced a small project scope with making the result understandable and reviewable. A reasonable next improvement would be deeper tests, clearer usage notes, or a more production-like deployment path depending on the project.`;
  }
  const relevance = /job|role|matter|recruiter|hire|candidate|prove|show/.test(lowerQuestion)
    ? ` For a job conversation, it matters because it shows Bradley can package a working browser experience, document it, host it publicly, and make it easy for someone else to inspect.`
    : '';
  return `${project.name} is a ${project.category || 'portfolio project'}: ${project.description}${techSentence}${relevance}${url}`;
}

function compareProjects(knowledge, question) {
  const lowerQuestion = normalizeQuestion(question);
  const matches = (knowledge?.projects || []).filter(project => lowerQuestion.includes(normalizeQuestion(project.name)));
  if (matches.length < 2) return null;
  const [first, second] = matches;
  return `${first.name} shows ${first.category || 'project'} work with ${sentenceList(first.tech || [], 4) || 'a focused implementation'}, while ${second.name} shows ${second.category || 'project'} work with ${sentenceList(second.tech || [], 4) || 'a different problem space'}. Together, they give recruiters a better read on Bradley's range than either project alone: ${first.name} demonstrates ${first.description.toLowerCase()}, and ${second.name} demonstrates ${second.description.toLowerCase()}.`;
}

function answerInterviewStory(knowledge, question) {
  const lowerQuestion = normalizeQuestion(question);
  if (/walk.*resume|resume.*walk/.test(lowerQuestion)) {
    return `A recruiter walkthrough should start with Bradley's B.S. in Web Development from Full Sail, then move into his AWS Cloud Support Engineer internship, where he completed support training, guided troubleshooting labs, and a serverless Lambda/DynamoDB/S3 capstone. After that, the strongest recent experience is CIRIS Ethical AI, where he worked on local setup, onboarding docs, JWT debugging, small merged updates, lint fixes, Docker Compose, and GitHub Issues, with older Army, case-management, and construction roles adding reliability, communication, and pressure-tested follow-through.`;
  }
  if (/tell.*about.*yourself|about.*bradley/.test(lowerQuestion)) {
    return `Bradley is a junior software engineer based in Davis, Illinois, open to relocation. His background combines web development, AWS support engineering training, troubleshooting, documentation, and AI-assisted development, with recent work through Full Sail, an AWS internship, and CIRIS Ethical AI.`;
  }
  const stories = knowledge?.interviewStories || [];
  const stopWords = new Set(['tell', 'about', 'yourself', 'through', 'with', 'what', 'when', 'where', 'like', 'recruiter', 'bradley', 'does', 'have', 'candidate']);
  const story = stories.find(item => {
    const prompt = normalizeQuestion(item.prompt);
    const keywords = prompt.split(' ').filter(word => word.length > 3 && !stopWords.has(word));
    return lowerQuestion.includes(prompt) || keywords.some(word => lowerQuestion.includes(word));
  });
  if (!story) return null;
  return story.answer
    .replace(/^I am\b/, 'Bradley is')
    .replace(/\bI finished\b/g, 'he finished')
    .replace(/\bI completed\b/g, 'he completed')
    .replace(/\bI worked\b/g, 'he worked')
    .replace(/\bI would\b/g, 'he would')
    .replace(/\bI like\b/g, 'he likes')
    .replace(/\bI enjoy\b/g, 'he enjoys')
    .replace(/\bI say\b/g, 'he says')
    .replace(/\bI do not\b/g, 'he does not')
    .replace(/\bMy background is\b/g, 'His background is');
}

function answerExperience(knowledge, question) {
  const lowerQuestion = normalizeQuestion(question);
  const experience = knowledge?.experience || [];
  let item = null;
  if (/army|military|veteran|healthcare|combat/.test(lowerQuestion)) item = matchExperience(knowledge, /army|healthcare|combat|military/i);
  if (/case manager|court|client|communication/.test(lowerQuestion)) item = item || matchExperience(knowledge, /case manager|mason county|court/i);
  if (/construction|roof|labor|blue collar|work ethic/.test(lowerQuestion)) item = item || matchExperience(knowledge, /roof|construction|stoneway|ascend/i);
  if (!item && /previous|past|experience|work history/.test(lowerQuestion)) {
    return `Bradley's work history combines recent technical experience with older roles that built reliability and communication: ${sentenceList(experience.slice(0, 4).map(job => `${job.role} at ${job.company}`), 4)}. For recruiter conversations, the most relevant thread is that he documents carefully, communicates with users or teammates, and stays organized under pressure.`;
  }
  if (!item) return null;
  return `${item.role} at ${item.company} matters because it adds context beyond code: ${item.summary} The transferable strengths are ${sentenceList(item.skills, 5)}, which fit junior engineering and support roles where communication and careful follow-through matter.`;
}

function answerGapsHonestly(knowledge, question) {
  const rawQuestion = String(question || '').toLowerCase();
  const lowerQuestion = normalizeQuestion(question);
  const learning = knowledge?.skills?.learningOrAdjacent || [];
  if (/concern|weakness|risk|gap|limitation|drawback|red flag|red flags|downside/.test(lowerQuestion)) {
    return `The main recruiter concern is scope: Bradley is still a junior candidate, so he should not be evaluated as someone with senior ownership or years of production leadership. The positive version of that is clear: he is honest about his level, has current web and AWS training, documents carefully, and is looking for a team where he can grow through real production work.`;
  }
  if (/senior|lead|architect|manager|enterprise|production ownership/.test(lowerQuestion)) {
    return `Bradley should be evaluated as a junior candidate, not as a senior engineer, architect, or manager. His value is in current web-development fundamentals, AWS support training, careful debugging, documentation, and a willingness to learn production systems from a strong team.`;
  }
  if (/erp|sap|salesforce|servicenow|dotnet|\bnet\b/.test(lowerQuestion) || /\.net|c#/.test(rawQuestion)) {
    return `Bradley does not claim direct professional ERP or C#/.NET experience. The honest adjacent fit is that he is currently learning C#/.NET fundamentals, interested in ERP and business workflows, and already has software-support instincts from debugging, documentation, and user-facing work.`;
  }
  if (/customer ticket|live customer|production ticket|on call/.test(lowerQuestion)) {
    return `Bradley's AWS internship used guided support rotations and lab environments, not live customer ticket ownership. That distinction matters, but the training still gave him useful practice with cloud troubleshooting, networking concepts, documentation, and customer-experience thinking.`;
  }
  return null;
}

function answerProcess(knowledge, question) {
  const lowerQuestion = normalizeQuestion(question);
  const workStyle = knowledge?.summary?.workStyle || [];
  const strengths = knowledge?.summary?.coreStrengths || [];
  if (/debug|troubleshoot|bug|broken|issue|problem/.test(lowerQuestion)) {
    return `Bradley's debugging style is methodical: read the nearby code, reproduce the issue, isolate one likely cause, make a small change, and verify it. That matches his stated work habits: ${sentenceList(workStyle, 4)}.`;
  }
  if (/ai|copilot|automation|prompt/.test(lowerQuestion)) {
    return `Bradley uses AI as a development accelerator, not as an unchecked source of truth. His profile specifically emphasizes verifying AI-generated suggestions, testing behavior, and documenting what he learns so the work remains understandable.`;
  }
  if (/work style|team|collaborat|communicat|strength/.test(lowerQuestion)) {
    return `Bradley's work style is practical and team-friendly: ${sentenceList(workStyle, 5)}. His core strengths include ${sentenceList(strengths, 5)}, which is especially useful in junior engineering and support-heavy roles.`;
  }
  if (/recruiter screen|screening|ats/.test(lowerQuestion)) {
    return `For an ATS or recruiter screen, Bradley maps best to junior web/software roles, cloud support, and application or technical support. The strongest keywords to verify are JavaScript, TypeScript, React, Node.js, SQL, AWS Lambda, DynamoDB, S3, debugging, documentation, GitHub, Docker, and API integration.`;
  }
  if (/software workflow|ci cd|crud|api|ticket|support|jargon/.test(lowerQuestion)) {
    return `In software-team jargon, Bradley's clearest fit is a junior contributor who can work tickets, read existing code, debug APIs, document setup steps, and grow into production SDLC practices. He should not be presented as owning mature CI/CD or large-scale production systems yet, but he has the habits that make that growth realistic.`;
  }
  return null;
}

function answerStrongestRole(knowledge, question) {
  const lowerQuestion = normalizeQuestion(question);
  const asksForSingleRole = /\b(strongest|best|most|primary|pick one|one role|which one|which role|had to pick|if you had to pick)\b/.test(lowerQuestion)
    && /\b(role|job|position|fit|lane|those|one)\b/.test(lowerQuestion);
  if (!asksForSingleRole) return null;

  const identity = knowledge?.identity || {};
  const name = identity.name || 'Bradley Matera';
  return answerWithFollowUps(
    `If a recruiter forced one strongest role, pick junior frontend/web developer for ${name}. That is the cleanest primary lane because his strongest evidence is visible JavaScript, React/Next.js, UI implementation, deployable portfolio work, debugging, and documentation; cloud support and software support are good adjacent fits, but frontend/web development is the strongest first screen.`,
    ['Which projects prove frontend fit?', 'How does cloud support fit as a backup?', 'What concerns should a recruiter know?']
  );
}

function buildPrompt(knowledge, question) {
  const identity = knowledge?.identity || {};
  const projects = (knowledge?.projects || []).slice(0, 6);
  const skills = (knowledge?.topSkills || knowledge?.skills?.languagesAndFrameworks || []).slice(0, 14);
  const certs = knowledge?.certifications || [];
  const experience = knowledge?.experience || [];
  const education = knowledge?.education || {};
  const summary = knowledge?.summary || {};
  const faq = (knowledge?.faq || []).find(f => question.toLowerCase().includes(f.question.toLowerCase().slice(0, 12)));

  const projectLines = projects.map(p => `- ${p.name}: ${p.description}`).join('\n');
  const skillLine = skills.join(', ');
  const certLine = Array.isArray(certs) ? certs.slice(0, 3).map(c => typeof c === 'string' ? c : c.name).join(', ') : '';
  const experienceLines = experience.slice(0, 4).map(e => `- ${e.role} at ${e.company}: ${e.summary || ''}`).join('\n');

  let prompt = `You are Bradley Matera's recruiter assistant. You answer naturally and conversationally, as if talking to a recruiter who is evaluating Bradley for a junior software engineering role.\n`;
  prompt += `CRITICAL RULES:\n`;
  prompt += `1. Use ONLY the verified facts below. Do NOT invent personal details, hobbies, food preferences, or facts not listed.\n`;
  prompt += `2. Answer in a friendly, professional tone. Write 1-3 complete sentences that sound human, not robotic.\n`;
  prompt += `3. If asked something not in the facts, say you don't have that detail and suggest a related recruiter topic you CAN answer.\n`;
  prompt += `4. Speak as an assistant ("Bradley has...", "He is..."), never as Bradley himself.\n`;
  prompt += `5. Do not mention Python, Java, C++, or traits not in the facts.\n\n`;

  prompt += `VERIFIED PROFILE:\n`;
  prompt += `Name: ${identity.name || 'Bradley Matera'}\n`;
  prompt += `Title: ${identity.title || 'Junior Software Engineer'}\n`;
  prompt += `Location: ${identity.location || 'Davis, Illinois'} (open to relocation)\n`;
  if (education.degree) prompt += `Education: ${education.degree} from ${education.school || 'Full Sail University'}${education.gpa ? `, GPA ${education.gpa}` : ''}\n`;
  if (skillLine) prompt += `Skills: ${skillLine}\n`;
  if (certLine) prompt += `Certifications: ${certLine}\n`;
  if (summary.whoIAm) prompt += `Summary: ${summary.whoIAm}\n`;
  if (experienceLines) prompt += `Experience:\n${experienceLines}\n`;
  if (projectLines) prompt += `Projects:\n${projectLines}\n`;
  if (faq) prompt += `Quick fact: ${faq.answer}\n`;
  prompt += `\nRecruiter asks: "${question}"\nYour answer:`;
  return prompt;
}

function buildConversationalUnknownPrompt(knowledge, question) {
  const identity = knowledge?.identity || {};
  const name = identity.name || 'Bradley Matera';
  const title = identity.title || 'junior software engineer';
  return [
    `You are Bradley Matera's recruiter assistant.`,
    `Answer naturally and conversationally in 1-2 short sentences.`,
    `You must not invent personal facts. If the requested fact is not in the verified profile, say you do not have that verified detail, then bridge to something useful a recruiter can ask next.`,
    `Known profile boundary: ${name} is a ${title}; verified topics include projects, skills, AWS experience, CIRIS work, education, certifications, target roles, work style, and contact links.`,
    `Question: ${String(question).slice(0, 500)}`,
    `Answer:`
  ].join('\n');
}

function buildGroundedFallbackPayload(knowledge, question) {
  const identity = knowledge?.identity || {};
  const summary = knowledge?.summary || {};
  const goals = knowledge?.goals || {};
  const education = knowledge?.education || {};
  const experience = knowledge?.experience || [];
  const name = identity.name || 'Bradley Matera';
  const title = identity.title || 'Junior Software Engineer';
  const location = identity.location || 'Davis, Illinois';
  const skillGroups = knowledge?.skills || {};
  const skills = (knowledge?.topSkills || skillGroups.languagesAndFrameworks || []).slice(0, 8);
  const cloudSkills = (skillGroups.cloudAndInfrastructure || []).slice(0, 5);
  const tools = (skillGroups.toolsAndWorkflows || []).slice(0, 5);
  const certs = certNames(knowledge?.certifications).slice(0, 2);
  const projects = knowledge?.projects || [];
  const lowerQuestion = normalizeQuestion(question);
  const aws = experience.find(item => /aws|amazon/i.test(`${item.company} ${item.role}`));
  const ciris = experience.find(item => /ciris/i.test(`${item.company} ${item.role}`));

  const strongestRoleAnswer = answerStrongestRole(knowledge, question);
  if (strongestRoleAnswer) return strongestRoleAnswer;

  const honestGapAnswer = answerGapsHonestly(knowledge, question);
  if (honestGapAnswer) return answerWithFollowUps(honestGapAnswer, ['What roles is Bradley targeting?', 'What is Bradley learning now?', 'What is his strongest current fit?']);

  if (/ciris|ethical ai|freelance|frontend contributor/.test(lowerQuestion)) {
    return answerWithFollowUps(`${name}'s CIRIS Ethical AI work involved running the project locally, improving onboarding documentation, adding JWT token-verification logging, and contributing small merged frontend and lint updates. That experience is useful because it shows he can enter an existing codebase carefully and leave clearer setup notes for the next contributor.`, ['What did Bradley change at CIRIS?', 'How does he debug issues?', 'What project best shows collaboration?']);
  }

  const processAnswer = answerProcess(knowledge, question);
  if (processAnswer) return answerWithFollowUps(processAnswer, ['Tell me about CIRIS Ethical AI', 'What AWS experience does Bradley have?', 'What is his work style?']);

  if (/aws|cloud|lambda|dynamo|s3|amplify|serverless/.test(lowerQuestion)) {
    return answerWithFollowUps(`${name}'s AWS background includes ${aws?.role || 'Cloud Support Engineer internship'} work focused on support training, troubleshooting labs, and a serverless metadata extraction workflow. His related stack includes ${sentenceList(cloudSkills, 5)}, backed by ${sentenceList(certs, 2)}. The honest scope is training, labs, and project work rather than live customer ticket ownership.`, ['Tell me about the AWS serverless workflow', 'What AWS certifications does he have?', 'How does this fit cloud support roles?']);
  }

  const comparisonAnswer = compareProjects(knowledge, question);
  if (comparisonAnswer) return answerWithFollowUps(comparisonAnswer, ['Which project is most relevant to frontend roles?', 'Which project shows cloud experience?', 'List Bradley’s projects']);

  const matchedProject = matchProject(knowledge, question);
  if (matchedProject) {
    return answerWithFollowUps(describeProject(matchedProject, question), [`What tech stack did ${matchedProject.name} use?`, `What tradeoffs or improvements would you discuss for ${matchedProject.name}?`, `Compare ${matchedProject.name} with Interactive Pokedex`]);
  }

  if (/\b(this|that) project\b/.test(lowerQuestion)) {
    return answerWithFollowUps(`Which project do you mean? Bradley's portfolio includes ${sentenceList(projectNames(projects, 5), 5)}. Ask with the project name and I can give a specific recruiter-focused answer.`, ['Tell me about ProjectHub', 'Tell me about Interactive Pokedex', 'Which project shows AWS experience?']);
  }

  const experienceAnswer = answerExperience(knowledge, question);
  if (experienceAnswer) return answerWithFollowUps(experienceAnswer, ['How does that transfer to software work?', 'Tell me about his AWS internship', 'Why is he a good junior candidate?']);

  if (/contact|email|phone|reach|reached|reaching|linkedin|github/.test(lowerQuestion)) {
    return answerWithFollowUps(`You can reach ${name} at ${identity.email || 'bradmatera@gmail.com'}${identity.phone ? ` or ${identity.phone}` : ''}. His portfolio is ${identity.portfolioUrl || 'https://bradleymatera.dev/'}, LinkedIn is ${identity.linkedInUrl || 'https://www.linkedin.com/in/bradmatera'}, and GitHub is ${identity.gitHubUrl || 'https://github.com/BradleyMatera'}.`, ['Summarize Bradley as a junior software engineer', 'What roles is Bradley targeting?', 'What is his GitHub?']);
  }

  if (/education|degree|school|full sail|gpa|course/.test(lowerQuestion)) {
    return answerWithFollowUps(`${name} earned a ${education.degree || 'B.S. in Web Development'} from ${education.school || 'Full Sail University'}${education.gpa ? ` with a ${education.gpa} GPA` : ''}. Relevant coursework includes ${sentenceList(education.relevantCoursework, 5)}, which supports his web and application-development focus.`, ['What did he build at Full Sail?', 'What certifications does he have?', 'What roles is he targeting?']);
  }

  if (/cert|certificate|certification/.test(lowerQuestion)) {
    return answerWithFollowUps(`${name}'s certifications include ${sentenceList(certNames(knowledge?.certifications), 4)}. The AWS credentials reinforce his cloud-support and serverless project background, while the freeCodeCamp work supports his frontend fundamentals.`, ['Does Bradley have AWS experience?', 'What is his strongest technical background?', 'Tell me about the AWS serverless workflow']);
  }

  if (/role|target|job|looking|relocation/.test(lowerQuestion)) {
    return answerWithFollowUps(`${name} is targeting ${sentenceList(goals.targetRoles, 5)} roles. He is based in ${location}, and his short-term goal is to join a team where he can learn production systems, debug carefully, document well, and contribute to real software.`, ['Why is he a good junior candidate?', 'What technical support roles fit him?', 'How does his AWS background help?']);
  }

  if (/project|portfolio|built|demo|work sample/.test(lowerQuestion)) {
    return answerWithFollowUps(`${name}'s portfolio gives recruiters concrete examples to inspect, including ${sentenceList(projectNames(projects, 5), 5)}. Those projects show practical work with ${sentenceList(skills, 5)}, API integration, debugging, documentation, and deployable web experiences.`, ['Which project is best for frontend roles?', 'Which project shows AWS experience?', 'Compare ProjectHub and Interactive Pokedex']);
  }

  if (/why|good|fit|candidate|hire|ready/.test(lowerQuestion)) {
    return answerWithFollowUps(`${name} is a strong ${title.toLowerCase()} candidate because he has a focused web-development base in ${skills.join(', ')} and current AWS training that recruiters can verify through real portfolio work. He is based in ${location} and brings practical strengths in debugging, documentation, and building clear project demos, while being honest about still growing at the junior level.`, ['Walk me through his resume', 'What are his strongest technical skills?', 'What concerns should a recruiter know?']);
  }

  if (/skill|stack|technical|background/.test(lowerQuestion)) {
    return answerWithFollowUps(`${name}'s strongest technical background is ${sentenceList(skills, 8)}, with additional AWS project experience around ${sentenceList(cloudSkills, 4)}. He also works with ${sentenceList(tools, 4)}, which gives him a practical junior-level base for web, support, and cloud-adjacent roles.`, ['Which projects prove those skills?', 'Does he have AWS experience?', 'What is he still learning?']);
  }

  const interviewAnswer = answerInterviewStory(knowledge, question);
  if (interviewAnswer) return answerWithFollowUps(interviewAnswer, ['Walk me through his resume', 'Why is he a good junior candidate?', 'How does he handle not knowing something?']);

  return answerWithFollowUps(`${name} is a ${title} based in ${location}, with a practical foundation in ${sentenceList(skills, 7)}. ${summary.whoIAm || 'He combines web development, AWS training, debugging habits, documentation skills, and project work that gives recruiters concrete examples to review.'}`, ['Why is Bradley a good junior candidate?', 'What projects should I inspect?', 'How can I contact Bradley?']);
}

function buildGroundedFallback(knowledge, question) {
  return buildGroundedFallbackPayload(knowledge, question).reply;
}

function shouldUseGroundedAnswer(question) {
  const rawQuestion = String(question || '').toLowerCase();
  return /\b(contact|email|phone|reach|reached|reaching|linkedin|github|education|degree|school|full sail|gpa|cert|certificate|certification|role|target|job|looking|relocation|aws|cloud|lambda|dynamo|s3|amplify|serverless|ciris|ethical ai|freelance|frontend contributor|project|portfolio|built|demo|work sample|skill|stack|technical|background|resume|interview|work style|debug|troubleshoot|team|collaborat|communicat|army|military|veteran|construction|roof|case manager|court|erp|dotnet|net|senior|lead|architect|customer ticket|live customer|compare|concern|weakness|gap|risk|red flag|downside|screening|ats|onboarding|jargon|ticket|crud|api|sdlc|ci cd|production|on call)\b/.test(normalizeQuestion(question)) || /\.net|c#/.test(rawQuestion);
}

function isProbablyRelevant(question) {
  return /\b(bradley|brad|matera|candidate|hire|recruiter|software|engineer|developer|frontend|backend|web|aws|cloud|support|skill|stack|technical|background|project|projects|portfolio|codepen|github|linkedin|contact|email|phone|reach|reached|reaching|role|job|relocation|education|degree|school|cert|certificate|ciris|ethical ai|debug|documentation|experience|intern|internship|resume|compare|pokedex|projecthub|cheesemath|shader|serverless|army|military|concern|weakness|gap|risk|red flag|downside|screening|ats|jargon|ticket|crud|api|sdlc|production|on call|favorite|favourite|food|hobby|hobbies|personal|personality|interest|interests)\b/.test(normalizeQuestion(question));
}

function asksUnverifiedPersonalDetail(question) {
  const q = normalizeQuestion(question);
  const hasPersonalKeyword = /\b(favorite|favourite|food|hobby|hobbies|personal|personality|interest|interests|music|movie|game|pet|family|married|kids|children|birthday|age|height|weight|hometown|born)\b/.test(q);
  const hasBradContext = /\b(bradley|brad|matera|he|his|him)\b/.test(q);
  return hasPersonalKeyword && hasBradContext;
}

function cleanModelReply(reply, knowledge, question) {
  const cleaned = String(reply || '').trim().replace(/\s+/g, ' ');
  // Only catch clear hallucinations and inventions, not formatting
  const forbidden = /\b(Python|C\+\+|Java\b|under pressure|various programming languages|business applications|employers|following skills|highly valued|open source project|comprehensive set of guidelines|ethics, security, privacy|aims to create)\b/i;
  const inventedPersonal = /\b(pizza|sushi|burger|spaghetti|tacos|favorite food is|loves eating|hates eating|married|children|wife|husband|girlfriend|boyfriend|born in [0-9]{4}|age [0-9]{1,2})\b/i;
  const looksIncomplete = /[,;:]$/i.test(cleaned);
  if (!cleaned || cleaned.length < 20 || forbidden.test(cleaned) || inventedPersonal.test(cleaned) || looksIncomplete) {
    return { reply: buildGroundedFallback(knowledge, question), fallback: true };
  }
  return { reply: cleaned, fallback: false };
}

function cleanConversationalReply(reply, knowledge, question) {
  const cleaned = String(reply || '').trim().replace(/\s+/g, ' ');
  const forbidden = /\b(Python|C\+\+|Java\b|pizza|sushi|burger|favorite food is|loves eating|hates eating|born in|married|children)\b/i;
  if (!cleaned || cleaned.length < 30 || forbidden.test(cleaned)) {
    return {
      reply: `I do not have Bradley's favorite food or that kind of personal detail in the verified profile. I can answer safely about recruiter-relevant details though, like his strongest role fit, projects, AWS background, work style, or contact links.`,
      fallback: true
    };
  }
  return { reply: cleaned, fallback: false };
}

async function generateConversationalUnknown(knowledge, userMessage, requestOptions) {
  if (activeGenerations >= MAX_ACTIVE_GENERATIONS) {
    return addFlavor({
      reply: `I do not have that personal detail verified for Bradley. I can still help with recruiter-useful questions about his projects, role fit, AWS background, strengths, gaps, or contact links.`,
      model: OLLAMA_MODEL,
      fallback: true
    }, userMessage, requestOptions);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(OLLAMA_TIMEOUT_MS, 6500));
  activeGenerations++;
  try {
    const ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: buildConversationalUnknownPrompt(knowledge, userMessage),
        stream: false,
        options: {
          num_predict: 48,
          num_ctx: 256,
          num_thread: 2,
          temperature: 0.35
        }
      })
    });
    if (!ollamaResponse.ok) throw new Error(`Ollama HTTP ${ollamaResponse.status}`);
    const data = await ollamaResponse.json();
    const result = cleanConversationalReply(data.response, knowledge, userMessage);
    return addFlavor({ reply: result.reply, model: OLLAMA_MODEL, fallback: result.fallback, generative: true }, userMessage, requestOptions);
  } catch (error) {
    return addFlavor({
      reply: `I do not have that personal detail verified for Bradley. I can still help with recruiter-useful questions about his projects, role fit, AWS background, strengths, gaps, or contact links.`,
      model: OLLAMA_MODEL,
      fallback: true,
      generative: false
    }, userMessage, requestOptions);
  } finally {
    clearTimeout(timeout);
    activeGenerations = Math.max(0, activeGenerations - 1);
  }
}

app.post('/api/chat', async (req, res) => {
  let userMessage = '';
  try {
    userMessage = String(req.body.message || '').trim();
    const requestOptions = req.body.options && typeof req.body.options === 'object' ? req.body.options : {};
    if (!userMessage) return res.status(400).json({ error: 'Missing message.' });
    if (userMessage.length > 600) return res.status(400).json({ error: 'Message is too long.' });

    const cached = getCachedReply(userMessage);
    if (cached) return res.json({ ...cached, ...(requestOptions.flavorEnabled === false ? {} : await generateFlavor(userMessage)), cached: true });

    const knowledge = await fetchKnowledge();
    if (!knowledge) {
      const payload = await addFlavor({ ...buildGroundedFallbackPayload({}, userMessage), model: OLLAMA_MODEL, fallback: true }, userMessage, requestOptions);
      setCachedReply(userMessage, payload);
      return res.json(payload);
    }

    // NEW PRIORITY: Try AI generation FIRST for all relevant questions.
    // Grounded templates are used only as a fallback if AI fails or produces weak output.

    if (!isProbablyRelevant(userMessage)) {
      const payload = await generateConversationalUnknown(knowledge, userMessage, requestOptions);
      setCachedReply(userMessage, payload);
      return res.json(payload);
    }

    if (asksUnverifiedPersonalDetail(userMessage)) {
      const payload = await generateConversationalUnknown(knowledge, userMessage, requestOptions);
      setCachedReply(userMessage, payload);
      return res.json(payload);
    }

    // REMOVED: shouldUseGroundedAnswer bypass. Now ALL relevant recruiter questions
    // go through the AI-first path. Templates are only used as a fallback.

    // === AI-FIRST PATH ===
    // Attempt Ollama generation for ALL relevant questions before falling back to templates.
    let aiReply = null;
    let aiFailed = false;

    if (activeGenerations < MAX_ACTIVE_GENERATIONS) {
      const prompt = buildPrompt(knowledge, userMessage);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
      activeGenerations++;

      try {
        const ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt,
            stream: false,
            options: {
              num_predict: 42,
              num_ctx: 256,
              num_thread: 2,
              temperature: 0.35
            }
          })
        });

        clearTimeout(timeout);

        if (ollamaResponse.ok) {
          const data = await ollamaResponse.json();
          const result = cleanModelReply(data.response, knowledge, userMessage);
          if (!result.fallback && result.reply && result.reply.length > 20) {
            aiReply = result.reply;
          } else {
            aiFailed = true; // Model returned weak/generic output
          }
        } else {
          aiFailed = true;
          console.error('Ollama upstream failed:', (await ollamaResponse.text()).slice(0, 500));
        }
      } catch (err) {
        aiFailed = true;
        console.error('Ollama generation error:', err.message);
      } finally {
        activeGenerations = Math.max(0, activeGenerations - 1);
      }
    } else {
      aiFailed = true;
    }

    // If AI produced a good reply, use it
    if (aiReply) {
      const payload = await addFlavor({
        reply: aiReply,
        model: OLLAMA_MODEL,
        fallback: false,
        generative: true
      }, userMessage, requestOptions);
      setCachedReply(userMessage, payload);
      return res.json(payload);
    }

    // === FALLBACK: Grounded templates only when AI fails ===
    const fallbackPayload = await addFlavor({
      ...buildGroundedFallbackPayload(knowledge, userMessage),
      model: OLLAMA_MODEL,
      fallback: true,
      aiFailed
    }, userMessage, requestOptions);
    setCachedReply(userMessage, fallbackPayload);
    return res.json(fallbackPayload);
  } catch (err) {
    activeGenerations = Math.max(0, activeGenerations - 1);
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
