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
  return String(question || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
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
    return lowerQuestion.includes(name) || lowerQuestion.includes(compactName);
  });
}

function matchExperience(knowledge, pattern) {
  return (knowledge?.experience || []).find(item => pattern.test(`${item.role || ''} ${item.company || ''} ${item.summary || ''}`));
}

function answerWithFollowUps(reply, followUps) {
  const uniqueFollowUps = [...new Set((followUps || []).filter(Boolean))].slice(0, 3);
  return { reply, followUps: uniqueFollowUps };
}

function describeProject(project, question) {
  const lowerQuestion = normalizeQuestion(question);
  const tech = sentenceList(project.tech || [], 5);
  const url = project.url ? ` Recruiters can review it here: ${project.url}.` : '';
  const techSentence = tech ? ` It uses ${tech}.` : '';
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
  if (/concern|weakness|risk|gap|limitation|drawback/.test(lowerQuestion)) {
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
  return null;
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

  const honestGapAnswer = answerGapsHonestly(knowledge, question);
  if (honestGapAnswer) return answerWithFollowUps(honestGapAnswer, ['What roles is Bradley targeting?', 'What is Bradley learning now?', 'What is his strongest current fit?']);

  const processAnswer = answerProcess(knowledge, question);
  if (processAnswer) return answerWithFollowUps(processAnswer, ['Tell me about CIRIS Ethical AI', 'What AWS experience does Bradley have?', 'What is his work style?']);

  if (/aws|cloud|lambda|dynamo|s3|amplify|serverless/.test(lowerQuestion)) {
    return answerWithFollowUps(`${name}'s AWS background includes ${aws?.role || 'Cloud Support Engineer internship'} work focused on support training, troubleshooting labs, and a serverless metadata extraction workflow. His related stack includes ${sentenceList(cloudSkills, 5)}, backed by ${sentenceList(certs, 2)}. The honest scope is training, labs, and project work rather than live customer ticket ownership.`, ['Tell me about the AWS serverless workflow', 'What AWS certifications does he have?', 'How does this fit cloud support roles?']);
  }

  if (/ciris|ethical ai|freelance|frontend contributor/.test(lowerQuestion)) {
    return answerWithFollowUps(`${name}'s CIRIS Ethical AI work involved running the project locally, improving onboarding documentation, adding JWT token-verification logging, and contributing small merged frontend and lint updates. That experience is useful because it shows he can enter an existing codebase carefully and leave clearer setup notes for the next contributor.`, ['What did Bradley change at CIRIS?', 'How does he debug issues?', 'What project best shows collaboration?']);
  }

  const comparisonAnswer = compareProjects(knowledge, question);
  if (comparisonAnswer) return answerWithFollowUps(comparisonAnswer, ['Which project is most relevant to frontend roles?', 'Which project shows cloud experience?', 'List Bradley’s projects']);

  const matchedProject = matchProject(knowledge, question);
  if (matchedProject) {
    return answerWithFollowUps(describeProject(matchedProject, question), ['How does this project relate to a job?', 'Compare it with another project', 'What tech stack did Bradley use?']);
  }

  const experienceAnswer = answerExperience(knowledge, question);
  if (experienceAnswer) return answerWithFollowUps(experienceAnswer, ['How does that transfer to software work?', 'Tell me about his AWS internship', 'Why is he a good junior candidate?']);

  if (/contact|email|phone|reach|linkedin|github/.test(lowerQuestion)) {
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
  return /\b(contact|email|phone|reach|linkedin|github|education|degree|school|full sail|gpa|cert|certificate|certification|role|target|job|looking|relocation|aws|cloud|lambda|dynamo|s3|amplify|serverless|ciris|ethical ai|freelance|frontend contributor|project|portfolio|built|demo|work sample|skill|stack|technical|background|resume|interview|work style|debug|troubleshoot|team|collaborat|communicat|army|military|veteran|construction|roof|case manager|court|erp|dotnet|net|senior|lead|architect|customer ticket|live customer|compare|concern|weakness|gap|risk)\b/.test(normalizeQuestion(question)) || /\.net|c#/.test(rawQuestion);
}

function isProbablyRelevant(question) {
  return /\b(bradley|brad|matera|candidate|hire|recruiter|software|engineer|developer|frontend|backend|web|aws|cloud|support|skill|stack|technical|background|project|portfolio|codepen|github|linkedin|contact|email|phone|role|job|relocation|education|degree|school|cert|certificate|ciris|ethical ai|debug|documentation|experience|intern|internship|resume|compare|pokedex|projecthub|cheesemath|shader|serverless|army|military|concern|weakness|gap|risk)\b/.test(normalizeQuestion(question));
}

function cleanModelReply(reply, knowledge, question) {
  const cleaned = String(reply || '').trim().replace(/\s+/g, ' ');
  const forbidden = /\b(Python|C\+\+|Java\b|under pressure|various programming languages|business applications|employers|following skills|highly valued|open source project|comprehensive set of guidelines|ethics, security, privacy|aims to create)\b/i;
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
    if (userMessage.length > 600) return res.status(400).json({ error: 'Message is too long.' });

    const cached = getCachedReply(userMessage);
    if (cached) return res.json({ ...cached, cached: true });

    const knowledge = await fetchKnowledge();
    if (!knowledge) {
      const payload = { ...buildGroundedFallbackPayload({}, userMessage), model: OLLAMA_MODEL, fallback: true };
      setCachedReply(userMessage, payload);
      return res.json(payload);
    }

    if (!isProbablyRelevant(userMessage)) {
      const payload = { reply: `I’m best used for recruiter questions about Bradley Matera: his projects, AWS experience, CIRIS work, technical skills, target roles, education, certifications, and contact links. Try asking one of those and I’ll answer from verified profile details.`, model: OLLAMA_MODEL, fallback: true, offTopic: true };
      setCachedReply(userMessage, payload);
      return res.json(payload);
    }

    if (shouldUseGroundedAnswer(userMessage)) {
      const payload = { ...buildGroundedFallbackPayload(knowledge, userMessage), model: OLLAMA_MODEL, fallback: true };
      setCachedReply(userMessage, payload);
      return res.json(payload);
    }

    if (activeGenerations >= MAX_ACTIVE_GENERATIONS) {
      const payload = { ...buildGroundedFallbackPayload(knowledge, userMessage), model: OLLAMA_MODEL, fallback: true, queued: false };
      setCachedReply(userMessage, payload);
      return res.json(payload);
    }

    const prompt = buildPrompt(knowledge, userMessage);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    activeGenerations++;

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
    activeGenerations = Math.max(0, activeGenerations - 1);

    if (!ollamaResponse.ok) {
      const text = await ollamaResponse.text();
      console.error('Ollama upstream failed:', text.slice(0, 500));
      const payload = { ...buildGroundedFallbackPayload(knowledge, userMessage), model: OLLAMA_MODEL, fallback: true };
      setCachedReply(userMessage, payload);
      return res.json(payload);
    }

    const data = await ollamaResponse.json();
    const result = cleanModelReply(data.response, knowledge, userMessage);
    const payload = {
      reply: result.reply,
      model: OLLAMA_MODEL,
      fallback: result.fallback
    };
    setCachedReply(userMessage, payload);

    return res.json(payload);
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
