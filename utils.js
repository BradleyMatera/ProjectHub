// In-memory cache for GitHub metadata so we never block on repeated or slow API calls
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
}