// Function to summarize Bradley Matera as a junior software engineer
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

  const CHAT_API_URL = window.__PROJECTHUB_CHAT_API__ || "https://projecthub-chat.bradleymatera.dev/api/chat";
  const AI_TIMEOUT_MS = 16000;
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
            const followUps = Array.isArray(data.followUps) && data.followUps.length
              ? `<div class="followup-list"><strong>Good follow-ups:</strong>${data.followUps.slice(0, 3).map(item => `<button type="button" class="followup-chip" data-followup="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div>`
              : "";
            return { reply: `${data.reply}${followUps}`, error: null };
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
}