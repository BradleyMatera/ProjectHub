// Function to summarize Bradley Matera as a web developer based on projects
function summarizeBradleyAsWebDev(projects, codePens) {
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
function shortSummaryBradleyAsWebDev(projects, codePens) {
  return "Bradley Matera is a versatile web developer with a strong focus on front-end technologies like HTML, CSS, JavaScript, and React, as well as a growing expertise in full-stack development. He has worked on diverse projects and CodePens, showcasing creativity and technical skill across platforms like GitHub Pages, Netlify, and Vercel.";
}

// Function to handle user queries
async function handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData) {
  const query = userQuery.toLowerCase();
  let reply = "I don’t know that one. Try asking about Bradley Matera's projects (e.g., Pokedex, Pong_Deluxe), CodePens (e.g., React Calculator, Data Visualization), platforms (e.g., GitHub, Netlify), tech (e.g., React, Docker), live data (e.g., 'What project has the most stars?'), or about Bradley as a web developer (e.g., 'Summarize Bradley as a web dev').";
  let newTopic = lastQueryTopic;

  // Check for Bradley Matera summary queries
  if (query.includes("bradley") && (query.includes("web dev") || query.includes("developer") || query.includes("summarize"))) {
    if (query.includes("full") || (lastQueryTopic === "summary" && (query.includes("more") || query.includes("full")))) {
      reply = summarizeBradleyAsWebDev(projects, codePens);
    } else if (query.includes("short") || query.includes("paragraph")) {
      reply = shortSummaryBradleyAsWebDev(projects, codePens);
    } else {
      reply = shortSummaryBradleyAsWebDev(projects, codePens) + " Would you like a more detailed summary? Just ask for the 'full summary'!";
    }
    newTopic = "summary";
  }

  // Check for GitHub profile query
  if (query.includes("github") && (query.includes("bradley") || query.includes("profile"))) {
    reply = "Bradley Matera's GitHub profile is at https://github.com/BradleyMatera. He describes himself as a Web Development student at Full Sail University, focusing on front-end technologies and proficient in HTML, CSS, and JavaScript. You can explore his repositories there, including projects like Interactive Pokedex, WebGPU Shapes Renderer, and more.";
    newTopic = "github";
  }

  // Check for LinkedIn profile query
  if (query.includes("linkedin") && (query.includes("bradley") || query.includes("profile"))) {
    reply = "I don’t have direct access to Bradley Matera’s LinkedIn profile, but you can likely find him by searching for 'Bradley Matera' on LinkedIn. Based on his GitHub, he’s a Web Development student at Full Sail University with a focus on front-end technologies, so his LinkedIn might highlight his education, projects, and skills in HTML, CSS, JavaScript, and more.";
    newTopic = "linkedin";
  }

  // Check for project-specific queries (with typo tolerance)
  for (const p of projects) {
    const projectNameLower = p.name.toLowerCase();
    if (query.includes(projectNameLower) || query.includes(projectNameLower.replace(" ", "")) || query.includes(projectNameLower.replace("_", ""))) {
      const githubData = await fetchGitHubRepoData(p.repo);
      reply = `${p.name}: ${p.desc} It’s hosted on ${p.platform}${p.url !== p.repo ? ` (${p.url})` : ""}. Source: ${p.repo} (Stars: ${githubData.stars}, Last Commit: ${githubData.lastCommit}). Tech used: ${p.tech.join(", ")}.`;
      newTopic = "project";
      break;
    }
  }

  // Check for CodePen-specific queries (with typo tolerance)
  for (const cp of codePens) {
    const codePenNameLower = cp.name.toLowerCase();
    if (query.includes(codePenNameLower) || query.includes(codePenNameLower.replace(" ", ""))) {
      reply = `${cp.name}: A CodePen project by Bradley Matera. Check it out here: ${cp.url}.`;
      newTopic = "codepen";
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
      newTopic = "platform";
      break;
    }
  }

  // Check for tech-specific queries
  const techs = [...new Set(projects.flatMap(p => p.tech.map(t => t.toLowerCase())))];
  for (const tech of techs) {
    if (query.includes(tech)) {
      const techProjects = projects.filter(p => p.tech.map(t => t.toLowerCase()).includes(tech));
      reply = `Bradley Matera used ${tech} in ${techProjects.length} project(s): ${techProjects.map(p => p.name).join(", ")}. Want details on a specific one?`;
      newTopic = "tech";
      break;
    }
  }

  // Check for "list" or "all" queries
  if (query.includes("list") || query.includes("all")) {
    if (query.includes("codepen")) {
      reply = `Here are Bradley Matera's CodePen projects: ${codePens.map(cp => cp.name).join(", ")}. Ask about a specific one for more details!`;
      newTopic = "codepen";
    } else {
      reply = `Here are Bradley Matera's projects: ${projects.map(p => p.name).join(", ")}. He also has ${codePens.length} CodePen projects—ask about those too!`;
      newTopic = "projects";
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
      newTopic = "compare";
    }
  }

  // Check for "most stars" query
  if (query.includes("most stars")) {
    const projectData = await fetchAllGitHubData(projects);
    const sortedProjects = projectData.sort((a, b) => b.githubData.stars - a.githubData.stars);
    const topProject = sortedProjects[0];
    reply = `The project with the most stars is ${topProject.name} with ${topProject.githubData.stars} stars. It’s hosted on ${topProject.platform}${topProject.url !== topProject.repo ? ` (${topProject.url})` : ""}. Source: ${topProject.repo}.`;
    newTopic = "stars";
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
    newTopic = "unrelated";
  }

  return { reply, newTopic };
}