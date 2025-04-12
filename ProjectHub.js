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
const { handleQuery } = (function() {
  // Store conversation history
  let conversationHistory = [];

  // Bradley's bio data to pass to the AI
  const bradleyBio = {
    name: "Bradley Matera",
    education: "B.S. Web Development student at Full Sail University, started August 2023, graduating October 2025, 3.85 GPA.",
    skills: "JavaScript, HTML, CSS, SQL, C#, React, Gatsby, Next.js, React Native, Node.js, Express.js, MongoDB, Docker, Jest, PixiJS, WebGPU, Tailwind CSS, Flexbox, Grid, CSS animations (animeJS, ThreeJS), TypeScript (learning), Postman, Canvas, Git, Netlify, Vercel, Heroku, Figma, VS Code.",
    focus: "Building responsive, accessible web applications with a focus on front-end development and growing full-stack skills.",
    certifications: "freeCodeCamp: JavaScript Algorithms and Data Structures, Responsive Web Design, Foundational C# with Microsoft; LinkedIn: Creating Your Personal Brand, Getting Things Done, Interpersonal Communication, Professional Networking.",
    projects: projects.map(p => ({
      name: p.name,
      desc: p.desc,
      url: p.url,
      platform: p.platform,
      repo: p.repo,
      tech: p.tech
    })),
    codePens: codePens.map(cp => ({
      name: cp.name,
      url: cp.url
    })),
    experience: [
      { role: "Case Manager", organization: "Mason County, WA", duration: "Sep 2022 - Jan 2023", desc: "Guided clients through the court process, assisting with court-mandated activities and ensuring comprehensive documentation." },
      { role: "Kitten Rescue Volunteer", organization: "Mason County Kitten Rescue", duration: "Jun 2020 - Sep 2022", desc: "Contributed to the wellbeing and care of kittens, emphasizing kennel maintenance, healthcare assistance, and behavioral support." },
      { role: "Roof Loader", organization: "Stoneway Roofing Supply", duration: "2018 - 2019", desc: "Supported construction projects, emphasizing safety, teamwork, and efficient time management." },
      { role: "General Contracting/Construction", organization: "Ascend Roofing Company LLC", duration: "2017 - Aug 2018", desc: "Delivered exceptional customer service and community engagement in a fast-paced construction environment." },
      { role: "Healthcare Specialist", organization: "US Army", duration: "Jun 2011 - Apr 2014", desc: "Provided critical healthcare services, including physical examinations, medication administration, and medical procedure support." }
    ],
    github: "https://github.com/BradleyMatera",
    linkedin: "https://www.linkedin.com/in/championingempatheticwebsolutionsthroughcode/"
  };

  async function handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData) {
    const query = userQuery.toLowerCase();
    let reply = "";
    let newTopic = lastQueryTopic;

    // Add the current query to conversation history
    conversationHistory.push({ role: "user", message: userQuery });

    // Base prompt structure for all queries
    const basePrompt = `
      You are a friendly, conversational chat bot representing Bradley Matera, a Web Development student at Full Sail University. Respond in a natural, casual tone as if you were Bradley speaking directly to the user. Use "I" to refer to Bradley. Here’s some context about me:

      **Bio**: I’m Bradley Matera, a Web Development student at Full Sail University since August 2023, working towards my B.S. with a 3.85 GPA—I’ll be graduating in October 2025. I’ve been learning web dev through my courses and on my own, mostly focusing on JavaScript, HTML, CSS, SQL, and C#. I’ve also gotten some experience with React, Gatsby, Next.js, React Native, Node.js, Express.js, MongoDB, Docker, Jest, PixiJS, WebGPU, and Tailwind CSS through school projects. I’m comfortable styling with Tailwind CSS, Flexbox, and Grid, and I focus on accessibility by following ADA requirements. I’m still figuring things out as a developer, but I’m really passionate about coding and trying out new tech, and I’m always looking to get better.

      **Certifications**: I’ve earned certifications from freeCodeCamp in JavaScript Algorithms and Data Structures, Responsive Web Design, and Foundational C# with Microsoft, plus LinkedIn courses on personal branding, productivity, and communication.

      **Projects**: ${JSON.stringify(projects)}
      **CodePens**: ${JSON.stringify(codePens)}
      **Experience**: ${JSON.stringify(bradleyBio.experience)}
      **GitHub**: ${bradleyBio.github}
      **LinkedIn**: ${bradleyBio.linkedin}

      **Conversation History**: ${JSON.stringify(conversationHistory)}
    `;

    // Handle greetings
    if (query === "hi" || query === "hello" || query === "hey" || query === "yo" || query === "sup" || query === "howdy" || query === "greetings") {
      const prompt = `
        ${basePrompt}
        The user said: "${userQuery}". Respond with a friendly greeting as Bradley, welcoming them to chat about your web dev projects and skills. Suggest they ask about your projects, CodePens, or a summary of you as a web dev, and mention they can ask for a 'full summary' for more details.
      `;
      try {
        const res = await fetch("https://projecthub-proxy-fcecbe65b068.herokuapp.com/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: prompt })
        });
        const data = await res.json();
        if (data.reply) {
          reply = data.reply;
          newTopic = "greeting";
          conversationHistory.push({ role: "bot", message: reply });
        }
      } catch (error) {
        reply = "Hey there! Nice to see you! I’m here to chat about my web dev projects and stuff I’ve been learning. What’s on your mind? You can ask about my projects, CodePens, or even something like 'Summarize Bradley as a web dev'.";
        newTopic = "greeting";
        conversationHistory.push({ role: "bot", message: reply });
      }
    }

    // Handle all other queries with a dynamic prompt
    else {
      const prompt = `
        ${basePrompt}
        The user asked: "${userQuery}". Respond naturally as Bradley, keeping the tone casual and conversational. Based on the query, provide a unique answer that fits the context. Here are some guidelines:

        - If the query asks for a summary (e.g., "Summarize Bradley as a web dev"), provide a brief summary of my skills, projects, and focus as a web developer. If they ask for a "full summary" or "more" after a summary, provide a detailed summary including my education, certifications, project details, and experience.
        - If the query asks for my GitHub or LinkedIn (e.g., "What’s Bradley’s GitHub?"), provide the URL and a brief description of what they can find there.
        - If the query asks about a specific project (e.g., "Tell me about Interactive Pokedex"), provide details about that project, including its description, platform, URL, repository, and tech used. Include GitHub stars and last commit if available.
        - If the query asks about a specific CodePen (e.g., "Tell me about React Calculator"), provide the CodePen name and URL with a brief description.
        - If the query asks for projects using a specific tech (e.g., "What projects use React?"), list the projects that use that technology.
        - If the query asks to list all projects or CodePens (e.g., "List all projects"), provide a list of all project or CodePen names.
        - If the query asks for random CodePens (e.g., "List 3 random CodePens"), select 3 random CodePens and list their names.
        - If the query asks to compare projects (e.g., "Compare Pokedex and Pong_Deluxe"), compare the two projects by describing each, their tech, and platforms, and note any common technologies.
        - If the query asks for the project with the most stars (e.g., "What project has the most stars?"), identify the project with the most GitHub stars and provide its details.
        - For any other query, respond appropriately based on the context, and if unrelated to my projects or web dev work, provide a general response but try to steer the conversation back to my projects or skills.
      `;

      try {
        const res = await fetch("https://projecthub-proxy-fcecbe65b068.herokuapp.com/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: prompt })
        });
        const data = await res.json();
        if (data.reply) {
          reply = data.reply;
          newTopic = "external";
          conversationHistory.push({ role: "bot", message: reply });
        } else {
          reply = "Hmm, I’m not sure how to answer that. Let’s talk about something else—like my projects! You can ask about stuff like my Interactive Pokedex or React Calculator, or even ask for a summary about me as a web dev.";
          newTopic = "fallback";
          conversationHistory.push({ role: "bot", message: reply });
        }
      } catch (error) {
        reply = "Hmm, I’m having trouble answering that right now. Let’s talk about something else—like my projects! You can ask about stuff like my Interactive Pokedex or React Calculator, or even ask for a summary about me as a web dev.";
        newTopic = "fallback";
        conversationHistory.push({ role: "bot", message: reply });
      }
    }

    // Keep conversation history manageable (limit to last 10 messages to avoid overflow)
    if (conversationHistory.length > 10) {
      conversationHistory = conversationHistory.slice(-10);
    }

    return { reply, newTopic };
  }

  return { handleQuery };
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
    chatDiv.style.width = "600px";
    chatDiv.style.background = "#333";
    chatDiv.style.borderRadius = "10px";
    chatDiv.style.padding = "15px";
    chatDiv.style.color = "#fff";
    chatDiv.style.boxShadow = "0 0 15px rgba(0, 216, 255, 0.5)";
    chatDiv.style.fontFamily = "Arial, sans-serif";
    chatDiv.style.fontSize = "16px";
    chatDiv.style.zIndex = "1000";
    chatDiv.style.display = "none"; // Initially hidden
    chatDiv.style.transition = "all 0.3s ease";
    chatDiv.style.opacity = "0.9";
    chatDiv.style.overflow = "hidden";
    chatDiv.style.border = "1px solid #3498db";
    chatDiv.style.borderRadius = "10px";
    chatDiv.style.background = "linear-gradient(135deg, #1a1a1a, #2b2b2b)";
    chatDiv.style.boxSizing = "border-box";
    chatDiv.style.padding = "20px";
    chatDiv.style.maxHeight = "80vh";
    chatDiv.style.overflowY = "auto";
    chatDiv.style.overflowX = "hidden";


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