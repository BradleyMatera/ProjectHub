const projects = [
  {
    name: "AWS Serverless Metadata Extraction Workflow",
    desc: "AWS internship capstone that extracts metadata with Lambda, DynamoDB, S3, and an accessible frontend on AWS Amplify.",
    url: null,
    platform: "AWS",
    repo: "https://github.com/BradleyMatera",
    tech: ["AWS Lambda", "Amazon DynamoDB", "Amazon S3", "AWS Amplify"],
    apiEndpoint: null
  },
  {
    name: "AWS Infrastructure Cost-Analysis Model",
    desc: "Transparent cost model using measurable cloud inputs such as request counts, GB-month, compute time, read/write units, and transfer out.",
    url: null,
    platform: "AWS",
    repo: "https://github.com/BradleyMatera",
    tech: ["AWS usage metrics", "Data analysis", "Modeling"],
    apiEndpoint: null
  },
  {
    name: "CIRIS Ethical AI",
    desc: "Freelance contributor work on a real open-source project: local setup, onboarding docs, small code updates, JWT guidance, debugging, and GitHub issue tracking.",
    url: null,
    platform: "GitHub",
    repo: "https://github.com/BradleyMatera",
    tech: ["JavaScript", "Docker Compose", "GitHub", "JWT"],
    apiEndpoint: null
  },
  {
    name: "ProjectHub",
    desc: "Embeddable AI-powered chat widget that showcases Bradley's web development projects and CodePens. Served from GitHub Pages as a single script.",
    url: "https://bradleymatera.github.io/ProjectHub/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/ProjectHub",
    tech: ["JavaScript", "GitHub Pages"],
    apiEndpoint: null
  },
  {
    name: "Interactive Pokedex",
    desc: "Static Gen 1 Pokedex UI with all 151 entries, client-side search/filtering, data display, and theme controls.",
    url: "https://bradleymatera.github.io/Interactive-Pokedex/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/Interactive-Pokedex",
    tech: ["JavaScript", "HTML", "CSS"],
    apiEndpoint: null
  },
  {
    name: "CheeseMath",
    desc: "Calculator and testing demo with arithmetic, string operations, regex analysis, input handling, and Jest validation.",
    url: "https://bradleymatera.github.io/CheeseMath-Jest-Tests/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/CheeseMath-Jest-Tests",
    tech: ["JavaScript", "Jest"],
    apiEndpoint: null
  },
  {
    name: "Secrets & Environment Variables Demo",
    desc: "Educational frontend demo showing why secrets should not be hardcoded and how environment-variable concepts apply to application configuration.",
    url: "https://bradleymatera.github.io/EthicsFrontEndDemo/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/EthicsFrontEndDemo",
    tech: ["JavaScript", "HTML", "CSS"],
    apiEndpoint: null
  },
  {
    name: "Animal Sounds",
    desc: "Interactive animal soundboard UI with audio playback and responsive frontend styling.",
    url: "https://bradleymatera.github.io/AnimalSounds/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/AnimalSounds",
    tech: ["JavaScript", "HTML", "CSS"],
    apiEndpoint: null
  },
  {
    name: "Triangle Shader Lab",
    desc: "WebGPU learning demo with hello-triangle and textured-cube examples in a browser-based layout.",
    url: "https://bradleymatera.github.io/TriangleDemo/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/TriangleDemo",
    tech: ["WebGPU", "JavaScript", "HTML"],
    apiEndpoint: null
  },
  {
    name: "Fallen Knight: Requiem of Honor",
    desc: "KAJAM game jam project built with classmates, ranked #9 in Artstyle.",
    url: "https://itch.io/jam/kajam/rate/3114394",
    platform: "itch.io",
    repo: "https://github.com/BradleyMatera",
    tech: [],
    apiEndpoint: null
  }
];

const codePens = [
  { name: "JavaScript Garbage Collection Tutorial", url: "https://codepen.io/student-account-bradley-matera/pen/ZYzoWpL" },
  { name: "React Calculator", url: "https://codepen.io/student-account-bradley-matera/pen/ogvGZjJ" },
  { name: "Sound Machine", url: "https://codepen.io/student-account-bradley-matera/details/dPbVvoa" },
  { name: "Markdown Previewer", url: "https://codepen.io/student-account-bradley-matera/pen/ZYzXeEJ" },
  { name: "Random Quote Machine", url: "https://codepen.io/student-account-bradley-matera/pen/azoLpeG" },
  { name: "Random Quote Generator", url: "https://codepen.io/student-account-bradley-matera/pen/PwYJWMY" },
  { name: "Data Visualization", url: "https://codepen.io/student-account-bradley-matera/details/dyEYbPO" }
];

// Dropdown suggestions
const suggestions = [
  "Summarize Bradley as a junior software engineer",
  "What’s Bradley’s GitHub?",
  "What’s Bradley’s LinkedIn?",
  "What roles is Bradley targeting?",
  "What is Bradley’s strongest technical background?",
  "Does Bradley have AWS experience?",
  "Tell me about the AWS serverless workflow",
  "Tell me about CIRIS Ethical AI",
  "Tell me about ProjectHub",
  "Tell me about the Interactive Pokedex",
  "Tell me about CheeseMath",
  "Tell me about the Triangle Shader Lab",
  "List all projects",
  "List all CodePens",
  "How can I contact Bradley?"
];// In-memory cache for GitHub metadata so we never block on repeated or slow API calls
const __githubCache = {};

// Function to fetch GitHub repo data (e.g., stars, last commit)
async function fetchGitHubRepoData(repoUrl) {
  if (__githubCache[repoUrl]) {
    return __githubCache[repoUrl];
  }
  const repoPath = repoUrl.replace("https://github.com/", "");
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second cap
    const response = await fetch(`https://api.github.com/repos/${repoPath}`, {
      signal: controller.signal,
      headers: {
        "Accept": "application/vnd.github.v3+json"
      }
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      __githubCache[repoUrl] = { stars: 0, lastCommit: "Unknown" };
      return __githubCache[repoUrl];
    }
    const data = await response.json();
    __githubCache[repoUrl] = {
      stars: data.stargazers_count || 0,
      lastCommit: data.pushed_at ? new Date(data.pushed_at).toLocaleDateString() : "Unknown"
    };
    return __githubCache[repoUrl];
  } catch (error) {
    console.error("GitHub fetch error:", error);
    __githubCache[repoUrl] = { stars: 0, lastCommit: "Unknown" };
    return __githubCache[repoUrl];
  }
}

// Function to fetch all GitHub data for projects (non-blocking background fill)
async function fetchAllGitHubData(projects) {
  const projectData = projects.map(p => ({ ...p, githubData: __githubCache[p.repo] || { stars: 0, lastCommit: "Unknown" } }));
  // Kick off background refresh without blocking
  Promise.all(projects.map(async (project) => {
    try {
      await fetchGitHubRepoData(project.repo);
    } catch (e) {
      console.error("Background GitHub refresh error:", e);
    }
  })).catch(() => {});
  return projectData;
}// Function to summarize Bradley Matera as a junior software engineer
function summarizeBradleyAsWebDev(projects, codePens) {
  const allTech = [...new Set(projects.flatMap(p => p.tech).filter(Boolean))];
  const projectCount = projects.length;
  const codePenCount = codePens.length;
  const frontEndTech = ["JavaScript", "TypeScript", "React", "Next.js", "HTML", "CSS"].filter(t => allTech.includes(t));
  const cloudTech = ["AWS Lambda", "Amazon DynamoDB", "Amazon S3", "AWS Amplify", "AWS usage metrics"].filter(t => allTech.includes(t));

  let summary = "Bradley Matera is a junior software engineer based in Davis, Illinois, open to relocation. He graduated with a B.S. in Web Development from Full Sail University (GPA 3.64) and is certified as an AWS Solutions Architect - Associate and AWS Certified AI Practitioner.<br><br>";
  summary += `He has worked on ${projectCount} portfolio projects and ${codePenCount} CodePen demos, with a focus on JavaScript, React/Next.js, Node.js, SQL, and AWS serverless services.<br><br>`;

  if (frontEndTech.length > 0) {
    summary += `<strong>Frontend work:</strong> ${frontEndTech.join(", ")} — building accessible UIs, interactive demos, and clear documentation.<br><br>`;
  }

  if (cloudTech.length > 0) {
    summary += `<strong>Cloud and support engineering:</strong> ${cloudTech.join(", ")} — including an AWS Cloud Support Engineer internship with guided troubleshooting labs, a serverless metadata extraction capstone, and an infrastructure cost-analysis model.<br><br>`;
  }

  summary += `<strong>Recent experience:</strong> Freelance junior frontend contributor at CIRIS Ethical AI (setup docs, JWT debugging, small merged updates, GitHub Issues) and prior roles in case management, construction, and the U.S. Army.<br><br>`;
  summary += `<strong>What he is looking for:</strong> Junior software engineering, frontend/backend/web development, cloud support, software support, application support, and technical support roles where he can learn production systems, debug carefully, document clearly, and grow into a well-rounded engineer.`;
  return summary;
}

// Function to provide a short summary of Bradley Matera
function shortSummaryBradleyAsWebDev(projects, codePens) {
  return "Bradley Matera is a junior software engineer in Davis, Illinois, open to relocation. He holds a B.S. in Web Development from Full Sail University, AWS Solutions Architect - Associate and AWS Certified AI Practitioner certifications, and has experience with JavaScript, TypeScript, React, Node.js, AWS serverless services, debugging, documentation, and AI-assisted development workflows.";
}

// Function to handle user queries
async function handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData, chatSession = {}) {
  const query = userQuery.toLowerCase();
  const normalizedQuery = query.replace(/\bbrads\b|\bbrad\b/g, "bradley");
  let reply = "I don’t know that one. Try asking about Bradley Matera's current work — projects like ProjectHub, the AWS serverless workflow, or CIRIS Ethical AI; his GitHub or LinkedIn; the roles he's targeting; or his strongest technical skills. You can also ask for a summary of Bradley as a junior software engineer.";
  let newTopic = lastQueryTopic;

  // Architecture:
  // - bradleymatera.dev (production): use Netlify Functions with Gemini Flash
  //   /.netlify/functions/recruiter-chat = smart, fast, free tier
  // - Other domains / local dev: use GCP Ollama API as fallback
  // - Manual override: window.__PROJECTHUB_CHAT_API__
  const CHAT_API_URL = window.__PROJECTHUB_CHAT_API__
    || (/^(^|\.)bradleymatera\.dev$/.test(window.location.hostname)
      ? "/.netlify/functions/recruiter-chat"
      : "https://projecthub-chat.bradleymatera.dev/api/chat");
  const AI_TIMEOUT_MS = 18000;
  const AI_RETRIES = 1;

  async function askAIBackend() {
    let lastError = null;

    function escapeHtml(value) {
      return String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
    }

    for (let attempt = 1; attempt <= AI_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
        // Transform conversation context into backend history format
        const history = (Array.isArray(chatSession.context) ? chatSession.context : []).reduce((acc, turn) => {
          if (turn.role === 'user') {
            acc.push({ user: turn.content, assistant: '' });
          } else if (turn.role === 'bot' && acc.length > 0) {
            acc[acc.length - 1].assistant = turn.content;
          }
          return acc;
        }, []).slice(-3);

        const res = await fetch(CHAT_API_URL, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: userQuery,
            sessionId: chatSession.sessionId,
            history,
            options: chatSession.options || {}
          })
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          if (data.reply) {
            const flavor = data.flavor
              ? `<span class="ai-flavor" title="Tiny generated phrase">${escapeHtml(data.flavor)}</span><br>`
              : "";
            const followUps = Array.isArray(data.followUps) && data.followUps.length
              ? `<div class="followup-list"><strong>Good follow-ups:</strong>${data.followUps.slice(0, 3).map(item => `<button type="button" class="followup-chip" data-followup="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div>`
              : "";
            return { reply: `${flavor}${data.reply}${followUps}`, error: null, sessionMemory: data.sessionMemory || null };
          }
        } else {
          lastError = `HTTP ${res.status}`;
          console.warn(`AI fallback attempt ${attempt} failed: ${lastError}`);
        }
      } catch (error) {
        lastError = error.name === "AbortError" ? "timeout" : error.message;
        console.warn(`AI fallback attempt ${attempt} error: ${lastError}`);
      }
    }

    return { reply: null, error: lastError || "no response" };
  }

  function wantsGenerativeAnswer() {
    const utilityPatterns = [
      /\b(github|linkedin|contact|email|phone)\b/,
      /\b(list|all)\b.*\b(projects?|codepens?)\b/,
      /\b(most stars)\b/
    ];

    if (utilityPatterns.some(pattern => pattern.test(query))) return false;

    const projectMention = projects.some(project => {
      const projectName = project.name.toLowerCase();
      return query.includes(projectName) || query.includes(projectName.replace(/\s+/g, ""));
    });
    const richProjectQuestion = /\b(tech stack|stack|built with|use|uses|tradeoff|improve|compare|job|role|recruiter|hire|candidate|matter|prove|show)\b/.test(query);
    if (projectMention && richProjectQuestion) return true;

    const conversationalPatterns = [
      /\b(why|how|what makes|would|could|should|explain|tell me|summarize|summary|background|experience|skills?|strengths?|fit|candidate|hire|good|ready|role|targeting|aws|cloud|ciris|ethical ai|ats|screen|screening|ramp|onboard|sdlc|api|crud|ticket|support|red flags?|downside|jargon)\b/,
      /\b(bradley|matera)\b/
    ];

    return conversationalPatterns.some(pattern => pattern.test(query));
  }

  if (wantsGenerativeAnswer()) {
    const aiResult = await askAIBackend();
    if (aiResult.reply) {
      return { reply: aiResult.reply, newTopic: "ai" };
    }
  }

  if ((query.includes("bradley") || query.includes("who is") || query.includes("tell me about") || query.includes("about you") || query.includes("about bradley")) && (query.includes("web dev") || query.includes("developer") || query.includes("software engineer") || query.includes("engineer") || query.includes("summarize") || query.includes("summary") || query.includes("background"))) {
    if (query.includes("full") || (lastQueryTopic === "summary" && (query.includes("more") || query.includes("full")))) {
      reply = summarizeBradleyAsWebDev(projects, codePens);
    } else if (query.includes("short") || query.includes("paragraph")) {
      reply = shortSummaryBradleyAsWebDev(projects, codePens);
    } else {
      reply = shortSummaryBradleyAsWebDev(projects, codePens) + " Would you like a more detailed summary? Just ask for the 'full summary'!";
    }
    newTopic = "summary";
    return { reply, newTopic };
  }

  if (query.includes("contact") || query.includes("email") || query.includes("phone") || query.includes("reach")) {
    reply = "You can reach Bradley Matera at bradmatera@gmail.com or (360) 970-0581. You can also connect on LinkedIn at https://www.linkedin.com/in/bradmatera or view his portfolio at https://bradleymatera.dev/.";
    newTopic = "contact";
    return { reply, newTopic };
  }

  if (query.includes("education") || query.includes("degree") || query.includes("full sail") || query.includes("school") || query.includes("gpa")) {
    reply = "Bradley earned a B.S. in Web Development from Full Sail University in Winter Park, Florida, graduating October 30, 2025 with a 3.64 GPA. Relevant coursework included Database Systems, Server-Side Languages, Cloud Application Development, and Web Application Integration.";
    newTopic = "education";
    return { reply, newTopic };
  }

  if (query.includes("certification") || query.includes("aws certified") || query.includes("certificate")) {
    reply = "Bradley holds AWS Certified Solutions Architect - Associate (SAA-C03, issued July 2025, expires July 2028) and AWS Certified AI Practitioner (AIF-C01, issued August 2025, expires August 2028). He also completed freeCodeCamp certificates in JavaScript Algorithms and Data Structures and Responsive Web Design.";
    newTopic = "certifications";
    return { reply, newTopic };
  }

  if (query.includes("location") || query.includes("where") || query.includes("based") || query.includes("relocation")) {
    reply = "Bradley is based in Davis, Illinois and is open to relocation.";
    newTopic = "location";
    return { reply, newTopic };
  }

  if (query.includes("github")) {
    reply = "Bradley Matera's GitHub profile is at https://github.com/BradleyMatera. You can explore his repositories there, including ProjectHub, Interactive Pokedex, CheeseMath, the Triangle Shader Lab, and more.";
    newTopic = "github";
    return { reply, newTopic };
  }

  if (query.includes("linkedin")) {
    reply = "Bradley Matera's LinkedIn profile is at https://www.linkedin.com/in/bradmatera. It highlights his transition into software engineering, AWS internship, freelance frontend work, education, and target roles.";
    newTopic = "linkedin";
    return { reply, newTopic };
  }

  const asksForSingleStrongestRole = /\b(strongest|best|most|pick one|one role|if you had to pick|had to pick|which one|which role)\b/.test(normalizedQuery)
    && /\b(role|job|position|fit|those|one)\b/.test(normalizedQuery);
  if (asksForSingleStrongestRole) {
    reply = "If I had to pick one strongest role for Bradley right now, I’d pick junior frontend/web developer. That is the cleanest fit because his strongest evidence is visible JavaScript/React/Next.js UI work, deployable portfolio projects, documentation, debugging, and enough backend/cloud exposure to be useful without overselling him as a production cloud engineer yet. Cloud support or software support are good adjacent fits, but frontend/web development is the strongest primary lane.";
    newTopic = "strongest-role";
    return { reply, newTopic };
  }

  if (query.includes("role") || query.includes("targeting") || query.includes("looking for") || query.includes("job")) {
    reply = "Bradley is targeting junior software engineering, junior web/frontend/backend development, cloud support engineering, software support, application support, and technical support roles. He is based in Davis, Illinois and open to relocation.";
    newTopic = "roles";
    return { reply, newTopic };
  }

  if (query.includes("strongest") || query.includes("technical background") || query.includes("skills") || query.includes("tech stack")) {
    reply = "Bradley's strongest technical background is in JavaScript, TypeScript, React, Next.js, Node.js, HTML, CSS, and SQL, plus AWS support training and project work with Lambda, DynamoDB, S3, and Amplify. He is also comfortable with debugging, documentation, GitHub, Docker, API integration, and AI-assisted development workflows.";
    newTopic = "skills";
    return { reply, newTopic };
  }

  if (query.includes("aws")) {
    reply = "Bradley completed an AWS Cloud Support Engineer internship and holds AWS Certified Solutions Architect - Associate and AWS Certified AI Practitioner certifications. The internship focused on guided support training, troubleshooting labs, networking concepts, and a serverless capstone project using Lambda, DynamoDB, S3, and Amplify. It did not involve live customer ticket work.";
    newTopic = "aws";
    return { reply, newTopic };
  }

  if (query.includes("project") || query === "projects") {
    const projectNames = projects.slice(0, 5).map(p => p.name).join(", ");
    reply = `Bradley's notable projects include ${projectNames}. You can see his full portfolio at https://bradleymatera.dev/.`;
    newTopic = "projects";
    return { reply, newTopic };
  }

  if (query.includes("experience") || query.includes("work history") || query.includes("background")) {
    reply = "Bradley's recent experience includes freelance junior frontend contributor at CIRIS Ethical AI and an AWS Cloud Support Engineer internship. He also has prior roles in case management, construction, and the U.S. Army.";
    newTopic = "experience";
    return { reply, newTopic };
  }

  if (query.includes("ciris") || query.includes("ethical ai")) {
    reply = "Bradley worked as a freelance junior frontend contributor at CIRIS Ethical AI from October 2024 to June 2025. He improved onboarding and setup documentation, added JWT token-verification logging, contributed small merged code updates and lint fixes, created Docker Compose config for local development, and documented larger improvements as GitHub Issues.";
    newTopic = "ciris";
    return { reply, newTopic };
  }

  for (const p of projects) {
    const projectNameLower = p.name.toLowerCase();
    if (query.includes(projectNameLower) || query.includes(projectNameLower.replace(" ", "")) || query.includes(projectNameLower.replace("_", ""))) {
      const githubData = await fetchGitHubRepoData(p.repo);
      reply = `${p.name}: ${p.desc} It’s hosted on ${p.platform}${p.url !== p.repo ? ` (${p.url})` : ""}. Source: ${p.repo} (Stars: ${githubData.stars}, Last Commit: ${githubData.lastCommit}). Tech used: ${p.tech.join(", ")}.`;
      newTopic = "project";
      break;
    }
  }

  for (const cp of codePens) {
    const codePenNameLower = cp.name.toLowerCase();
    if (query.includes(codePenNameLower) || query.includes(codePenNameLower.replace(" ", ""))) {
      reply = `${cp.name}: A CodePen project by Bradley Matera. Check it out here: ${cp.url}.`;
      newTopic = "codepen";
      break;
    }
  }

  const platforms = [...new Set(projects.map(p => p.platform.toLowerCase()))];
  for (const platform of platforms) {
    if (query.includes(platform)) {
      const platformProjects = projects.filter(p => p.platform.toLowerCase() === platform);
      reply = `Bradley Matera has ${platformProjects.length} project(s) on ${platform}: ${platformProjects.map(p => p.name).join(", ")}. Want details on a specific one?`;
      if (platform === "github" && query.includes("codepen")) {
        reply += ` He also has ${codePens.length} CodePen projects: ${codePens.map(cp => cp.name).join(", ")}.`;
      }
      newTopic = "platform";
      break;
    }
  }

  const techs = [...new Set(projects.flatMap(p => p.tech.map(t => t.toLowerCase())))];
  for (const tech of techs) {
    if (query.includes(tech)) {
      const techProjects = projects.filter(p => p.tech.map(t => t.toLowerCase()).includes(tech));
      reply = `Bradley Matera used ${tech} in ${techProjects.length} project(s): ${techProjects.map(p => p.name).join(", ")}. Want details on a specific one?`;
      newTopic = "tech";
      break;
    }
  }

  if (query.includes("list") || query.includes("all")) {
    if (query.includes("codepen")) {
      reply = `Here are Bradley Matera's CodePen projects: ${codePens.map(cp => cp.name).join(", ")}. Ask about a specific one for more details!`;
      newTopic = "codepen";
    } else {
      reply = `Here are Bradley Matera's projects: ${projects.map(p => p.name).join(", ")}. He also has ${codePens.length} CodePen projects—ask about those too!`;
      newTopic = "projects";
    }
  }

  if (query.includes("compare")) {
    const projectNames = projects.map(p => p.name.toLowerCase());
    const matches = projectNames.filter(name => query.includes(name));
    if (matches.length >= 2) {
      const p1 = projects.find(p => p.name.toLowerCase() === matches[0]);
      const p2 = projects.find(p => p.name.toLowerCase() === matches[1]);
      reply = `Comparing ${p1.name} and ${p2.name}:\n- ${p1.name} uses ${p1.tech.join(", ")} and is on ${p1.platform}.\n- ${p2.name} uses ${p2.tech.join(", ")} and is on ${p2.platform}.\nCommon tech: ${p1.tech.filter(t => p2.tech.includes(t)).join(", ") || "None"}.`;
      newTopic = "compare";
    }
  }

  if (query.includes("most stars")) {
    const projectData = await fetchAllGitHubData(projects);
    const sortedProjects = projectData.sort((a, b) => b.githubData.stars - a.githubData.stars);
    const topProject = sortedProjects[0];
    reply = `The project with the most stars is ${topProject.name} with ${topProject.githubData.stars} stars. It’s hosted on ${topProject.platform}${topProject.url !== topProject.repo ? ` (${topProject.url})` : ""}. Source: ${topProject.repo}.`;
    newTopic = "stars";
  }

  // If no local intent matched, try the guarded recruiter chat API.
  // The free GCP VM can be slow; we never let the UI hang forever.
  if (reply.includes("I don’t know")) {
    const localHelp = "I’m here to help with Bradley Matera’s work as a junior software engineer. Try asking about ProjectHub, the AWS serverless workflow, CIRIS Ethical AI, his GitHub or LinkedIn, target roles, or strongest technical skills.";
    const aiResult = await askAIBackend();

    if (aiResult.reply) {
      reply = aiResult.reply;
    } else {
      reply = `${localHelp}<br><br>I can still help from Bradley's verified profile details — ask about his projects, cloud work, support background, target roles, or contact links.`;
    }
    newTopic = "unrelated";
  }

  return { reply, newTopic };
}function setupChatUI(projects, codePens, suggestions, handleQuery, fetchAllGitHubData) {
  let lastQueryTopic = null;
  let lastRequestTime = 0;
  let isRequestInFlight = false;
  let lastSubmittedQuery = "";
  let lastSubmittedAt = 0;
  let lastBotReplyText = "";
  let conversationContext = [];
  let turnCount = 0;

  const requestInterval = 900;
  const avatarUrl = window.__PROJECTHUB_AVATAR__ || (window.location.protocol === "file:" ? "bot-avatar.png" : "https://bradleymatera.github.io/ProjectHub/bot-avatar.png");
  const sessionStorageKey = "projecthub-chat-session-id";
  const nameStorageKey = "projecthub-chat-user-name";
  const settingsStorageKey = "projecthub-chat-settings";
  const defaultSettings = {
    enterToSend: true,
    compactMode: false
  };
  const isMobile = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
  const FLAVOR_ENABLED = true;
  const MEMORY_ENABLED = true;

  function createSessionId() {
    return `ph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  let sessionId = (() => {
    try {
      const existing = window.sessionStorage.getItem(sessionStorageKey);
      if (existing) return existing;
      const generated = createSessionId();
      window.sessionStorage.setItem(sessionStorageKey, generated);
      return generated;
    } catch (error) {
      return createSessionId();
    }
  })();

  let visitorName = (() => {
    try {
      return window.sessionStorage.getItem(nameStorageKey) || "";
    } catch (error) {
      return "";
    }
  })();

  let chatSettings = (() => {
    try {
      return { ...defaultSettings, ...JSON.parse(window.localStorage.getItem(settingsStorageKey) || "{}") };
    } catch (error) {
      return { ...defaultSettings };
    }
  })();

  function chatApiUrl() {
    return window.__PROJECTHUB_CHAT_API__
      || (/(^|\.)bradleymatera\.dev$/.test(window.location.hostname) ? "/.netlify/functions/recruiter-chat" : "https://projecthub-chat.bradleymatera.dev/api/chat");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
  }

  function linkifyHtml(html) {
    return html.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, (match, prefix, url) => {
      const trailing = /[.),!?]$/.test(url) ? url.slice(-1) : "";
      const cleanUrl = trailing ? url.slice(0, -1) : url;
      return `${prefix}<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trailing}`;
    });
  }

  function normalizeForCompare(value) {
    return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  const existingStyle = document.getElementById("projecthub-chat-styles");
  if (existingStyle) existingStyle.remove();

  const style = document.createElement("style");
  style.id = "projecthub-chat-styles";
  style.textContent = `
    :root {
      --ph-bg: #0d1412;
      --ph-panel: rgba(18, 29, 26, 0.94);
      --ph-panel-strong: #14231f;
      --ph-line: rgba(212, 230, 218, 0.16);
      --ph-text: #edf7ef;
      --ph-muted: #9fb4aa;
      --ph-accent: #39d98a;
      --ph-accent-2: #70b7ff;
      --ph-user: #dceee5;
      --ph-user-text: #10201a;
      --ph-shadow: 0 26px 80px rgba(0, 0, 0, 0.38), 0 8px 22px rgba(0, 0, 0, 0.24);
    }

    #bradley-chat {
      position: fixed;
      right: 22px;
      bottom: 22px;
      width: min(440px, calc(100vw - 28px));
      height: min(680px, calc(100vh - 34px));
      z-index: 2147483000;
      display: grid;
      grid-template-rows: auto 1fr auto;
      overflow: hidden;
      color: var(--ph-text);
      font-family: "Aptos", "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.45;
      background:
        radial-gradient(circle at 20% 0%, rgba(57, 217, 138, 0.18), transparent 34%),
        radial-gradient(circle at 95% 12%, rgba(112, 183, 255, 0.18), transparent 32%),
        linear-gradient(160deg, rgba(13, 20, 18, 0.98), rgba(20, 35, 31, 0.96));
      border: 1px solid var(--ph-line);
      border-radius: 18px;
      box-shadow: var(--ph-shadow);
      backdrop-filter: blur(16px);
      transform-origin: bottom right;
      animation: projecthub-enter 440ms cubic-bezier(.2,.85,.2,1) both;
    }

    #bradley-chat.projecthub-minimized {
      width: min(340px, calc(100vw - 28px));
      height: 84px;
      grid-template-rows: auto;
    }

    /* When both compact and minimized are active, minimize must win */
    #bradley-chat.projecthub-compact.projecthub-minimized {
      width: min(340px, calc(100vw - 28px));
      height: 84px;
    }

    #bradley-chat.projecthub-minimized .projecthub-body,
    #bradley-chat.projecthub-minimized .projecthub-composer,
    #bradley-chat.projecthub-minimized .projecthub-settings-panel {
      display: none;
    }

    #bradley-chat.projecthub-compact {
      width: min(390px, calc(100vw - 28px));
      height: min(560px, calc(100vh - 34px));
      font-size: 14px;
    }

    #bradley-chat.projecthub-compact .projecthub-header {
      padding: 11px;
    }

    #bradley-chat.projecthub-compact #chat-output {
      padding: 13px 11px 9px;
    }

    .projecthub-header {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 12px;
      padding: 14px;
      background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02));
      border-bottom: 1px solid var(--ph-line);
    }

    .projecthub-avatar-wrap {
      position: relative;
    }

    .projecthub-avatar {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      object-fit: cover;
      display: block;
      border: 1px solid rgba(255,255,255,0.22);
      box-shadow: 0 10px 26px rgba(0,0,0,0.26);
      background: #20352e;
    }

    .projecthub-status-dot {
      position: absolute;
      right: -2px;
      bottom: -2px;
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: var(--ph-accent);
      border: 2px solid #10201a;
      box-shadow: 0 0 0 4px rgba(57, 217, 138, 0.14);
    }

    .projecthub-title-block {
      min-width: 0;
      overflow: hidden;
    }

    .projecthub-kicker {
      color: var(--ph-accent);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
      margin-bottom: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .projecthub-title {
      font-size: 16px;
      font-weight: 800;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .projecthub-subtitle-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .projecthub-subtitle {
      color: var(--ph-muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .projecthub-minimized .projecthub-subtitle-row {
      display: none;
    }

    .projecthub-free-badge {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: #07100c;
      background: linear-gradient(135deg, var(--ph-accent), #a8f0c7);
      box-shadow: 0 0 0 3px rgba(57, 217, 138, 0.14);
      cursor: help;
      animation: free-pulse 2.6s ease-in-out infinite;
    }

    .projecthub-free-badge::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: #059669;
      box-shadow: 0 0 8px rgba(5, 150, 105, 0.8);
    }

    @keyframes free-pulse {
      0%, 100% { box-shadow: 0 0 0 3px rgba(57, 217, 138, 0.14); transform: scale(1); }
      50% { box-shadow: 0 0 0 6px rgba(57, 217, 138, 0.08); transform: scale(1.03); }
    }

    .projecthub-minimized .projecthub-title {
      font-size: 15px;
    }

    .projecthub-minimized .projecthub-actions {
      gap: 5px;
    }

    .projecthub-icon-button {
      width: 36px;
      height: 36px;
      border: 1px solid var(--ph-line);
      border-radius: 10px;
      color: var(--ph-text);
      background: rgba(255,255,255,0.06);
      cursor: pointer;
      display: grid;
      place-items: center;
      font-size: 20px;
      transition: transform 160ms ease, background 160ms ease, border-color 160ms ease;
    }

    .projecthub-icon-button:hover,
    .projecthub-icon-button:focus {
      transform: translateY(-1px);
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.28);
      outline: none;
    }

    .projecthub-actions {
      display: flex;
      gap: 7px;
    }

    .projecthub-settings-panel {
      position: absolute;
      top: 74px;
      right: 12px;
      left: 12px;
      z-index: 4;
      display: none;
      padding: 12px;
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 14px;
      background: rgba(13, 20, 18, 0.97);
      box-shadow: 0 18px 48px rgba(0,0,0,0.32);
      backdrop-filter: blur(14px);
      animation: message-in 180ms ease both;
    }

    #bradley-chat.projecthub-settings-open .projecthub-settings-panel {
      display: block;
    }

    .settings-head,
    .settings-actions {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      justify-content: space-between;
    }

    .settings-title {
      color: #fff;
      font-weight: 850;
      font-size: 14px;
    }

    .settings-subtitle {
      color: var(--ph-muted);
      font-size: 12px;
      margin-top: 2px;
    }

    .settings-grid {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }

    .setting-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 9px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      background: rgba(255,255,255,0.05);
    }

    .setting-row strong {
      display: block;
      color: var(--ph-text);
      font-size: 13px;
      line-height: 1.2;
    }

    .setting-row span span {
      display: block;
      color: var(--ph-muted);
      font-size: 11px;
      margin-top: 2px;
    }

    .setting-toggle {
      appearance: none;
      width: 42px;
      height: 24px;
      border-radius: 999px;
      background: rgba(255,255,255,0.16);
      border: 1px solid rgba(255,255,255,0.18);
      cursor: pointer;
      position: relative;
      flex: 0 0 auto;
      transition: background 160ms ease, border-color 160ms ease;
    }

    .setting-toggle::after {
      content: "";
      position: absolute;
      width: 18px;
      height: 18px;
      left: 2px;
      top: 2px;
      border-radius: 999px;
      background: #fff;
      transition: transform 160ms ease;
    }

    .setting-toggle:checked {
      background: rgba(57, 217, 138, 0.45);
      border-color: rgba(57, 217, 138, 0.65);
    }

    .setting-toggle:checked::after {
      transform: translateX(18px);
    }

    .settings-actions {
      margin-top: 10px;
      justify-content: flex-start;
    }

    .settings-action-button {
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 11px;
      color: var(--ph-text);
      background: rgba(255,255,255,0.08);
      padding: 8px 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }

    .settings-action-button.danger {
      color: #ffe7e7;
      border-color: rgba(255, 130, 130, 0.28);
      background: rgba(255, 130, 130, 0.11);
    }

    .projecthub-body {
      overflow: hidden;
      display: grid;
      grid-template-rows: 1fr auto;
      min-height: 0;
    }

    #chat-output {
      overflow-y: auto;
      padding: 18px 14px 12px;
      scroll-behavior: smooth;
    }

    #chat-output::-webkit-scrollbar {
      width: 10px;
    }

    #chat-output::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.16);
      border-radius: 999px;
      border: 3px solid transparent;
      background-clip: padding-box;
    }

    .message-row {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 9px;
      margin-bottom: 13px;
      animation: message-in 260ms cubic-bezier(.2,.8,.2,1) both;
    }

    .message-row.user-row {
      grid-template-columns: minmax(0, 1fr) 34px;
    }

    .message-avatar,
    .user-initial {
      width: 34px;
      height: 34px;
      border-radius: 11px;
      object-fit: cover;
      border: 1px solid rgba(255,255,255,0.16);
      background: #20352e;
    }

    .user-initial {
      display: grid;
      place-items: center;
      color: #10201a;
      background: linear-gradient(135deg, #dceee5, #9fe7c1);
      font-weight: 900;
      font-size: 13px;
      grid-column: 2;
    }

    .user-initial::before {
      content: "You";
    }

    .message {
      min-width: 0;
      padding: 12px 13px;
      border: 1px solid var(--ph-line);
      border-radius: 15px;
      word-wrap: break-word;
      box-shadow: 0 12px 24px rgba(0,0,0,0.14);
    }

    .bot-message {
      background: rgba(255,255,255,0.07);
      border-top-left-radius: 5px;
    }

    .user-message {
      grid-column: 1;
      grid-row: 1;
      color: var(--ph-user-text);
      background: linear-gradient(135deg, #edf8f1, #b5edcb);
      border-color: rgba(255,255,255,0.34);
      border-top-right-radius: 5px;
    }

    .message-label {
      display: block;
      color: var(--ph-muted);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .03em;
      text-transform: uppercase;
      margin-bottom: 5px;
    }

    .user-message .message-label {
      color: rgba(16, 32, 26, 0.62);
    }

    .message a {
      color: #96d9ff;
      text-decoration: none;
      border-bottom: 1px solid rgba(150, 217, 255, 0.42);
    }

    .message a:hover,
    .message a:focus {
      color: #c5ecff;
      border-bottom-color: currentColor;
      outline: none;
    }

    .ai-flavor {
      display: inline-flex;
      width: fit-content;
      margin: 0 0 8px;
      padding: 4px 8px;
      border: 1px solid rgba(112, 183, 255, 0.26);
      border-radius: 999px;
      color: #c5ecff;
      background: rgba(112, 183, 255, 0.11);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .02em;
    }

    .ai-flavor::before {
      content: "AI note";
      color: rgba(237, 247, 239, 0.56);
      margin-right: 6px;
      font-weight: 700;
    }

    .timestamp {
      color: var(--ph-muted);
      font-size: 11px;
      margin-top: 8px;
    }

    .user-message .timestamp {
      color: rgba(16, 32, 26, 0.58);
    }

    .projecthub-suggestions {
      padding: 0 14px 12px;
      display: flex;
      gap: 7px;
      flex-wrap: wrap;
    }

    @media (max-width: 640px) {
      .suggestion-chip {
        white-space: normal;
        text-align: left;
      }
    }

    @media (min-width: 641px) {
      .projecthub-suggestions {
        flex-wrap: nowrap;
        overflow-x: auto;
        scrollbar-width: thin;
      }
      .projecthub-suggestions::-webkit-scrollbar {
        height: 6px;
      }
      .projecthub-suggestions::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.2);
        border-radius: 3px;
      }
    }

    .suggestion-chip,
    .followup-chip {
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      color: var(--ph-text);
      padding: 7px 10px;
      font: inherit;
      font-size: 12px;
      line-height: 1.2;
      cursor: pointer;
      white-space: nowrap;
      transition: transform 160ms ease, background 160ms ease, border-color 160ms ease;
    }

    .suggestion-chip:hover,
    .suggestion-chip:focus,
    .followup-chip:hover,
    .followup-chip:focus {
      transform: translateY(-1px);
      background: rgba(57, 217, 138, 0.14);
      border-color: rgba(57, 217, 138, 0.36);
      outline: none;
    }

    .followup-list {
      margin-top: 11px;
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
    }

    .followup-list strong {
      width: 100%;
      color: #d9f7e6;
      font-size: 12px;
      margin-bottom: 1px;
    }

    .followup-chip {
      white-space: normal;
      text-align: left;
      background: rgba(57, 217, 138, 0.12);
      border-color: rgba(57, 217, 138, 0.26);
    }

    .projecthub-composer {
      padding: 12px 14px 14px;
      border-top: 1px solid var(--ph-line);
      background: rgba(7, 12, 10, 0.36);
    }

    .composer-shell {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: end;
      gap: 9px;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 16px;
      padding: 8px;
      background: rgba(255,255,255,0.08);
      transition: border-color 160ms ease, box-shadow 160ms ease;
    }

    .composer-shell:focus-within {
      border-color: rgba(57, 217, 138, 0.46);
      box-shadow: 0 0 0 4px rgba(57, 217, 138, 0.10);
    }

    #chat-input {
      width: 100%;
      min-height: 42px;
      max-height: 130px;
      resize: none;
      overflow-y: auto;
      border: 0;
      outline: 0;
      color: var(--ph-text);
      background: transparent;
      font: inherit;
      line-height: 1.35;
      padding: 10px 4px 8px 6px;
    }

    #chat-input::placeholder {
      color: rgba(237, 247, 239, 0.52);
    }

    .send-button {
      width: 44px;
      height: 44px;
      border: 0;
      border-radius: 13px;
      color: #07100c;
      background: linear-gradient(135deg, var(--ph-accent), #a8f0c7);
      display: grid;
      place-items: center;
      cursor: pointer;
      box-shadow: 0 12px 24px rgba(57, 217, 138, 0.18);
      transition: transform 160ms ease, opacity 160ms ease, filter 160ms ease;
    }

    .send-button:hover,
    .send-button:focus {
      transform: translateY(-1px);
      filter: brightness(1.04);
      outline: none;
    }

    .send-button:disabled {
      cursor: wait;
      opacity: 0.58;
      transform: none;
    }

    .typing-bubble {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .typing-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--ph-accent);
      animation: typing-dot 900ms ease-in-out infinite;
    }

    .typing-dot:nth-child(2) { animation-delay: 120ms; }
    .typing-dot:nth-child(3) { animation-delay: 240ms; }
    .thinking-tip {
      display: block;
      margin-top: 6px;
      font-size: 11px;
      opacity: 0.65;
      font-style: italic;
    }

    @keyframes typing-dot {
      0%, 80%, 100% { transform: translateY(0); opacity: .45; }
      35% { transform: translateY(-4px); opacity: 1; }
    }

    @keyframes projecthub-enter {
      from { opacity: 0; transform: translateY(18px) scale(.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes message-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 560px) {
      #bradley-chat {
        right: 10px;
        left: 10px;
        bottom: 10px;
        width: auto;
        height: min(680px, calc(100vh - 20px));
        border-radius: 16px;
      }

      /* On mobile when minimized, show as a small floating pill instead of a full-width ghost panel */
      #bradley-chat.projecthub-minimized {
        left: auto;
        right: 14px;
        bottom: 14px;
        width: min(320px, calc(100vw - 28px));
        height: 64px;
        border-radius: 32px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      }

      /* Compact + minimized must still collapse to pill on mobile */
      #bradley-chat.projecthub-compact.projecthub-minimized {
        width: min(320px, calc(100vw - 28px));
        height: 64px;
      }

      .projecthub-title {
        font-size: 15px;
      }

      .projecthub-subtitle {
        max-width: 210px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #bradley-chat,
      .message-row,
      .typing-dot,
      .suggestion-chip,
      .followup-chip,
      .send-button,
      .projecthub-icon-button {
        animation: none !important;
        transition: none !important;
      }
    }
  `;
  document.head.appendChild(style);

  const chatDiv = document.createElement("section");
  chatDiv.id = "bradley-chat";
  chatDiv.setAttribute("aria-label", "Scout chat");

  chatDiv.innerHTML = `
    <header class="projecthub-header">
      <div class="projecthub-avatar-wrap">
        <img class="projecthub-avatar" src="${avatarUrl}" alt="Scout avatar">
        <span class="projecthub-status-dot" aria-hidden="true"></span>
      </div>
      <div class="projecthub-title-block">
        <div class="projecthub-kicker">Bradley Matera · Recruiter assistant</div>
        <div class="projecthub-title">Scout</div>
        <div class="projecthub-subtitle-row">
          <span class="projecthub-subtitle">Ask me about Bradley's projects, skills, fit, or contact info</span>
          <span class="projecthub-free-badge" title="Scout runs on free GitHub Pages, a GCP free-tier VM, free LLM providers, and a local Ollama fallback — no paid AI required.">100% free</span>
        </div>
      </div>
      <div class="projecthub-actions">
        <button class="projecthub-icon-button projecthub-settings-button" type="button" aria-label="Open chat settings" title="Chat settings">⚙</button>
        <button class="projecthub-icon-button projecthub-minimize-button" type="button" aria-label="Minimize chat" title="Minimize chat">−</button>
      </div>
    </header>
    <div class="projecthub-settings-panel" role="dialog" aria-label="ProjectHub chat settings">
      <div class="settings-head">
        <div>
          <div class="settings-title">Chat Settings</div>
          <div class="settings-subtitle">Input behavior and session controls.</div>
        </div>
        <button class="projecthub-icon-button projecthub-settings-close" type="button" aria-label="Close settings" title="Close settings">×</button>
      </div>
      <div class="settings-grid">
        <label class="setting-row"><span><strong>Enter to send</strong><span>Shift+Enter still adds a new line.</span></span><input class="setting-toggle" type="checkbox" data-setting="enterToSend"></label>
      </div>
      <div class="settings-actions">
        <button class="settings-action-button danger clear-memory-button" type="button">Clear memory</button>
        <button class="settings-action-button rename-button" type="button">Change name</button>
      </div>
    </div>
    <div class="projecthub-body">
      <div id="chat-output" aria-live="polite"></div>
      <div class="projecthub-suggestions" aria-label="Suggested questions"></div>
    </div>
    <form class="projecthub-composer">
      <div class="composer-shell">
        <textarea id="chat-input" rows="1" placeholder="Ask Scout about Bradley's work, projects, skills, or roles..."></textarea>
        <button class="send-button" type="submit" aria-label="Send message" title="Send message">
          <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="m22 2-7 20-4-9-9-4Z"></path>
            <path d="M22 2 11 13"></path>
          </svg>
        </button>
      </div>
    </form>
  `;

  document.body.appendChild(chatDiv);

  const chatOutput = chatDiv.querySelector("#chat-output");
  const suggestionBar = chatDiv.querySelector(".projecthub-suggestions");
  const chatInput = chatDiv.querySelector("#chat-input");
  const sendButton = chatDiv.querySelector(".send-button");
  const settingsBtn = chatDiv.querySelector(".projecthub-settings-button");
  const settingsCloseBtn = chatDiv.querySelector(".projecthub-settings-close");
  const minimizeBtn = chatDiv.querySelector(".projecthub-minimize-button");
  const clearMemoryBtn = chatDiv.querySelector(".clear-memory-button");
  const renameBtn = chatDiv.querySelector(".rename-button");
  const composer = chatDiv.querySelector(".projecthub-composer");

  function saveSettings() {
    try {
      window.localStorage.setItem(settingsStorageKey, JSON.stringify(chatSettings));
    } catch (error) {}
    const compact = Boolean(chatSettings.compactMode) || isMobile;
    chatDiv.classList.toggle("projecthub-compact", compact);
    chatDiv.querySelectorAll(".setting-toggle").forEach(toggle => {
      toggle.checked = Boolean(chatSettings[toggle.dataset.setting]);
    });
  }

  function saveVisitorName(name) {
    visitorName = name;
    try {
      if (name) window.sessionStorage.setItem(nameStorageKey, name);
      else window.sessionStorage.removeItem(nameStorageKey);
    } catch (error) {}
  }

  function extractVisitorName(value) {
    const cleaned = String(value || "").trim();
    const match = cleaned.match(/(?:my name is|i am|i'm|im|this is|call me)\s+([a-z][a-z .'-]{1,32})/i);
    const rawName = (match ? match[1] : cleaned).split(/[,.!?]/)[0].trim();
    if (!rawName || rawName.length > 32 || /\b(what|why|how|tell|about|project|bradley|aws|contact|github|linkedin)\b/i.test(rawName)) return "";
    return rawName.split(/\s+/).slice(0, 2).map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
  }

  async function clearRemoteMemory() {
    try {
      await fetch(chatApiUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear", sessionId })
      });
    } catch (error) {
      console.warn("ProjectHub remote memory clear skipped:", error.message);
    }
  }

  async function resetChatMemory() {
    await clearRemoteMemory();
    conversationContext = [];
    saveVisitorName("");
    lastBotReplyText = "";
    lastSubmittedQuery = "";
    lastSubmittedAt = 0;
    turnCount = 0;
    sessionId = createSessionId();
    try {
      window.sessionStorage.setItem(sessionStorageKey, sessionId);
    } catch (error) {}
    chatOutput.innerHTML = "";
    appendMessage("bot", "Scout", "Memory cleared. What should I call you for this new session?");
  }

  function appendMessage(type, label, html, options = {}) {
    const row = document.createElement("div");
    row.className = `message-row ${type}-row`;

    const avatar = type === "bot"
      ? `<img class="message-avatar" src="${avatarUrl}" alt="ProjectHub bot">`
      : `<div class="user-initial" aria-hidden="true"></div>`;

    row.innerHTML = `
      ${avatar}
      <div class="message ${type}-message">
        <span class="message-label">${label}</span>
        <div class="message-content">${linkifyHtml(html)}</div>
        <div class="timestamp">${new Date().toLocaleTimeString()}</div>
      </div>
    `;

    if (options.statusId) row.id = options.statusId;
    chatOutput.appendChild(row);
    chatOutput.scrollTop = chatOutput.scrollHeight;
    return row;
  }

  // Reveal HTML reply word-by-word for a consistent, human-like typing effect.
  // Tags (including those with spaces in attributes) are emitted whole;
  // text tokens are emitted one whitespace-delimited piece at a time.
  function typeHtml(contentEl, html, wordDelayMs = 32) {
    return new Promise(resolve => {
      const tokens = [];
      let lastIndex = 0;
      const tagRe = /<[^>]+>/g;
      let m;
      while ((m = tagRe.exec(html)) !== null) {
        if (m.index > lastIndex) {
          const text = html.slice(lastIndex, m.index);
          tokens.push(...text.split(/(\s+)/).filter(Boolean));
        }
        tokens.push(m[0]);
        lastIndex = m.index + m[0].length;
      }
      if (lastIndex < html.length) {
        const text = html.slice(lastIndex);
        tokens.push(...text.split(/(\s+)/).filter(Boolean));
      }

      let i = 0;
      let buffer = '';
      function next() {
        if (i >= tokens.length) {
          contentEl.innerHTML = buffer;
          resolve();
          return;
        }
        const token = tokens[i++];
        if (token.startsWith('<')) {
          buffer += token;
        } else {
          // Escape lone ampersands so partial HTML stays valid, but don't double-escape entities
          buffer += token.replace(/&(?![a-zA-Z]+;|#[0-9]+;)/g, '&amp;');
        }
        contentEl.innerHTML = buffer;
        chatOutput.scrollTop = chatOutput.scrollHeight;
        setTimeout(next, wordDelayMs);
      }
      next();
    });
  }

  function appendTypingStatus() {
    const row = appendMessage("bot", "Scout", `<span class="typing-bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></span><span class="thinking-tip"></span>`, { statusId: "thinking-status" });
    const tips = [
      "Reading Bradley's project data…",
      "Checking his AWS background…",
      "Writing an honest answer…",
      "Double-checking the facts…",
      "Picking the next available free provider…"
    ];
    let tipIndex = 0;
    const tipEl = row.querySelector(".thinking-tip");
    if (tipEl) {
      const timer = setInterval(() => {
        if (!document.body.contains(row)) { clearInterval(timer); return; }
        tipEl.textContent = tips[tipIndex % tips.length];
        tipIndex++;
      }, 3000);
      row.dataset.tipTimer = String(timer);
    }
    return row;
  }

  function setBusy(isBusy) {
    isRequestInFlight = isBusy;
    sendButton.disabled = isBusy;
    chatInput.disabled = isBusy;
    chatDiv.classList.toggle("projecthub-busy", isBusy);
  }

  function resizeInput() {
    chatInput.style.height = "auto";
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 130)}px`;
  }

  function setInputValue(value) {
    chatInput.value = value;
    resizeInput();
    chatInput.focus();
  }

  function rememberTurn(role, content) {
    conversationContext.push({ role, content: normalizeForCompare(content).slice(0, 420), at: Date.now() });
    conversationContext = conversationContext.slice(-8);
  }

  function renderSuggestions() {
    const prioritySuggestions = [
      "Why is Bradley a good junior candidate?",
      "Tell me about ProjectHub",
      "What AWS experience does Bradley have?",
      "What concerns should a recruiter know?",
      "How can I contact Bradley?",
      "How is this chat free?",
      "How do daily caps and cooldowns work?"
    ];
    const allSuggestions = [...prioritySuggestions, ...suggestions.filter(item => !prioritySuggestions.includes(item))].slice(0, 12);
    suggestionBar.innerHTML = allSuggestions.map(item => `<button class="suggestion-chip" type="button" data-suggestion="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("");
  }

  minimizeBtn.addEventListener("click", () => {
    const isMinimized = chatDiv.classList.toggle("projecthub-minimized");
    minimizeBtn.innerHTML = isMinimized ? "+" : "−";
    minimizeBtn.setAttribute("aria-label", isMinimized ? "Open chat" : "Minimize chat");
    minimizeBtn.title = isMinimized ? "Open chat" : "Minimize chat";
  });

  settingsBtn.addEventListener("click", () => {
    chatDiv.classList.toggle("projecthub-settings-open");
  });

  settingsCloseBtn.addEventListener("click", () => {
    chatDiv.classList.remove("projecthub-settings-open");
  });

  chatDiv.querySelectorAll(".setting-toggle").forEach(toggle => {
    toggle.addEventListener("change", () => {
      chatSettings = { ...chatSettings, [toggle.dataset.setting]: toggle.checked };
      saveSettings();
    });
  });

  clearMemoryBtn.addEventListener("click", () => {
    resetChatMemory();
    chatDiv.classList.remove("projecthub-settings-open");
  });

  renameBtn.addEventListener("click", () => {
    saveVisitorName("");
    appendMessage("bot", "Scout", "No problem. What should I call you for this session?");
    chatDiv.classList.remove("projecthub-settings-open");
    chatInput.focus();
  });

  chatInput.addEventListener("input", resizeInput);

  suggestionBar.addEventListener("click", event => {
    const suggestionButton = event.target.closest(".suggestion-chip");
    if (!suggestionButton || isRequestInFlight) return;
    setInputValue(suggestionButton.dataset.suggestion || suggestionButton.textContent || "");
    submitChat();
  });

  chatOutput.addEventListener("click", event => {
    const followupButton = event.target.closest(".followup-chip");
    if (!followupButton || isRequestInFlight) return;
    setInputValue(followupButton.dataset.followup || followupButton.textContent || "");
    submitChat();
  });

  const MIN_TYPING_MS = 700;
  const WORD_DELAY_MS = 32;

  function clearTypingStatus(row) {
    const timer = row && row.dataset ? row.dataset.tipTimer : null;
    if (timer) clearInterval(Number(timer));
    if (row && row.parentNode) row.remove();
  }

  async function showBotReply(statusRow, html, typingStart) {
    const elapsed = Date.now() - typingStart;
    const wait = Math.max(0, MIN_TYPING_MS - elapsed);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const timer = statusRow && statusRow.dataset ? statusRow.dataset.tipTimer : null;
    if (timer) clearInterval(Number(timer));
    statusRow.removeAttribute("id");
    const contentEl = statusRow.querySelector(".message-content");
    if (contentEl) contentEl.innerHTML = "";
    await typeHtml(contentEl || statusRow, html, WORD_DELAY_MS);
    return statusRow;
  }

  async function typeNewBotMessage(html) {
    const row = appendMessage("bot", "Scout", "");
    await typeHtml(row.querySelector(".message-content"), html, WORD_DELAY_MS);
    return row;
  }

  const submitChat = async () => {
    const now = Date.now();
    if (now - lastRequestTime < requestInterval) {
      chatInput.placeholder = "One moment...";
      return;
    }

    const userQuery = chatInput.value.trim();
    if (!userQuery) return;

    const normalizedQuery = userQuery.toLowerCase().replace(/\s+/g, " ");
    if (isRequestInFlight) {
      chatInput.placeholder = "Still working on that answer...";
      return;
    }

    if (normalizedQuery === lastSubmittedQuery && now - lastSubmittedAt < 20000) {
      chatInput.placeholder = "Try a follow-up detail or rephrase the question...";
      return;
    }

    lastRequestTime = now;
    lastSubmittedQuery = normalizedQuery;
    lastSubmittedAt = now;
    setBusy(true);

    appendMessage("user", "You", escapeHtml(userQuery));

    if (!visitorName) {
      const possibleName = extractVisitorName(userQuery);
      if (possibleName) {
        saveVisitorName(possibleName);
        const greetingHtml = `Nice to meet you, ${escapeHtml(visitorName)}. I’m Scout, Bradley’s assistant. Ask me about his projects, AWS background, role fit, honest gaps, or contact details.`;
        await typeNewBotMessage(greetingHtml);
        rememberTurn("user", userQuery);
        rememberTurn("assistant", `Visitor name captured as ${visitorName}`);
        turnCount += 1;
        chatInput.value = "";
        resizeInput();
        setBusy(false);
        chatInput.focus();
        return;
      }
    }

    const statusRow = appendTypingStatus();
    const typingStart = Date.now();

    try {
      const { reply, newTopic } = await handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData, {
        sessionId,
        context: MEMORY_ENABLED ? conversationContext : [],
        options: {
          memoryEnabled: MEMORY_ENABLED,
          flavorEnabled: FLAVOR_ENABLED,
          visitorName
        }
      });
      lastQueryTopic = newTopic;
      const finalReply = reply;
      const plainReply = normalizeForCompare(reply);

      const isLocalDuplicate = newTopic !== "ai" && plainReply && plainReply === lastBotReplyText;
      if (isLocalDuplicate) {
        const label = visitorName ? `${escapeHtml(visitorName)}, ` : "";
        const dupHtml = `${label}I already covered that locally. The useful part was: “${escapeHtml(plainReply.slice(0, 220))}${plainReply.length > 220 ? "..." : ""}” Ask for proof, tradeoffs, risks, or interview wording and I’ll take a new angle.`;
        await showBotReply(statusRow, dupHtml, typingStart);
        chatInput.value = "";
        resizeInput();
        return;
      }

      await showBotReply(statusRow, linkifyHtml(finalReply), typingStart);
      rememberTurn("user", userQuery);
      rememberTurn("assistant", finalReply);
      lastBotReplyText = plainReply;
      turnCount += 1;
      chatInput.value = "";
      resizeInput();
    } catch (error) {
      console.error("ProjectHub chat error:", error);
      if (statusRow) await showBotReply(statusRow, "I can still help from Bradley’s verified profile details. Try asking about projects, AWS experience, CIRIS, target roles, skills, or contact links.", typingStart);
    } finally {
      setBusy(false);
      chatInput.placeholder = "Ask Scout about Bradley's work, projects, skills, or roles...";
      chatInput.focus();
    }
  };

  composer.addEventListener("submit", event => {
    event.preventDefault();
    submitChat();
  });

  chatInput.addEventListener("keydown", event => {
    if (chatSettings.enterToSend && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitChat();
    }
  });

  saveSettings();
  window.matchMedia('(max-width: 640px)').addEventListener('change', e => {
    chatDiv.classList.toggle("projecthub-compact", e.matches || Boolean(chatSettings.compactMode));
  });
  renderSuggestions();
  const freeNote = `<br><br><span style="display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;background:rgba(57,217,138,0.12);border:1px solid rgba(57,217,138,0.28);color:#b8f5d3;font-size:12px;">🟢 I run entirely on free tiers. If a provider hits its daily cap or rate limit, I automatically switch to another free provider or local Ollama on the GCP VM.</span>`;
  const welcomeHtml = visitorName
    ? `Welcome back, ${escapeHtml(visitorName)}. I’m Scout, Bradley’s assistant. Ask about his projects, AWS experience, CIRIS work, target roles, risks, or contact details and I’ll keep the thread coherent.${freeNote}`
    : `Hi, I’m Scout, Bradley’s recruiter assistant. What should I call you for this session? A first name is enough, and then I’ll keep the conversation personal and coherent.${freeNote}`;
  typeNewBotMessage(welcomeHtml);

  console.log("ProjectHub loaded!");
}

// Run the chat widget once the DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  try {
    setupChatUI(projects, codePens, suggestions, handleQuery, fetchAllGitHubData);
  } catch (error) {
    console.error("Error initializing ProjectHub:", error);
  }
});
