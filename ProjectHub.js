// Import data
const { projects, codePens, suggestions } = (function() {
  const projects = [
    { 
      name: "WebGPU Shapes Renderer", 
      desc: "A demo of a WebGPU-based renderer displaying selectable 2D shapes (triangle, square, pentagon, diamond, hexagon) on a canvas, forked and enhanced from an original project as part of my coursework (only works on Chrome).", 
      url: "https://bradleymatera.github.io/leaf-js/", 
      platform: "GitHub Pages", 
      repo: "https://github.com/BradleyMatera/leaf-js", 
      tech: ["WebGPU", "JavaScript", "GitHub Pages"],
      apiEndpoint: null
    },
    { 
      name: "Gatsby Starter Minimal Blog", 
      desc: "A React-based blog fetching data from an Express API, deployed on Netlify as a learning project for my courses.", 
      url: "https://bradleysgatsbyblog.netlify.app/", 
      platform: "Netlify", 
      repo: "https://github.com/BradleyMatera/gatsby-starter-minimal-blog", 
      tech: ["React", "Express", "Netlify", "Gatsby"],
      apiEndpoint: "https://bradleysgatsbyblog.netlify.app/.netlify/functions/api"
    },
    { 
      name: "Interactive Pokedex", 
      desc: "A Pokedex app built with HTML, Tailwind CSS, and JavaScript, integrating Pokemon APIs, created as part of my coursework to practice API integration.", 
      url: "https://bradleymatera.github.io/Interactive-Pokedex/", 
      platform: "GitHub Pages", 
      repo: "https://github.com/BradleyMatera/Interactive-Pokedex", 
      tech: ["HTML", "Tailwind CSS", "JavaScript", "GitHub Pages"],
      apiEndpoint: null
    },
    { 
      name: "Mom's Business Website", 
      desc: "A responsive website for my mom’s fitness business using HTML, CSS, and JavaScript, with a photo gallery and contact form, built to practice my front-end skills.", 
      url: "https://bradleymatera.github.io/Moms-website/", 
      platform: "GitHub Pages", 
      repo: "https://github.com/BradleyMatera/Moms-website", 
      tech: ["HTML", "CSS", "JavaScript", "GitHub Pages"],
      apiEndpoint: null
    },
    { 
      name: "React Native Anime CRUD App", 
      desc: "A mobile CRUD app built with React Native, Node.js, and MongoDB, deployed on Vercel, created to learn mobile development and back-end integration.", 
      url: "https://cruddemo-one.vercel.app/", 
      platform: "Vercel", 
      repo: "https://github.com/BradleyMatera",
      tech: ["React Native", "Node.js", "MongoDB", "Vercel"],
      apiEndpoint: "https://cruddemo-one.vercel.app/api/anime"
    },
    { 
      name: "Docker Multilang Project", 
      desc: "A Dockerized multi-language app (Python/Node.js) for server tooling, built to experiment with Docker during my studies.", 
      url: "https://github.com/BradleyMatera/docker_multilang_project", 
      platform: "GitHub", 
      repo: "https://github.com/BradleyMatera/docker_multilang_project", 
      tech: ["Docker", "Python", "Node.js", "GitHub"],
      apiEndpoint: null
    },
    { 
      name: "RESTful Routes Using ExpressJS", 
      desc: "A RESTful API built with Express.js and Node.js, connected to MongoDB, created to practice back-end development.", 
      url: "https://github.com/BradleyMatera/RESTfulRoutesUsingExpressJS", 
      platform: "GitHub", 
      repo: "https://github.com/BradleyMatera/RESTfulRoutesUsingExpressJS", 
      tech: ["Express", "Node.js", "MongoDB", "GitHub"],
      apiEndpoint: null
    },
    { 
      name: "Pong_Deluxe", 
      desc: "A Pong game using PixiJS for real-time graphics, deployed on Netlify, built to explore game development with JavaScript.", 
      url: "https://pongdeluxe.netlify.app/", 
      platform: "Netlify", 
      repo: "https://github.com/BradleyMatera/Pong-Deluxe", 
      tech: ["PixiJS", "JavaScript", "Netlify"],
      apiEndpoint: null
    },
    { 
      name: "CheeseMath Jest Tests", 
      desc: "Math utilities with Jest unit tests, deployed on Vercel, created to learn testing and debugging in JavaScript.", 
      url: "https://cheese-math.vercel.app/", 
      platform: "Vercel", 
      repo: "https://github.com/BradleyMatera/CheeseMath-Jest-Tests", 
      tech: ["JavaScript", "Jest", "Vercel"],
      apiEndpoint: null
    },
    { 
      name: "Animal Sounds", 
      desc: "An interactive soundboard app using HTML, CSS, and JavaScript, built as a fun project to practice front-end skills.", 
      url: "https://bradleymatera.github.io/AnimalSounds/", 
      platform: "GitHub Pages", 
      repo: "https://github.com/BradleyMatera/AnimalSounds", 
      tech: ["HTML", "CSS", "JavaScript", "GitHub Pages"],
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

  const suggestions = [
    "What project has the most stars?",
    "Summarize Bradley as a web dev",
    "What’s Bradley’s GitHub?",
    "What’s Bradley’s LinkedIn?",
    "Tell me about Interactive Pokedex",
    "Tell me about React Calculator",
    "List all projects",
    "List all CodePens",
    "Compare Pokedex and Pong_Deluxe",
    "What projects use React?"
  ];

  return { projects, codePens, suggestions };
})();

// Import utilities
const { fetchGitHubRepoData, fetchAllGitHubData } = (function() {
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

  async function fetchAllGitHubData(projects) {
    const projectData = [];
    for (const project of projects) {
      const githubData = await fetchGitHubRepoData(project.repo);
      projectData.push({ ...project, githubData });
    }
    return projectData;
  }

  return { fetchGitHubRepoData, fetchAllGitHubData };
})();

// Import logic
const { summarizeBradleyAsWebDev, shortSummaryBradleyAsWebDev, handleQuery } = (function() {
  function summarizeBradleyAsWebDev(projects, codePens) {
    const allTech = [...new Set(projects.flatMap(p => p.tech))];
    const platforms = [...new Set(projects.map(p => p.platform))];
    const projectCount = projects.length;
    const codePenCount = codePens.length;

    let summary = "Hey, I’m Bradley Matera, a Web Development student at Full Sail University since August 2023, working towards my B.S. with a 3.85 GPA—I’ll be graduating in October 2025. I’ve been learning web dev through my courses and on my own, mostly focusing on JavaScript, HTML, CSS, SQL, and C#. I’ve also gotten some experience with React, Gatsby, Next.js, React Native, Node.js, Express.js, MongoDB, Docker, Jest, PixiJS, WebGPU, and Tailwind CSS through school projects.<br><br>";

    summary += "So far, I’ve worked on " + projectCount + " projects and " + codePenCount + " CodePen projects, which I’ve deployed on platforms like " + platforms.join(", ") + " using tools like Git, Netlify, Vercel, Heroku, and Docker. For example, my Interactive Pokedex project uses HTML, Tailwind CSS, and JavaScript to pull data from Pokemon APIs, and my WebGPU Shapes Renderer plays around with WebGPU for rendering shapes on a canvas.<br><br>";

    summary += "I’m pretty comfortable styling with Tailwind CSS, Flexbox, and Grid, and I try to keep accessibility in mind by following ADA requirements. On the back-end, I’ve built a few RESTful APIs with Node.js and Express.js, connecting them to MongoDB or MySQL databases—like in my RESTful Routes Using ExpressJS project. I’ve also used Jest for unit testing, like in my CheeseMath Jest Tests project, and I’ve explored tools like PixiJS for real-time graphics, WebGPU for rendering, Postman for API testing, and Canvas for data visualizations. Some other projects I’ve done include interactive soundboards, Markdown previewers, quote generators, and bar chart visualizations.<br><br>";

    summary += "I’ve earned a few certifications from freeCodeCamp, like JavaScript Algorithms and Data Structures, Responsive Web Design, and Foundational C# with Microsoft, plus some LinkedIn courses on personal branding, productivity, and communication. I’m still figuring things out as a developer, but I’m really passionate about coding and trying out new tech, and I’m always looking to get better.";
    return summary;
  }

  function shortSummaryBradleyAsWebDev(projects, codePens) {
    return "I’m Bradley Matera, a Web Development student at Full Sail University, graduating in October 2025. I’ve been learning JavaScript, HTML, CSS, and tools like React, Node.js, and Tailwind CSS through my courses and self-study. I’ve worked on a few projects and CodePens, deploying them on platforms like GitHub Pages, Netlify, and Vercel, and I’m focused on building responsive, accessible web apps.";
  }

  async function handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData) {
    const query = userQuery.toLowerCase();
    let reply = "I’m not sure about that one. Try asking about my projects (like Pokedex or Pong_Deluxe), CodePens (like React Calculator or Data Visualization), platforms (like GitHub or Netlify), tech (like React or Docker), live data (like 'What project has the most stars?'), or about me as a web developer (like 'Summarize Bradley as a web dev').";
    let newTopic = lastQueryTopic;

    if (query.includes("bradley") && (query.includes("web dev") || query.includes("developer") || query.includes("summarize"))) {
      if (query.includes("full") && lastQueryTopic === "summary") {
        reply = summarizeBradleyAsWebDev(projects, codePens);
        newTopic = "summary";
      } else if (query.includes("short") || query.includes("paragraph")) {
        reply = shortSummaryBradleyAsWebDev(projects, codePens);
        newTopic = "summary";
      } else {
        reply = shortSummaryBradleyAsWebDev(projects, codePens) + " Want to know more? Just ask for the 'full summary'!";
        newTopic = "summary";
      }
    }

    if (query.includes("github") && (query.includes("bradley") || query.includes("profile") || query.includes("url"))) {
      reply = "My GitHub profile is at https://github.com/BradleyMatera. I’m a Web Development student at Full Sail University, and I’ve been learning a lot through my courses and on my own. You can check out my repositories there, like Interactive Pokedex and WebGPU Shapes Renderer, which show some of the JavaScript and deployment skills I’ve been working on with tools like Git, Netlify, Vercel, and Docker.";
      newTopic = "github";
    }

    if (query.includes("linkedin") && (query.includes("bradley") || query.includes("profile") || query.includes("url"))) {
      reply = "You can find my LinkedIn profile at https://www.linkedin.com/in/championingempatheticwebsolutionsthroughcode/. I’m a Web Development student at Full Sail University, graduating in October 2025, and I’ve been focusing on JavaScript, HTML, CSS, and tools like React and Node.js through my coursework. I also have certifications in JavaScript, C#, and responsive design from freeCodeCamp, plus some LinkedIn courses on personal branding and communication.";
      newTopic = "linkedin";
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
        reply = `${cp.name}: A CodePen project I worked on as part of my learning. Check it out here: ${cp.url}.`;
        newTopic = "codepen";
        break;
      }
    }

    const platforms = [...new Set(projects.map(p => p.platform.toLowerCase()))];
    for (const platform of platforms) {
      if (query.includes(platform)) {
        const platformProjects = projects.filter(p => p.platform.toLowerCase() === platform);
        reply = `I have ${platformProjects.length} project(s) on ${platform}: ${platformProjects.map(p => p.name).join(", ")}. Want details on a specific one?`;
        if (platform === "github" && query.includes("codepen")) {
          reply += ` I also have ${codePens.length} CodePen projects: ${codePens.map(cp => cp.name).join(", ")}.`;
        }
        newTopic = "platform";
        break;
      }
    }

    const techs = [...new Set(projects.flatMap(p => p.tech.map(t => t.toLowerCase())))];
    for (const tech of techs) {
      if (query.includes(tech)) {
        const techProjects = projects.filter(p => p.tech.map(t => t.toLowerCase()).includes(tech));
        reply = `I’ve used ${tech} in ${techProjects.length} project(s): ${techProjects.map(p => p.name).join(", ")}. Want details on a specific one?`;
        newTopic = "tech";
        break;
      }
    }

    if (query.includes("list") || query.includes("all")) {
      if (query.includes("codepen")) {
        reply = `Here are my CodePen projects: ${codePens.map(cp => cp.name).join(", ")}. Ask about a specific one for more details!`;
        newTopic = "codepen";
      } else {
        reply = `Here are my projects: ${projects.map(p => p.name).join(", ")}. I also have ${codePens.length} CodePen projects—ask about those too!`;
        newTopic = "projects";
      }
    }

    if (query.includes("compare")) {
      const projectNames = projects.map(p => p.name.toLowerCase());
      const matches = projectNames.filter(name => query.includes(name));
      if (matches.length >= 2) {
        const p1 = projects.find(p => p.name.toLowerCase() === matches[0]);
        const p2 = projects.find(p => p.name.toLowerCase() === matches[1]);
        reply = `Comparing ${p1.name} and ${p2.name}:\n- ${p1.name}: ${p1.desc} It uses ${p1.tech.join(", ")} and is on ${p1.platform}.\n- ${p2.name}: ${p2.desc} It uses ${p2.tech.join(", ")} and is on ${p2.platform}.\nCommon tech: ${p1.tech.filter(t => p2.tech.includes(t)).join(", ") || "None"}.`;
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

    if (reply.includes("I don’t know") && !query.includes("bradley")) {
      reply = "I’m here to help with my projects and CodePens—try asking about Pokedex, React Calculator, or something related to my work! For unrelated topics, I can provide general info.";
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
      newTopic = "unrelated";
    }

    return { reply, newTopic };
  }

  return { summarizeBradleyAsWebDev, shortSummaryBradleyAsWebDev, handleQuery };
})();

// Import UI setup
const setupChatUI = (function() {
  function setupChatUI(projects, codePens, suggestions, handleQuery, fetchAllGitHubData) {
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
    chatDiv.style.zIndex = "1000";

    const chatHeader = document.createElement("div");
    chatHeader.style.marginBottom = "10px";
    chatHeader.style.fontWeight = "bold";
    chatHeader.style.display = "flex";
    chatHeader.style.justifyContent = "space-between";
    chatHeader.style.alignItems = "center";
    chatHeader.innerHTML = "Bradley Matera's Project Chat";
    chatDiv.appendChild(chatHeader);

    const minimizeBtn = document.createElement("button");
    minimizeBtn.innerHTML = "−";
    minimizeBtn.style.background = "none";
    minimizeBtn.style.border = "none";
    minimizeBtn.style.color = "#fff";
    minimizeBtn.style.fontSize = "18px";
    minimizeBtn.style.cursor = "pointer";
    chatHeader.appendChild(minimizeBtn);

    const chatOutput = document.createElement("div");
    chatOutput.id = "chat-output";
    chatOutput.style.maxHeight = "400px";
    chatOutput.style.overflowY = "auto";
    chatOutput.style.marginBottom = "10px";
    chatOutput.innerHTML = `<div class="message bot-message"><strong>Bot:</strong> Hey there! I’m here to chat about my web dev projects and stuff I’ve been learning. You can ask about my projects (like Pokedex or Pong_Deluxe), CodePens (like React Calculator or Data Visualization), platforms (like GitHub or Netlify), tech (like React or Docker), or even something like 'What project has the most stars?' Want to know more about me as a web dev? Just ask 'Summarize Bradley as a web dev'. What’s on your mind?<div class="timestamp">${new Date().toLocaleTimeString()}</div></div>`;
    chatDiv.appendChild(chatOutput);

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

    const chatInput = document.createElement("textarea");
    chatInput.id = "chat-input";
    chatInput.placeholder = "Ask about my projects!";
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

    const loadingIcon = document.createElement("div");
    loadingIcon.id = "loading-icon";
    loadingIcon.style.display = "none";
    loadingIcon.style.textAlign = "center";
    loadingIcon.style.marginTop = "10px";
    loadingIcon.innerHTML = `<div style="border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; margin: 0 auto;"></div>`;
    chatDiv.appendChild(loadingIcon);

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

    const submitChat = async () => {
      const now = Date.now();
      if (now - lastRequestTime < requestInterval) {
        chatOutput.innerHTML += `<div class="message bot-message"><strong>Bot:</strong> Hang on a sec—give me a moment before sending another message.<div class="timestamp">${new Date().toLocaleTimeString()}</div></div>`;
        chatOutput.scrollTop = chatOutput.scrollHeight;
        return;
      }
      lastRequestTime = now;
      const userQuery = chatInput.value.trim();
      if (!userQuery) return;

      chatOutput.innerHTML += `<div class="message user-message"><strong>You:</strong> ${userQuery}<div class="timestamp">${new Date().toLocaleTimeString()}</div></div>`;

      loadingIcon.style.display = "block";
      chatOutput.scrollTop = chatOutput.scrollHeight;

      const { reply, newTopic } = await handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData);
      lastQueryTopic = newTopic;

      loadingIcon.style.display = "none";
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

  return setupChatUI;
})();

// Initialize the chat
setupChatUI(projects, codePens, suggestions, handleQuery, fetchAllGitHubData);