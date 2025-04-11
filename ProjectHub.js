const projects = [
  { 
    name: "WebGPU Shapes Renderer", 
    desc: "Demo of a WebGPU-based renderer displaying selectable 2D shapes (triangle, square, pentagon, diamond, hexagon) on a canvas, forked and enhanced from an original project (only works on Chrome).", 
    url: "https://bradleymatera.github.io/leaf-js/", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/leaf-js", 
    tech: ["WebGPU", "JavaScript", "GitHub Pages"],
    apiEndpoint: null // No API for static GitHub Pages
  },
  { 
    name: "Gatsby Starter Minimal Blog", 
    desc: "React-based blog fetching data from an Express API, deployed on Netlify.", 
    url: "https://bradleysgatsbyblog.netlify.app/", 
    platform: "Netlify", 
    repo: "https://github.com/BradleyMatera/gatsby-starter-minimal-blog", 
    tech: ["React", "Express", "Netlify"],
    apiEndpoint: "https://bradleysgatsbyblog.netlify.app/.netlify/functions/api" // Hypothetical API endpoint
  },
  { 
    name: "Interactive Pokedex", 
    desc: "An engaging Pokedex application built with HTML, Tailwind CSS, and JavaScript, integrating Pokémon APIs.", 
    url: "https://bradleymatera.github.io/Interactive-Pokedex/", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/Interactive-Pokedex", 
    tech: ["HTML", "Tailwind CSS", "JavaScript", "GitHub Pages"],
    apiEndpoint: null // No API for static GitHub Pages
  },
  { 
    name: "Mom's Business Website", 
    desc: "A responsive website for my mom’s fitness business using HTML, CSS, and JavaScript, with a photo gallery and contact form.", 
    url: "https://bradleymatera.github.io/Moms-website/", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/Moms-website", 
    tech: ["HTML", "CSS", "JavaScript", "GitHub Pages"],
    apiEndpoint: null // No API for static GitHub Pages
  },
  { 
    name: "React Native Anime CRUD App", 
    desc: "Mobile CRUD app with React Native, Node.js, MongoDB, deployed on Vercel.", 
    url: "https://cruddemo-one.vercel.app/", 
    platform: "Vercel", 
    repo: "https://github.com/BradleyMatera", // Update if specific repo exists
    tech: ["React Native", "Node.js", "MongoDB", "Vercel"],
    apiEndpoint: "https://cruddemo-one.vercel.app/api/anime" // Hypothetical API endpoint
  },
  { 
    name: "Docker Multilang Project", 
    desc: "Dockerized multi-language app (Python/Node.js) for server tooling.", 
    url: "https://github.com/BradleyMatera/docker_multilang_project", 
    platform: "GitHub", 
    repo: "https://github.com/BradleyMatera/docker_multilang_project", 
    tech: ["Docker", "Python", "Node.js", "GitHub"],
    apiEndpoint: null // No API for this project
  },
  { 
    name: "RESTful Routes Using ExpressJS", 
    desc: "RESTful API built with Express.js.", 
    url: "https://github.com/BradleyMatera/RESTfulRoutesUsingExpressJS", 
    platform: "GitHub", 
    repo: "https://github.com/BradleyMatera/RESTfulRoutesUsingExpressJS", 
    tech: ["Express", "Node.js", "GitHub"],
    apiEndpoint: null // No API for this project
  },
  { 
    name: "Pong_Deluxe", 
    desc: "Pong game using PixiJS for real-time graphics, deployed on Netlify.", 
    url: "https://pongdeluxe.netlify.app/", 
    platform: "Netlify", 
    repo: "https://github.com/BradleyMatera/Pong-Deluxe", 
    tech: ["PixiJS", "JavaScript", "Netlify"],
    apiEndpoint: null // No API for this project
  },
  { 
    name: "CheeseMath Jest Tests", 
    desc: "Math utilities with Jest unit tests, deployed on Vercel.", 
    url: "https://cheese-math.vercel.app/", 
    platform: "Vercel", 
    repo: "https://github.com/BradleyMatera/CheeseMath-Jest-Tests", 
    tech: ["JavaScript", "Jest", "Vercel"],
    apiEndpoint: null // No API for this project
  },
  { 
    name: "Animal Sounds", 
    desc: "Animal Sounds app.", 
    url: "https://bradleymatera.github.io/AnimalSounds/", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/AnimalSounds", 
    tech: ["HTML", "CSS", "JavaScript", "GitHub Pages"],
    apiEndpoint: null // No API for static GitHub Pages
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

// Context tracking for follow-up queries
let lastQueryTopic = null;

const chatDiv = document.createElement("div");
chatDiv.id = "bradley-chat";
chatDiv.style.position = "fixed";
chatDiv.style.bottom = "20px";
chatDiv.style.right = "20px";
chatDiv.style.width = "400px";
chatDiv.style.background = "#333";
chatDiv.style.borderRadius = "10px";
chatDiv.style.padding = "15px";
chatDiv.style.color = "#fff";
chatDiv.style.boxShadow = "0 0 15px rgba(0, 216, 255, 0.5)";
chatDiv.style.fontFamily = "Arial, sans-serif";
chatDiv.style.fontSize = "16px";
chatDiv.innerHTML = "<div style=\"margin-bottom: 10px; font-weight: bold;\">Bradley Matera's Project Chat</div><input id=\"chat-input\" placeholder=\"Ask about Bradley's projects!\" style=\"width: 100%; padding: 8px; border-radius: 5px; border: none; margin-bottom: 10px; font-size: 16px;\"><div id=\"chat-output\" style=\"max-height: 400px; overflow-y: auto;\"><p><strong>Bot:</strong> Welcome! I’m here to help you explore Bradley Matera’s web development work. Ask about his projects (e.g., Pokedex, Pong_Deluxe), CodePens (e.g., React Calculator, Data Visualization), platforms (e.g., GitHub, Netlify), tech (e.g., React, Docker), live data (e.g., 'What project has the most stars?'), or about Bradley as a web developer (e.g., 'Summarize Bradley as a web dev'). What would you like to know?</p></div>";
document.body.appendChild(chatDiv);
const input = document.getElementById("chat-input");
const output = document.getElementById("chat-output");
let lastRequestTime = 0;
const requestInterval = 1000; // 1 second between requests

// Function to fetch GitHub repo data (e.g., stars, last commit)
async function fetchGitHubRepoData(repoUrl) {
  const repoPath = repoUrl.replace("https://github.com/", "");
  try {
    const response = await fetch(`https://api.github.com/repos/${repoPath}`, {
      headers: {
        "Accept": "application/vnd.github.v3+json"
      }
    });
    const data = await response.json();
    return {
      stars: data.stargazers_count || 0,
      lastCommit: data.pushed_at ? new Date(data.pushed_at).toLocaleDateString() : "Unknown"
    };
  } catch (error) {
    console.error("GitHub fetch error:", error);
    return { stars: 0, lastCommit: "Unknown" };
  }
}

// Function to fetch all GitHub data for projects
async function fetchAllGitHubData() {
  const projectData = [];
  for (const project of projects) {
    const githubData = await fetchGitHubRepoData(project.repo);
    projectData.push({ ...project, githubData });
  }
  return projectData;
}

// Function to summarize Bradley Matera as a web developer based on projects
function summarizeBradleyAsWebDev() {
  const allTech = [...new Set(projects.flatMap(p => p.tech))];
  const platforms = [...new Set(projects.map(p => p.platform))];
  const projectCount = projects.length;
  const codePenCount = codePens.length;
  const frontEndTech = allTech.filter(tech => ["HTML", "CSS", "JavaScript", "React", "React Native", "Tailwind CSS", "PixiJS", "WebGPU"].includes(tech));
  const backEndTech = allTech.filter(tech => ["Node.js", "Express", "MongoDB"].includes(tech));
  const otherTech = allTech.filter(tech => ["Docker", "Jest", "GitHub", "Netlify", "Vercel", "GitHub Pages"].includes(tech));

  let summary = "Bradley Matera is a versatile and growth-oriented web developer with a strong foundation in front-end development and a growing expertise in full-stack technologies. ";
  summary += `He has worked on ${projectCount} projects and ${codePenCount} CodePen projects, showcasing a diverse skill set across multiple platforms: ${platforms.join(", ")}. `;

  if (frontEndTech.length > 0) {
    summary += `Bradley excels in front-end development, using technologies like ${frontEndTech.join(", ")} to create engaging, user-friendly interfaces. For example, his Interactive Pokedex integrates Pokémon APIs for a dynamic experience, and WebGPU Shapes Renderer experiments with cutting-edge WebGPU for high-performance graphics. `;
  }

  if (backEndTech.length > 0) {
    summary += `He’s also explored back-end development with ${backEndTech.join(", ")}, as seen in projects like React Native Anime CRUD App, which uses Node.js and MongoDB, and RESTful Routes Using ExpressJS, a RESTful API. `;
  }

  if (otherTech.length > 0) {
    summary += `Bradley leverages modern tools and practices like ${otherTech.join(", ")}, showing a focus on testing (Jest in CheeseMath Jest Tests), containerization (Docker in Docker Multilang Project), and deployment across various platforms. `;
  }

  summary += `His CodePens, like React Calculator and Markdown Previewer, highlight a hands-on learning approach, covering React, JavaScript fundamentals, and practical applications. Overall, Bradley is a developer who balances creativity, technical skill, and user-focused design, with potential to deepen his back-end expertise.`;
  return summary;
}

// Function to provide a short summary of Bradley Matera as a web developer
function shortSummaryBradleyAsWebDev() {
  return "Bradley Matera is a versatile web developer with a strong focus on front-end technologies like HTML, CSS, JavaScript, and React, as well as a growing expertise in full-stack development. He has worked on diverse projects and CodePens, showcasing creativity and technical skill across platforms like GitHub Pages, Netlify, and Vercel.";
}

input.addEventListener("keypress", async (e) => {
  if (e.key === "Enter") {
    const now = Date.now();
    if (now - lastRequestTime < requestInterval) {
      output.innerHTML += "<p><strong>Bot:</strong> Please wait a moment before sending another message.</p>";
      output.scrollTop = output.scrollHeight;
      return;
    }
    lastRequestTime = now;
    const userQuery = input.value;
    const query = userQuery.toLowerCase();

    // Display the user's input in the chat
    output.innerHTML += `<p><strong>You:</strong> ${userQuery}</p>`;

    let reply = "I don’t know that one. Try asking about Bradley Matera's projects (e.g., Pokedex, Pong_Deluxe), CodePens (e.g., React Calculator, Data Visualization), platforms (e.g., GitHub, Netlify), tech (e.g., React, Docker), live data (e.g., 'What project has the most stars?'), or about Bradley as a web developer (e.g., 'Summarize Bradley as a web dev').";

    // Check for Bradley Matera summary queries
    if (query.includes("bradley") && (query.includes("web dev") || query.includes("developer") || query.includes("summarize"))) {
      if (query.includes("full") || (lastQueryTopic === "summary" && (query.includes("more") || query.includes("full")))) {
        reply = summarizeBradleyAsWebDev();
      } else if (query.includes("short") || query.includes("paragraph")) {
        reply = shortSummaryBradleyAsWebDev();
      } else {
        reply = shortSummaryBradleyAsWebDev() + " Would you like a more detailed summary? Just ask for the 'full summary'!";
      }
      lastQueryTopic = "summary";
    }

    // Check for GitHub profile query
    if (query.includes("github") && (query.includes("bradley") || query.includes("profile"))) {
      reply = "Bradley Matera's GitHub profile is at https://github.com/BradleyMatera. He describes himself as a Web Development student at Full Sail University, focusing on front-end technologies and proficient in HTML, CSS, and JavaScript. You can explore his repositories there, including projects like Interactive Pokedex, WebGPU Shapes Renderer, and more.";
      lastQueryTopic = "github";
    }

    // Check for LinkedIn profile query
    if (query.includes("linkedin") && (query.includes("bradley") || query.includes("profile"))) {
      reply = "I don’t have direct access to Bradley Matera’s LinkedIn profile, but you can likely find him by searching for 'Bradley Matera' on LinkedIn. Based on his GitHub, he’s a Web Development student at Full Sail University with a focus on front-end technologies, so his LinkedIn might highlight his education, projects, and skills in HTML, CSS, JavaScript, and more.";
      lastQueryTopic = "linkedin";
    }

    // Check for project-specific queries (with typo tolerance)
    for (const p of projects) {
      const projectNameLower = p.name.toLowerCase();
      if (query.includes(projectNameLower) || query.includes(projectNameLower.replace(" ", "")) || query.includes(projectNameLower.replace("_", ""))) {
        const githubData = await fetchGitHubRepoData(p.repo);
        reply = `${p.name}: ${p.desc} It’s hosted on ${p.platform}${p.url !== p.repo ? ` (${p.url})` : ""}. Source: ${p.repo} (Stars: ${githubData.stars}, Last Commit: ${githubData.lastCommit}). Tech used: ${p.tech.join(", ")}.`;
        lastQueryTopic = "project";
        break;
      }
    }

    // Check for CodePen-specific queries (with typo tolerance)
    for (const cp of codePens) {
      const codePenNameLower = cp.name.toLowerCase();
      if (query.includes(codePenNameLower) || query.includes(codePenNameLower.replace(" ", ""))) {
        reply = `${cp.name}: A CodePen project by Bradley Matera. Check it out here: ${cp.url}.`;
        lastQueryTopic = "codepen";
        break;
      }
    }

    // Check for platform-specific queries
    const platforms = [...new Set(projects.map(p => p.platform.toLowerCase()))];
    for (const platform of platforms) {
      if (query.includes(platform)) {
        const platformProjects = projects.filter(p => p.platform.toLowerCase() === platform);
        reply = `Bradley Matera has ${platformProjects.length} project(s) on ${platform}: ${platformProjects.map(p => p.name).join(", ")}. Want details on a specific one?`;
        if (platform === "github" && query.includes("codepen")) {
          reply += ` He also has ${codePens.length} CodePen projects: ${codePens.map(cp => cp.name).join(", ")}.`;
        }
        lastQueryTopic = "platform";
        break;
      }
    }

    // Check for tech-specific queries
    const techs = [...new Set(projects.flatMap(p => p.tech.map(t => t.toLowerCase())))];
    for (const tech of techs) {
      if (query.includes(tech)) {
        const techProjects = projects.filter(p => p.tech.map(t => t.toLowerCase()).includes(tech));
        reply = `Bradley Matera used ${tech} in ${techProjects.length} project(s): ${techProjects.map(p => p.name).join(", ")}. Want details on a specific one?`;
        lastQueryTopic = "tech";
        break;
      }
    }

    // Check for "list" or "all" queries
    if (query.includes("list") || query.includes("all")) {
      if (query.includes("codepen")) {
        reply = `Here are Bradley Matera's CodePen projects: ${codePens.map(cp => cp.name).join(", ")}. Ask about a specific one for more details!`;
        lastQueryTopic = "codepen";
      } else {
        reply = `Here are Bradley Matera's projects: ${projects.map(p => p.name).join(", ")}. He also has ${codePens.length} CodePen projects—ask about those too!`;
        lastQueryTopic = "projects";
      }
    }

    // Check for cross-project interaction (e.g., "Compare Pokedex and Pong_Deluxe")
    if (query.includes("compare")) {
      const projectNames = projects.map(p => p.name.toLowerCase());
      const matches = projectNames.filter(name => query.includes(name));
      if (matches.length >= 2) {
        const p1 = projects.find(p => p.name.toLowerCase() === matches[0]);
        const p2 = projects.find(p => p.name.toLowerCase() === matches[1]);
        reply = `Comparing ${p1.name} and ${p2.name}:\n- ${p1.name} uses ${p1.tech.join(", ")} and is on ${p1.platform}.\n- ${p2.name} uses ${p2.tech.join(", ")} and is on ${p2.platform}.\nCommon tech: ${p1.tech.filter(t => p2.tech.includes(t)).join(", ") || "None"}.`;
        lastQueryTopic = "compare";
      }
    }

    // Check for "most stars" query
    if (query.includes("most stars")) {
      const projectData = await fetchAllGitHubData();
      const sortedProjects = projectData.sort((a, b) => b.githubData.stars - a.githubData.stars);
      const topProject = sortedProjects[0];
      reply = `The project with the most stars is ${topProject.name} with ${topProject.githubData.stars} stars. It’s hosted on ${topProject.platform}${topProject.url !== topProject.repo ? ` (${topProject.url})` : ""}. Source: ${topProject.repo}.`;
      lastQueryTopic = "stars";
    }

    // Edge case: Non-related queries (e.g., "What's the weather like?")
    if (reply.includes("I don’t know") && !query.includes("bradley")) {
      reply = "I’m here to help with Bradley Matera’s projects and CodePens—try asking about Pokedex, React Calculator, or something related to his work! For unrelated topics, I can provide general info.";
      try {
        const res = await fetch("https://projecthub-proxy-fcecbe65b068.herokuapp.com/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: userQuery })
        });
        const data = await res.json();
        if (data.reply) {
          reply += ` Here's a general response: ${data.reply}`;
        }
      } catch (error) {
        reply += " However, I couldn’t fetch a general response due to a connection issue.";
      }
      lastQueryTopic = "unrelated";
    }

    // Display the bot's response in the chat
    output.innerHTML += `<p><strong>Bot:</strong> ${reply}</p>`;
    output.scrollTop = output.scrollHeight;
    input.value = "";
  }
});

console.log("ProjectHub loaded!");