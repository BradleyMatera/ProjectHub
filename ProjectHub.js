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
async function handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData) {
  const query = userQuery.toLowerCase();
  let reply = "I don’t know that one. Try asking about Bradley Matera's current work — projects like ProjectHub, the AWS serverless workflow, or CIRIS Ethical AI; his GitHub or LinkedIn; the roles he's targeting; or his strongest technical skills. You can also ask for a summary of Bradley as a junior software engineer.";
  let newTopic = lastQueryTopic;

  const CHAT_API_URL = window.__PROJECTHUB_CHAT_API__ || "https://projecthub-proxy-fcecbe65b068.herokuapp.com/api/chat";
  const AI_TIMEOUT_MS = 60000; // Wait up to 60s for a free Google/GCP slow backend
  const AI_RETRIES = 2;

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

  // If no local intent matched, try the AI fallback with retries and a long timeout.
  // Free backends (GCP, Heroku) can be slow; we never let the UI hang forever.
  if (reply.includes("I don’t know")) {
    const localHelp = "I’m here to help with Bradley Matera’s work as a junior software engineer. Try asking about ProjectHub, the AWS serverless workflow, CIRIS Ethical AI, his GitHub or LinkedIn, target roles, or strongest technical skills.";
    let aiReply = null;
    let lastError = null;

    for (let attempt = 1; attempt <= AI_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
        const res = await fetch(CHAT_API_URL, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: userQuery })
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          if (data.reply) {
            aiReply = data.reply;
            break;
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

    if (aiReply) {
      reply = `${localHelp}<br><br><strong>AI backend says:</strong> ${aiReply}`;
    } else {
      reply = `${localHelp}<br><br><em>The AI backend is slow or unreachable right now (${lastError || "no response"}). I answered what I could locally — try a more specific question about Bradley's work.</em>`;
    }
    newTopic = "unrelated";
  }

  return { reply, newTopic };
}function setupChatUI(projects, codePens, suggestions, handleQuery, fetchAllGitHubData) {
  // Context tracking for follow-up queries
  let lastQueryTopic = null;

  // Create the chat interface
  const chatDiv = document.createElement("div");
  chatDiv.id = "bradley-chat";
  chatDiv.style.position = "fixed";
  chatDiv.style.bottom = "20px";
  chatDiv.style.right = "20px";
  chatDiv.style.width = "800px";
  chatDiv.style.background = "#333";
  chatDiv.style.borderRadius = "10px";
  chatDiv.style.padding = "15px";
  chatDiv.style.color = "#fff";
  chatDiv.style.boxShadow = "0 0 15px rgba(0, 216, 255, 0.5)";
  chatDiv.style.fontFamily = "Arial, sans-serif";
  chatDiv.style.fontSize = "16px";
  chatDiv.style.zIndex = "1000";

  // Chat header
  const chatHeader = document.createElement("div");
  chatHeader.style.marginBottom = "10px";
  chatHeader.style.fontWeight = "bold";
  chatHeader.style.display = "flex";
  chatHeader.style.justifyContent = "space-between";
  chatHeader.style.alignItems = "center";
  chatHeader.innerHTML = "Bradley Matera's Project Chat";
  chatDiv.appendChild(chatHeader);

  // Minimize button
  const minimizeBtn = document.createElement("button");
  minimizeBtn.innerHTML = "−";
  minimizeBtn.style.background = "none";
  minimizeBtn.style.border = "none";
  minimizeBtn.style.color = "#fff";
  minimizeBtn.style.fontSize = "18px";
  minimizeBtn.style.cursor = "pointer";
  chatHeader.appendChild(minimizeBtn);

  // Chat output
  const chatOutput = document.createElement("div");
  chatOutput.id = "chat-output";
  chatOutput.style.maxHeight = "400px";
  chatOutput.style.overflowY = "auto";
  chatOutput.style.marginBottom = "10px";
  chatOutput.innerHTML = `<div class="message bot-message"><strong>Bot:</strong> Hi! I'm Bradley Matera's ProjectHub assistant. Ask about his work as a junior software engineer — projects like ProjectHub, the AWS serverless workflow, or CIRIS Ethical AI; his GitHub or LinkedIn; the roles he's targeting; or his strongest technical skills. What would you like to know?<div class="timestamp">${new Date().toLocaleTimeString()}</div></div>`;
  chatDiv.appendChild(chatOutput);

  // Dropdown for suggestions
  const dropdown = document.createElement("select");
  dropdown.style.width = "100%";
  dropdown.style.padding = "8px";
  dropdown.style.borderRadius = "5px";
  dropdown.style.border = "none";
  dropdown.style.marginBottom = "10px";
  dropdown.style.background = "#444";
  dropdown.style.color = "#fff";
  dropdown.style.fontSize = "16px";
  dropdown.innerHTML = `<option value="">Select a suggestion...</option>` + suggestions.map(s => `<option value="${s}">${s}</option>`).join("");
  chatDiv.appendChild(dropdown);

  // Chat input
  const chatInput = document.createElement("textarea");
  chatInput.id = "chat-input";
  chatInput.placeholder = "Ask about Bradley's work, projects, skills, or roles...";
  chatInput.style.width = "100%";
  chatInput.style.padding = "8px";
  chatInput.style.borderRadius = "5px";
  chatInput.style.border = "none";
  chatInput.style.background = "#444";
  chatInput.style.color = "#fff";
  chatInput.style.fontSize = "16px";
  chatInput.style.resize = "none";
  chatInput.style.height = "40px";
  chatInput.style.overflowY = "hidden";
  chatDiv.appendChild(chatInput);

  // Send button
  const sendButton = document.createElement("button");
  sendButton.innerHTML = "Send";
  sendButton.style.marginTop = "5px";
  sendButton.style.padding = "8px 16px";
  sendButton.style.background = "#3498db";
  sendButton.style.color = "#fff";
  sendButton.style.border = "none";
  sendButton.style.borderRadius = "5px";
  sendButton.style.cursor = "pointer";
  sendButton.style.fontSize = "16px";
  sendButton.style.width = "100%";
  chatDiv.appendChild(sendButton);

  // Loading icon
  const loadingIcon = document.createElement("div");
  loadingIcon.id = "loading-icon";
  loadingIcon.style.display = "none";
  loadingIcon.style.textAlign = "center";
  loadingIcon.style.marginTop = "10px";
  loadingIcon.innerHTML = `<div style="border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; margin: 0 auto;"></div>`;
  chatDiv.appendChild(loadingIcon);

  // Add CSS for loading animation and message styling
  const style = document.createElement("style");
  style.innerHTML = `
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .message {
      margin-bottom: 10px;
      padding: 10px;
      border-radius: 5px;
      word-wrap: break-word;
    }
    .user-message {
      background: #555;
      text-align: right;
    }
    .bot-message {
      background: #444;
    }
    .timestamp {
      font-size: 12px;
      color: #aaa;
      margin-top: 5px;
    }
  `;
  document.head.appendChild(style);

  document.body.appendChild(chatDiv);

  let lastRequestTime = 0;
  const requestInterval = 1000;

  minimizeBtn.onclick = () => {
    chatOutput.style.display = chatOutput.style.display === "none" ? "block" : "none";
    chatInput.style.display = chatInput.style.display === "none" ? "block" : "none";
    dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
    minimizeBtn.innerHTML = chatOutput.style.display === "none" ? "+" : "−";
  };

  chatInput.oninput = () => {
    chatInput.style.height = "40px";
    chatInput.style.height = `${chatInput.scrollHeight}px`;
  };

  dropdown.onchange = () => {
    if (dropdown.value) {
      chatInput.value = dropdown.value;
      dropdown.value = "";
    }
  };

  // Event handler for Send button and Enter key
  const submitChat = async () => {
    const now = Date.now();
    if (now - lastRequestTime < requestInterval) {
      chatOutput.innerHTML += `<div class="message bot-message"><strong>Bot:</strong> Please wait a moment before sending another message.<div class="timestamp">${new Date().toLocaleTimeString()}</div></div>`;
      chatOutput.scrollTop = chatOutput.scrollHeight;
      return;
    }
    lastRequestTime = now;
    const userQuery = chatInput.value.trim();
    if (!userQuery) return;

    chatOutput.innerHTML += `<div class="message user-message"><strong>You:</strong> ${userQuery}<div class="timestamp">${new Date().toLocaleTimeString()}</div></div>`;

    loadingIcon.style.display = "block";
    const statusDiv = document.createElement("div");
    statusDiv.id = "thinking-status";
    statusDiv.className = "message bot-message";
    statusDiv.style.opacity = "0.8";
    statusDiv.innerHTML = `<strong>Bot:</strong> Thinking...<div class="timestamp">${new Date().toLocaleTimeString()}</div>`;
    chatOutput.appendChild(statusDiv);
    chatOutput.scrollTop = chatOutput.scrollHeight;

    let thinkingDots = 0;
    const thinkingInterval = setInterval(() => {
      thinkingDots = (thinkingDots + 1) % 4;
      const dots = ".".repeat(thinkingDots);
      const messages = ["Checking local knowledge", "Waiting for AI backend", "Almost there"];
      const message = messages[(thinkingDots) % messages.length];
      statusDiv.innerHTML = `<strong>Bot:</strong> ${message}${dots}<div class="timestamp">${new Date().toLocaleTimeString()}</div>`;
      chatOutput.scrollTop = chatOutput.scrollHeight;
    }, 800);

    const { reply, newTopic } = await handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData);

    clearInterval(thinkingInterval);
    statusDiv.remove();
    lastQueryTopic = newTopic;

    loadingIcon.style.display = "none";
    // Create a new message div and set its innerHTML to render the HTML formatting
    const messageDiv = document.createElement("div");
    messageDiv.className = "message bot-message";
    messageDiv.innerHTML = `<strong>Bot:</strong> ${reply}<div class="timestamp">${new Date().toLocaleTimeString()}</div>`;
    chatOutput.appendChild(messageDiv);
    chatOutput.scrollTop = chatOutput.scrollHeight;
    chatInput.value = "";
    chatInput.style.height = "40px";
  };

  sendButton.onclick = submitChat;

  chatInput.addEventListener("keypress", async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitChat();
    }
  });

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