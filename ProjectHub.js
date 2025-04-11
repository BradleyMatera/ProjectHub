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

const chatDiv = document.createElement("div");
chatDiv.id = "bradley-chat";
chatDiv.style.position = "fixed";
chatDiv.style.bottom = "20px";
chatDiv.style.right = "20px";
chatDiv.style.width = "300px";
chatDiv.style.background = "#333";
chatDiv.style.borderRadius = "10px";
chatDiv.style.padding = "10px";
chatDiv.style.color = "#fff";
chatDiv.style.boxShadow = "0 0 15px rgba(0, 216, 255, 0.5)";
chatDiv.style.fontFamily = "Arial, sans-serif";
chatDiv.innerHTML = "<div style=\"margin-bottom: 10px; font-weight: bold;\">Bradley\'s Project Chat</div><input id=\"chat-input\" placeholder=\"Ask about my projects!\" style=\"width: 100%; padding: 5px; border-radius: 5px; border: none; margin-bottom: 10px;\"><div id=\"chat-output\" style=\"max-height: 300px; overflow-y: auto;\"><p><strong>Bot:</strong> Welcome! Ask about my projects (e.g., Pokedex, Pong_Deluxe), CodePens (e.g., React Calculator, Data Visualization), platforms (e.g., GitHub, Netlify), tech (e.g., React, Docker), or fetch live data (e.g., 'What project has the most stars?'). You can also ask about Bradley Matera as a web developer!</p></div>";
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

  let summary = "Bradley Matera is a versatile web developer with a strong focus on front-end development and a growing interest in full-stack technologies. ";
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

  summary += `His CodePens, like React Calculator and Markdown Previewer, highlight a hands-on learning approach, covering React, JavaScript fundamentals, and practical applications. Overall, Bradley is a growth-oriented developer who balances creativity, technical skill, and user-focused design, with room to deepen his back-end expertise.`;
  return summary;
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

    let reply = "I don’t know that one. Try asking about my projects (e.g., Pokedex, Pong_Deluxe), CodePens (e.g., React Calculator, Data Visualization), platforms (e.g., GitHub, Netlify), tech (e.g., React, Docker), or fetch live data (e.g., 'What project has the most stars?'). You can also ask about Bradley Matera as a web developer!";

    // Check for Bradley Matera summary queries
    if (query.includes("bradley matera") && (query.includes("web dev") || query.includes("developer") || query.includes("summarize"))) {
      reply = summarizeBradleyAsWebDev();
    }

    // Check for project-specific queries
    for (const p of projects) {
      if (query.includes(p.name.toLowerCase())) {
        const githubData = await fetchGitHubRepoData(p.repo);
        reply = `${p.name}: ${p.desc} It’s hosted on ${p.platform}${p.url !== p.repo ? ` (${p.url})` : ""}. Source: ${p.repo} (Stars: ${githubData.stars}, Last Commit: ${githubData.lastCommit}). Tech used: ${p.tech.join(", ")}.`;
        break;
      }
    }

    // Check for CodePen-specific queries
    for (const cp of codePens) {
      if (query.includes(cp.name.toLowerCase())) {
        reply = `${cp.name}: A CodePen project. Check it out here: ${cp.url}.`;
        break;
      }
    }

    // Check for platform-specific queries
    const platforms = [...new Set(projects.map(p => p.platform.toLowerCase()))];
    for (const platform of platforms) {
      if (query.includes(platform)) {
        const platformProjects = projects.filter(p => p.platform.toLowerCase() === platform);
        reply = `I have ${platformProjects.length} project(s) on ${platform}: ${platformProjects.map(p => p.name).join(", ")}. Want details on a specific one?`;
        if (platform === "github" && query.includes("codepen")) {
          reply += ` I also have ${codePens.length} CodePen projects: ${codePens.map(cp => cp.name).join(", ")}.`;
        }
        break;
      }
    }

    // Check for tech-specific queries
    const techs = [...new Set(projects.flatMap(p => p.tech.map(t => t.toLowerCase())))];
    for (const tech of techs) {
      if (query.includes(tech)) {
        const techProjects = projects.filter(p => p.tech.map(t => t.toLowerCase()).includes(tech));
        reply = `I used ${tech} in ${techProjects.length} project(s): ${techProjects.map(p => p.name).join(", ")}. Want details on a specific one?`;
        break;
      }
    }

    // Check for "list" or "all" queries
    if (query.includes("list") || query.includes("all")) {
      if (query.includes("codepen")) {
        reply = `Here are my CodePen projects: ${codePens.map(cp => cp.name).join(", ")}. Ask about a specific one for more details!`;
      } else {
        reply = `Here are my projects: ${projects.map(p => p.name).join(", ")}. I also have ${codePens.length} CodePen projects—ask about those too!`;
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
      }
    }

    // Check for "most stars" query
    if (query.includes("most stars")) {
      const projectData = await fetchAllGitHubData();
      const sortedProjects = projectData.sort((a, b) => b.githubData.stars - a.githubData.stars);
      const topProject = sortedProjects[0];
      reply = `The project with the most stars is ${topProject.name} with ${topProject.githubData.stars} stars. It’s hosted on ${topProject.platform}${topProject.url !== topProject.repo ? ` (${topProject.url})` : ""}. Source: ${topProject.repo}.`;
    }

    // Edge case: Non-related queries (e.g., "What's the weather like?")
    if (reply.includes("I don’t know") && !query.includes("bradley matera")) {
      reply = "I’m here to help with Bradley’s projects and CodePens—try asking about Pokedex, React Calculator, or something related to his work! For unrelated topics, I can provide general info.";
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
    }

    // Display the bot's response in the chat
    output.innerHTML += `<p><strong>Bot:</strong> ${reply}</p>`;
    output.scrollTop = output.scrollHeight;
    input.value = "";
  }
});

console.log("ProjectHub loaded!");