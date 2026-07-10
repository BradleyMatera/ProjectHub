# AGENTS.md — ProjectHub

Canonical instruction source for AI coding agents working on ProjectHub. Read this file first. Only read guides relevant to your current task to conserve tokens. Keep this file updated when features change.

---

## Project Overview

ProjectHub is an embeddable, AI-powered chat widget that showcases Bradley Matera’s web development projects and CodePens. It is a **vanilla JavaScript, no-build project** served from GitHub Pages and consumed by any site via a single `<script>` tag.

- **Tech stack:** Vanilla JavaScript (ES6 modules via IIFE), HTML/CSS-in-JS, GitHub Pages
- **Runtime:** Browser only; no frontend framework or bundler
- **AI backend:** Recruiter chat API at `https://projecthub-chat.bradleymatera.dev/api/chat` on a GCP VM. Runs local Ollama (`gemma3:1b` fallback + `smollm2:135m` generative RAG). Gemini is no longer used.
- **Session memory:** Browser sends a per-tab session id and recent turns; backend caches a trimmed knowledge JSON and the last 3 turns of each session.
- **Generative usage:** Grounded-first deterministic engine answers factual queries. Open-ended questions are sent to the local RAG layer with streaming, real-time abort on forbidden patterns, and grounded fallback. 15s total latency budget.
- **Agent name & persona:** The assistant is named **Scout**: helpful, calm, concise, honest, and never over-hype.
- **Widget UX:** Header shows "Scout" as the assistant title and "Bradley Matera · Recruiter assistant". Placeholder and welcome messages are from Scout. Each session starts by asking the visitor's name.
- **Data sources:** `data.js` (projects/CodePens), `data/recruiter-knowledge.json` (canonical facts), and `sourceMaterial` (ingested blog posts, pages, and resume guardrails from `scripts/build-knowledge.js`).
- **Current branch/focus:** `main` — zero-cost Ollama chat backend on GCP, streaming RAG, and AGENTS.md-driven documentation

---

## Quick Start

No install step is required to run the widget in a browser. Use these commands for repo-level work:

```bash
# Local test of the split modules (uses local ProjectHub.js build)
open index.html

# Local test of the live GitHub Pages script with cache-busting
open live-test.html

# Rebuild the single-file CDN entry point after editing data.js / utils.js / logic.js / ui.js
cat data.js utils.js logic.js ui.js > ProjectHub.js

# Publish changes to GitHub Pages
# 1. Commit and push to master
# 2. GitHub Pages rebuilds automatically from the default branch
```

Live widget URL for embedding:

```html
<script src="https://bradleymatera.github.io/ProjectHub/ProjectHub.js"></script>
```

> If a consumer (like CodePen) caches the script aggressively, append a cache-busting query string, e.g. `?v=2`.

---

## Key File Locations

| File | Purpose |
|------|---------|
| `ProjectHub.js` | Entry point; orchestrates imports, sets up chat UI, wires data→logic→UI |
| `data.js` | Canonical project/CodePen/suggestion data arrays |
| `logic.js` | Query intent detection, response generation, AI fallback orchestration |
| `ui.js` | DOM creation, event handling, rendering of the floating chat widget |
| `utils.js` | Shared helpers (GitHub API fetching) |
| `package.json` | Dependency metadata only (`openai`); no build scripts yet |
| `index.html` | Local manual test page for the widget (uses local `ProjectHub.js`) |
| `live-test.html` | Cache-busting test of the live GitHub Pages `ProjectHub.js` |
| `docs/` | Detailed on-demand guides |
| `.github/copilot-instructions.md` | Redirect to this file |
| `CLAUDE.md` | Redirect to this file |

---

## Common Namespaces / Imports

The repo uses IIFE modules that expose globals for legacy embeddability:

```javascript
// From data.js
const { projects, codePens, suggestions } = dataModule;

// From utils.js
const { fetchGitHubRepoData, fetchAllGitHubData } = utilsModule;

// From logic.js
const { handleQuery } = logicModule;

// From ui.js
function setupChatUI(projects, codePens, suggestions, handleQuery, fetchAllGitHubData)
```

> Note: `ProjectHub.js` currently inlines these IIFEs. Prefer editing `data.js`/`logic.js`/`ui.js`/`utils.js` directly; the inlined copies are a deployment artifact and should stay in sync.

---

## Quick Reference for Frequently Used Patterns

### Logging

```javascript
console.error("GitHub fetch error:", error);
console.log("ProjectHub loaded!");
```

### Fetching GitHub metadata

```javascript
const githubData = await fetchGitHubRepoData(repoUrl);
const allData = await fetchAllGitHubData(projects);
```

### Calling the recruiter chat API

```javascript
// On bradleymatera.dev (production)
const res = await fetch("/.netlify/functions/recruiter-chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: userQuery, sessionId })
});
```

### Rendering HTML in bot messages

Bot replies may contain `<br>`, `<strong>`, etc. Insert them with `innerHTML` inside a `messageDiv`, never raw `innerHTML` on the whole output.

### Adding a new project

Add an entry to `data.js` `projects` array and mirror it in `ProjectHub.js` if the inlined copy is still in use. See `docs/data-guide.md`.

---

## Guide Selection Helper

| Task type | Read this guide |
|-----------|-----------------|
| Understand data flow, hosting, or backend migration | `docs/architecture-overview.md` |
| Add a project, CodePen, suggestion, or update data | `docs/data-guide.md` |
| Add/modify intents, AI fallback, response logic | `docs/api-guide.md` |
| Run, test, publish, or do routine maintenance | `docs/common-tasks.md` |
| Follow naming, file organization, or style rules | `docs/coding-standards.md` |

---

## Table of Contents

1. `docs/architecture-overview.md` — System design, component relationships, data flow.
2. `docs/coding-standards.md` — Naming conventions, file organization, style rules, and no-build constraints.
3. `docs/common-tasks.md` — Step-by-step workflows for routine development (add project, test locally, publish to GitHub Pages).
4. `docs/data-guide.md` — Schema and update workflow for projects, CodePens, and suggestions.
5. `docs/api-guide.md` — Chat endpoint contract, GitHub API usage, and fallback proxy behavior.

---

## Agent Rules

- **AGENTS.md is the single canonical source.** `CLAUDE.md` and `.github/copilot-instructions.md` only redirect here.
- Only read the guides relevant to the current task to conserve tokens.
- When changing features, update this file and the relevant `docs/` guide.
- Keep the root file lightweight; put detail in `docs/`.
