const projects = [
  { 
    name: "Gatsby Blog", 
    desc: "A blogging app built with Gatsby, hosted on Netlify.", 
    url: "https://bradleysgatsbyblog.netlify.app", 
    platform: "Netlify", 
    repo: "https://github.com/BradleyMatera/gatsby-starter-minimal-blog", 
    tech: ["Gatsby", "React", "Netlify"]
  },
  { 
    name: "Pokedex", 
    desc: "An interactive Pokémon data app, hosted on GitHub Pages.", 
    url: "https://bradleymatera.github.io/Interactive-Pokedex", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/Interactive-Pokedex", 
    tech: ["JavaScript", "HTML", "CSS", "GitHub Pages"]
  },
  { 
    name: "Anime CRUD", 
    desc: "A full-stack CRUD app for anime data, hosted on Vercel.", 
    url: "https://cruddemo-one.vercel.app", 
    platform: "Vercel", 
    repo: "https://github.com/BradleyMatera/RESTfulRoutesUsingExpressJS", 
    tech: ["Express", "Node.js", "MongoDB", "Vercel"]
  },
  { 
    name: "CheeseMath", 
    desc: "A math library with Jest tests, hosted on Vercel.", 
    url: "https://cheese-math.vercel.app", 
    platform: "Vercel", 
    repo: "https://github.com/BradleyMatera/CheeseMath-Jest-Tests", 
    tech: ["JavaScript", "Jest", "Vercel"]
  },
  { 
    name: "WebGPU Renderer", 
    desc: "A 2D shapes renderer using WebGPU, hosted on GitHub Pages (Chrome-only).", 
    url: "https://bradleymatera.github.io/leaf-js", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/leaf-js", 
    tech: ["WebGPU", "JavaScript", "GitHub Pages"]
  },
  { 
    name: "Portfolio", 
    desc: "My professional portfolio website, hosted on GitHub Pages.", 
    url: "https://bradleymatera.github.io/Professional-Portfolio-Website", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/Professional-Portfolio-Website", 
    tech: ["HTML", "CSS", "JavaScript", "GitHub Pages"]
  },
  { 
    name: "Docker Multilang", 
    desc: "A multi-language app with Docker, source on GitHub.", 
    url: "https://github.com/BradleyMatera/docker_multilang_project", 
    platform: "GitHub", 
    repo: "https://github.com/BradleyMatera/docker_multilang_project", 
    tech: ["Docker", "Node.js", "Python", "GitHub"]
  }
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
chatDiv.innerHTML = "<div style=\"margin-bottom: 10px; font-weight: bold;\">Bradley\'s Project Chat</div><input id=\"chat-input\" placeholder=\"Ask about my projects!\" style=\"width: 100%; padding: 5px; border-radius: 5px; border: none; margin-bottom: 10px;\"><div id=\"chat-output\" style=\"max-height: 300px; overflow-y: auto;\"><p>Welcome! Ask about my projects (e.g., Pokedex, Anime CRUD), platforms (e.g., GitHub, Netlify), or tech (e.g., React, Docker).</p></div>";
document.body.appendChild(chatDiv);
const input = document.getElementById("chat-input");
const output = document.getElementById("chat-output");
let lastRequestTime = 0;
const requestInterval = 1000; // 1 second between requests

input.addEventListener("keypress", async (e) => {
  if (e.key === "Enter") {
    const now = Date.now();
    if (now - lastRequestTime < requestInterval) {
      output.innerHTML += "<p>Please wait a moment before sending another message.</p>";
      output.scrollTop = output.scrollHeight;
      return;
    }
    lastRequestTime = now;
    const query = input.value.toLowerCase();
    let reply = "I don’t know that one. Try asking about my projects (e.g., Pokedex, Anime CRUD), platforms (e.g., GitHub, Netlify), or tech (e.g., React, Docker)!";

    // Check for project-specific queries
    for (const p of projects) {
      if (query.includes(p.name.toLowerCase())) {
        reply = `${p.name}: ${p.desc} It’s hosted on ${p.platform} (${p.url}). Source: ${p.repo}. Tech used: ${p.tech.join(", ")}.`;
        break;
      }
    }

    // Check for platform-specific queries
    const platforms = [...new Set(projects.map(p => p.platform.toLowerCase()))];
    for (const platform of platforms) {
      if (query.includes(platform)) {
        const platformProjects = projects.filter(p => p.platform.toLowerCase() === platform);
        reply = `I have ${platformProjects.length} project(s) on ${platform}: ${platformProjects.map(p => p.name).join(", ")}. Want details on a specific one?`;
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
      reply = "Here are my projects: " + projects.map(p => p.name).join(", ") + ". Ask about a specific one for more details!";
    }

    // If no match, send to xAI Grok API for a general response
    if (reply.includes("I don’t know")) {
      try {
        const res = await fetch("https://projecthub-proxy-fcecbe65b068.herokuapp.com/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: query })
        });
        const data = await res.json();
        reply = data.reply || "Sorry, I couldn’t get a response.";
      } catch (error) {
        reply = "Error connecting to the chat service.";
      }
    }

    output.innerHTML += `<p>${reply}</p>`;
    output.scrollTop = output.scrollHeight;
    input.value = "";
  }
});

console.log("ProjectHub loaded!");