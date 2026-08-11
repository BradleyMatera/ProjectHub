# AGENTS.md — ProjectHub

Canonical instruction source for AI coding agents working on ProjectHub. Read this file first. Only read guides relevant to your current task to conserve tokens. Keep this file updated when features change.

---

## Project Overview

ProjectHub is an embeddable, AI-powered chat widget that showcases Bradley Matera’s web development projects and CodePens. It is a **vanilla JavaScript project** served from GitHub Pages and consumed by any site via a single `<script>` tag. The chat widget itself remains no-build; the embedded live analytics dashboard uses a Vite + Carbon Design System build step that produces checked-in `analytics/dist/` assets.

- **Tech stack:** Vanilla JavaScript (ES6 modules via IIFE), HTML/CSS-in-JS, GitHub Pages; live analytics uses Vite + @carbon/charts + @carbon/web-components + @carbon/styles
- **Runtime:** Browser only; chat widget has no frontend framework or bundler; analytics section is bundled with Vite
- **AI backend:** Recruiter chat API at `https://projecthub-chat.bradleymatera.dev/api/chat` on a free GCP e2-micro VM with Caddy HTTPS. Inference is exclusively a pre-warmed local `qwen2.5:0.5b` model through Ollama. Deterministic evidence tools, BM25 retrieval, bundled knowledge, memory, stance consistency, and strict validation compensate for the small model. Invalid or slow generations fall back to a useful grounded answer from `data/recruiter-knowledge.json`.
- **Session memory:** Browser sends a per-tab session id and recent turns. The local RAG layer uses the five newest sanitized turns; the browser keeps up to 10.
- **Generative usage:** Grounded-first deterministic logic answers factual and safety-sensitive queries. Evidence-heavy requests execute five read-only tools deterministically. Open-ended recruiter conversation uses local Ollama RAG with up to five recent turns plus per-topic stances. Generated replies must pass safety, entity, number, length, source-overlap, and overclaim validation; otherwise the grounded answer is returned. Unknown tools fail closed and no public tool performs writes or arbitrary web access. 15s end-to-end response budget. Out-of-scope questions are forced to grounded replies.
- **Retrieval pipeline:** Local Okapi BM25 (`lib/bm25.js`) with query understanding (`lib/query-understanding.js` — typo correction, intent classification, contextual rewriting). Standalone questions use the strongest BM25 view; conversational follow-ups fuse literal, alias-expanded, and context-rewritten BM25 rankings with local Reciprocal Rank Fusion (`lib/rrf.js`, k=60) so the explicit subject is not lost. BM25 Recall@6=1.000 on the current 40-query golden eval set.
- **Stance consistency:** Per-session topic stances injected into local prompts to prevent contradictions across turns. 60-minute TTL, cap 12 per session.
- **Agent name & persona:** The assistant is named **Scout**: helpful, calm, concise, honest, and never over-hype.
- **Widget UX:** Header shows "Scout" as the assistant title and "Bradley Matera · Recruiter assistant". Placeholder and welcome messages are from Scout. Each session starts by asking the visitor's name.
- **Data sources:** `data.js` (projects/CodePens), `data/recruiter-knowledge.json` (canonical facts), and `sourceMaterial` (ingested blog posts, pages, and resume guardrails from `scripts/build-knowledge.js`).
- **Think Mode:** A local self-improvement loop runs every 20 minutes. It stashes weak answers, asks Ollama for improved grounded wording, scores and judges candidates, and retains only validated improvements in the local learned file. It never writes to GitHub or another external system.
- **Test suites:** 6 legacy API suites (adversarial, coverage, load/stress, regression, edge cases, full system verification) plus 63 checked-in Node unit tests, a 61-request local API evaluation, a 132-input conversation regression (126 production-retained inputs plus a six-turn unknown-technology repair), and a 40-query retrieval golden set.
- **Current branch/focus:** `feat/agent-systems-network` — local-only Ollama conversation, grounded agent tools, coherent memory, strict validation, and a private SSH-tunneled preview
- **Continuation status:** Read `docs/current-feature-handoff.md` before editing or deploying this branch. Commit `0e0c606` passed local acceptance but still needs the 132-input live private-preview run; production is unchanged.

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
3. After merge, the sync-staging workflow automatically mirrors to `BradleyMatera/ProjectHub-dev:main`.
4. When validated on staging, open a pull request from `develop` to `master`.
5. After merging to `master`, run `bash deploy-gcp.sh` for the production backend, verify health, then manually trigger the Pages workflow.

**For the full release process, see `PROJECTHUB-DEVELOPMENT-AND-RELEASE-SPEC.md` (canonical release spec).**
For common task details, see `docs/common-tasks.md`.

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

# Run local retrieval tests (BM25 and query understanding)
npm run test:retrieval

# Evaluate retrieval quality against golden set (Recall@k, MRR@k)
npm run eval-retrieval

# Publish changes to GitHub Pages (PRODUCTION)
# 1. Merge release PR to master
# 2. Run: bash deploy-gcp.sh  (deploy + verify backend)
# 3. Manually trigger the "Deploy to GitHub Pages" workflow in GitHub Actions
# 4. Verify the live widget at https://bradleymatera.github.io/ProjectHub/
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
| `server-gemini.js` | Backend server — local Ollama chat, Think Mode, safety, analytics, BM25 retrieval, and memory |
| `lib/rag-chunks.js` | Shared RAG chunk builder — flattens knowledge JSON into retrievable fact chunks |
| `lib/bm25.js` | Okapi BM25 retrieval index — TF saturation, IDF weighting, document-length normalization |
| `lib/rrf.js` | Dependency-free Reciprocal Rank Fusion for local literal, expanded, and contextual BM25 rankings |
| `lib/query-understanding.js` | Query understanding pipeline — normalization, typo correction, intent classification, contextual rewriting |
| `lib/agent-tools.js` | Allowlisted read-only agent tools for portfolio search, project comparison, role matching, and public profile evidence |
| `lib/agent-fallback.js` | Deterministic local agent planning and evidence-based answers |
| `lib/local-conversation.js` | Five-turn local memory shaping and strict Ollama RAG output validation |
| `lib/cost-ledger.js` | Metering tracker for every billable-adjacent event |
| `lib/cost-insights.js` | Cost insights builder for the /api/costs dev endpoint |
| `data/recruiter-knowledge.json` | Canonical bundled knowledge base |
| `data/eval-golden.json` | Golden set of 40 queries for retrieval evaluation |
| `scripts/eval-retrieval.js` | Retrieval evaluation harness — measures Recall@k and MRR@k |
| `scripts/eval-local-api.js` | Local API acceptance harness — 61 requests covering facts, safety, NLP, memory, project references, answer variety, natural dialogue, and unknown-technology feedback |
| `test-production-conversations.py` | Sanitized replay of 126 production-retained inputs plus a six-turn user-reported regression, with semantic quality, local-provider, repetition, privacy, and latency assertions |
| `test/bm25.test.js` | BM25 index unit tests (8 tests) |
| `test/query-understanding.test.js` | Query understanding unit tests (15 tests) |
| `test/agent-tools.test.js` | Read-only agent tool selection, evidence, privacy, and fail-closed tests |
| `test/agent-fallback.test.js` | Local project comparison, role evidence, and interview workflow tests |
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
| `docs/current-feature-handoff.md` | Exact active-branch state, corpus provenance, validation evidence, limitations, and next commands |
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
| **Release, staging, branching, or rollback** | **`PROJECTHUB-DEVELOPMENT-AND-RELEASE-SPEC.md`** |
| **Branch protection or environment setup** | **`docs/branch-protection-setup.md`** |
| Bounded agent tools, Ollama fallback, or private preview | `docs/agent-systems.md` |
| Continue the active local-only feature branch | `docs/current-feature-handoff.md` |
| Understand data flow, hosting, or backend migration | `docs/architecture-overview.md` |
| Add a project, CodePen, suggestion, or update data | `docs/data-guide.md` |
| Add/modify intents, AI fallback, response logic | `docs/api-guide.md` |
| Run, test, publish, or do routine maintenance | `docs/common-tasks.md` |
| Follow naming, file organization, or style rules | `docs/coding-standards.md` |
| Deploy, secure, or monitor the GCP backend | `docs/backend-guide.md` |
| Understand the local AI runtime | `docs/local-ai-runtime.md` |

---

## Table of Contents

1. `PROJECTHUB-DEVELOPMENT-AND-RELEASE-SPEC.md` — Canonical release spec: staging isolation, CI/CD, branch rules, rollback, acceptance tests.
2. `docs/architecture-overview.md` — System design, component relationships, data flow.
3. `docs/coding-standards.md` — Naming conventions, file organization, style rules, and no-build constraints.
4. `docs/common-tasks.md` — Step-by-step workflows for routine development (add project, test locally, publish to GitHub Pages).
5. `docs/data-guide.md` — Schema and update workflow for projects, CodePens, and suggestions.
6. `docs/api-guide.md` — Chat endpoint contract, GitHub API usage, and fallback proxy behavior.
7. `docs/backend-guide.md` — GCP VM deployment, Caddy HTTPS, systemd, environment variables, cost checklist.
8. `docs/local-ai-runtime.md` — Ollama runtime, retrieval, memory, validation, and local learning.
9. `docs/branch-protection-setup.md` — Branch protection rules and GitHub environment configuration.
10. `docs/agent-systems.md` — Local agent tools, constrained Ollama control, and the private SSH-tunneled feature preview.
11. `docs/current-feature-handoff.md` — Current commit, completed evidence, pending live acceptance, and continuation checklist.

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
