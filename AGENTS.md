# AGENTS.md — ProjectHub

Canonical instruction source for AI coding agents working on ProjectHub. Read this file first. Only read guides relevant to your current task to conserve tokens. Keep this file updated when features change.

---

## Project Overview

ProjectHub is an embeddable, AI-powered chat widget that showcases Bradley Matera’s web development projects and CodePens. It is a **vanilla JavaScript project** served from GitHub Pages and consumed by any site via a single `<script>` tag. The chat widget itself remains no-build; the embedded live analytics dashboard uses a Vite + Carbon Design System build step that produces checked-in `analytics/dist/` assets.

- **Tech stack:** Vanilla JavaScript (ES6 modules via IIFE), HTML/CSS-in-JS, GitHub Pages; live analytics uses Vite + @carbon/charts + @carbon/web-components + @carbon/styles
- **Runtime:** Browser only; chat widget has no frontend framework or bundler; analytics section is bundled with Vite
- **AI backend:** Recruiter chat API at `https://projecthub-chat.bradleymatera.dev/api/chat` on a GCP e2-micro VM with Caddy HTTPS. Uses a free multi-provider LLM network (Groq, Cloudflare Workers AI, GitHub Models, Google Gemini, xAI Grok, OpenAI-compatible). If every provider is unavailable or the reply fails validation, the final fallback is a fast, grounded answer from `data/recruiter-knowledge.json`. Provider order and daily quota guards are configurable. Local Ollama is present in the codebase but currently filtered out of the active provider order.
- **Session memory:** Browser sends a per-tab session id and recent turns; backend caches a trimmed knowledge JSON and the last 3 turns of each session. Frontend keeps 10 turns of context and sends all to the server; server uses the last 3.
- **Generative usage:** Grounded-first deterministic engine answers factual queries. Safety and false-claim checks run BEFORE learned answers. Open-ended questions are sent through the free provider network in priority order; each reply is validated against slop/false-claim rules and falls back to the grounded answer if no provider succeeds. 15s total latency budget. Out-of-scope questions are forced to grounded replies (not LLM hallucinations).
- **Retrieval pipeline:** Okapi BM25 index (`lib/bm25.js`) with query understanding (`lib/query-understanding.js` — typo correction, intent classification, contextual rewriting) is the default retrieval mode. Optional dense vector retrieval via Cloudflare Workers AI embeddings (`lib/vector-index.js`) with hybrid RRF+MMR fusion (`lib/hybrid-retrieve.js`). BM25 Recall@6=0.950 on 40-query golden eval set.
- **Stance consistency:** Per-session topic stances injected into LLM prompts to prevent contradictions across turns. 30-min TTL, cap 8 per session.
- **Semantic cache:** Paraphrase dedup via embedding cosine similarity (≥0.92 threshold). LRU, 200 entries, 10-min TTL. Only active when vector retrieval is enabled.
- **Agent name & persona:** The assistant is named **Scout**: helpful, calm, concise, honest, and never over-hype.
- **Widget UX:** Header shows "Scout" as the assistant title and "Bradley Matera · Recruiter assistant". Placeholder and welcome messages are from Scout. Each session starts by asking the visitor's name.
- **Data sources:** `data.js` (projects/CodePens), `data/recruiter-knowledge.json` (canonical facts), and `sourceMaterial` (ingested blog posts, pages, and resume guardrails from `scripts/build-knowledge.js`).
- **Think Mode:** Self-improvement loop runs every 20 minutes. Stashes weak answers, processes up to 3 per cycle through all LLM providers, validates, and pushes learned answers back to `data/recruiter-knowledge.json` on GitHub via the Contents API. False-claim, safety, out-of-scope, and meta questions are filtered before stashing. Auto-triggers on provider recovery.
- **Test suites:** 6 test suites (adversarial, coverage, load/stress, regression, edge cases, full system verification) — 474+ tests total, 99.8% pass rate. Plus 2 quality suites (real conversation replay with 40 visitor questions, quality regression with 60+ targeted tests). Test files live in `/tmp/test-suite-*.py`. Plus 36 retrieval unit tests (`test/*.test.js`) and 40-query golden eval (`data/eval-golden.json`).
- **Current branch/focus:** `master` — free multi-provider LLM network, honest grounded validation, Think Mode self-improvement, safety regex hardening, and AGENTS.md-driven documentation

---

## Repositories and Environments

This codebase uses a two-branch release model. `master` is production; `develop` is the integration branch.

- **Production repo:** `BradleyMatera/ProjectHub` on GitHub.
  - `master` branch -- live widget at `https://bradleymatera.github.io/ProjectHub/`, live backend at `https://projecthub-chat.bradleymatera.dev/`.
  - `develop` branch -- integration branch where feature work merges first.
- **Staging repo:** `BradleyMatera/ProjectHub-dev` (public — GitHub Pages is not available for private repos on the free plan).
  - Publishes the `develop` branch to `https://bradleymatera.github.io/ProjectHub-dev/`.
  - Source of truth for code remains `BradleyMatera/ProjectHub`; the staging repo is only a deploy target.
- **Staging backend:** a separate free GCP e2-micro VM at `https://dev.projecthub-chat.bradleymatera.dev/`.

When making changes:

1. Branch from `develop` in `BradleyMatera/ProjectHub`.
2. Open a pull request to `develop`.
3. After merge, push `develop` to `BradleyMatera/ProjectHub-dev:main` to stage.
4. When validated, open a pull request from `develop` to `master`.
5. After merging to `master`, tag the release and run bash deploy-gcp.sh for the production VM.

For full details, see `docs/common-tasks.md`.

## Quick Start

No install step is required to run the chat widget in a browser. Use these commands for repo-level work:

```bash
# Local test of the split modules (uses local ProjectHub.js build)
open local-test.html

# Local test of the live GitHub Pages script with cache-busting
open live-test.html

# Rebuild the single-file CDN entry point after editing data.js / utils.js / logic.js / ui.js
cat data.js utils.js logic.js ui.js > ProjectHub.js

# Install dependencies and build the live analytics dashboard
npm install
npm run build

# Run retrieval unit tests (BM25, query understanding, vector index, hybrid fusion)
npm run test:retrieval

# Evaluate retrieval quality against golden set (Recall@k, MRR@k)
npm run eval-retrieval

# Build pre-computed embeddings (requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)
npm run build:embeddings

# Publish changes to GitHub Pages
# 1. Commit and push to master (including analytics/dist if it changed)
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
| `server-gemini.js` | Backend server — chat API, LLM network, Think Mode, safety regexes, analytics, hybrid retrieval, stance consistency, semantic cache |
| `lib/rag-chunks.js` | Shared RAG chunk builder — flattens knowledge JSON into retrievable fact chunks |
| `lib/bm25.js` | Okapi BM25 retrieval index — TF saturation, IDF weighting, document-length normalization |
| `lib/query-understanding.js` | Query understanding pipeline — normalization, typo correction, intent classification, contextual rewriting |
| `lib/vector-index.js` | Dense vector index — loads pre-built embeddings, brute-force cosine similarity search |
| `lib/hybrid-retrieve.js` | Hybrid fusion — reciprocal rank fusion (RRF) + maximal marginal relevance (MMR) |
| `lib/cost-ledger.js` | Metering tracker for every billable-adjacent event |
| `lib/cost-insights.js` | Cost insights builder for the /api/costs dev endpoint |
| `data/recruiter-knowledge.json` | Canonical knowledge base (read by server, written by Think Mode) |
| `data/eval-golden.json` | Golden set of 40 queries for retrieval evaluation |
| `data/knowledge-vectors.json` | Pre-built chunk embeddings (generated by build-embeddings script) |
| `data/intent-centroids.json` | Intent centroid embeddings (generated by build-embeddings script) |
| `scripts/build-embeddings.js` | Build-time embedding generation via Cloudflare Workers AI |
| `scripts/eval-retrieval.js` | Retrieval evaluation harness — measures Recall@k and MRR@k |
| `test/bm25.test.js` | BM25 index unit tests (8 tests) |
| `test/query-understanding.test.js` | Query understanding unit tests (15 tests) |
| `test/vector-index.test.js` | Vector index unit tests (5 tests) |
| `test/hybrid-retrieve.test.js` | Hybrid fusion unit tests (8 tests) |
| `deploy-gcp.sh` | Deploy script — copies server-gemini.js + lib/ to prod GCP VM and restarts service |
| `deploy-gcp-dev.sh` | Deploy script — copies server-gemini.js + lib/ to dev GCP VM and restarts service |
| `.github/workflows/test.yml` | CI — runs unit tests, retrieval eval, syntax checks on develop |
| `.github/workflows/sync-staging.yml` | CI — syncs develop to ProjectHub-dev staging repo |
| `.github/workflows/pages.yml` | CI — deploys master to GitHub Pages |
| `package.json` | Dependency metadata; includes Vite build scripts and Carbon analytics dependencies |
| `index.html` | Public GitHub Pages landing site for ProjectHub / Scout (includes live analytics dashboard) |
| `analytics/main.js` | Analytics dashboard source — fetches, sanitizes, and visualizes multi-source data with Carbon |
| `analytics/style.css` | Analytics-specific dashboard overrides |
| `analytics/dist/` | Built analytics assets committed for GitHub Pages |
| `vite.config.js` | Vite build configuration for the analytics bundle |
| `local-test.html` | Local manual test page for the widget (uses local `ProjectHub.js`) |
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
// From any allowed origin (bradleymatera.github.io, bradleymatera.dev, CodePen)
const res = await fetch("https://projecthub-chat.bradleymatera.dev/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: userQuery, sessionId, history })
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
| Deploy, secure, or monitor the GCP backend | `docs/backend-guide.md` |
| Understand free-tier routing and cost optimization | `docs/low-cost-ai-routing.md` |

---

## Table of Contents

1. `docs/architecture-overview.md` — System design, component relationships, data flow.
2. `docs/coding-standards.md` — Naming conventions, file organization, style rules, and no-build constraints.
3. `docs/common-tasks.md` — Step-by-step workflows for routine development (add project, test locally, publish to GitHub Pages).
4. `docs/data-guide.md` — Schema and update workflow for projects, CodePens, and suggestions.
5. `docs/api-guide.md` — Chat endpoint contract, GitHub API usage, and fallback proxy behavior.
6. `docs/backend-guide.md` — GCP VM deployment, Caddy HTTPS, systemd, environment variables, cost checklist.
7. `docs/low-cost-ai-routing.md` — Free-tier LLM routing policy, provider order, validation, and cost optimization.

---

## Agent Rules

- **AGENTS.md is the single canonical source.** `CLAUDE.md` and `.github/copilot-instructions.md` only redirect here.
- **Always work on `develop`.** Do not edit `master` directly. Branch from `develop`, open PRs to `develop`, and stage changes in `ProjectHub-dev` before any production promotion.
- **Never push code straight to production.** Production backend deploys (`deploy-gcp.sh`) and merges to `master` happen only after validation on `https://bradleymatera.github.io/ProjectHub-dev/`.
- **Knowledge-base edits use the same flow.** Add or change `data/recruiter-knowledge.json` on `develop`, test on the dev backend/site, then promote to `master` via PR. Small typo fixes may be PR'd directly to `master` if they do not change answer logic.
- **Every new external call or metered resource must go through `lib/cost-ledger.js`.** If you add a new `fetch()` to an external API or a new persistent write in `server-gemini.js`, call `meterEvent()` with the event details. CI checks for unmetered `fetch()` call sites.
- Only read the guides relevant to the current task to conserve tokens.
- When changing features, update this file and the relevant `docs/` guide.
- Keep the root file lightweight; put detail in `docs/`.
