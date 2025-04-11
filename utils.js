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
async function fetchAllGitHubData(projects) {
  const projectData = [];
  for (const project of projects) {
    const githubData = await fetchGitHubRepoData(project.repo);
    projectData.push({ ...project, githubData });
  }
  return projectData;
}