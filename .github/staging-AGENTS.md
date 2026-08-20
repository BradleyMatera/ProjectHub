# AGENTS.md — ProjectHub-dev

This is the **staging repository** for ProjectHub/Scout. It publishes to `https://bradleymatera.github.io/ProjectHub-dev/` via GitHub Pages.

## Important Rules

- The **source of truth** for code, documentation, and the knowledge base is `BradleyMatera/ProjectHub`.
- This repo is a **read-only deployment target**. It receives prepared staging trees from the `develop` branch of `BradleyMatera/ProjectHub`.
- Do **not** edit code directly in this repository. Make changes in `BradleyMatera/ProjectHub` first, then prepare and push a staging tree here.
- Any environment-specific files (e.g., dev deploy scripts, staging env templates) may live here, but they must not contain secrets.

## Staging tree preparation

A raw force-push of `ProjectHub/develop` to `ProjectHub-dev/main` is **prohibited**. The staging tree must be a prepared wrapper commit that contains:

1. `AGENTS.md` — this file (the staging-specific instructions).
2. `.github/workflows/pages.yml` — the staging workflow that triggers on `main`.
3. `STAGING-SOURCE.json` — a generated marker with:
   - `sourceRepository`
   - `sourceBranch`
   - `sourceCommit`
   - `generatedBy`
4. The rest of the `ProjectHub/develop` source tree at the intended commit, unchanged.

Then create the wrapper commit and force-push **that staging tree** to `BradleyMatera/ProjectHub-dev:main`.

## Workflow

1. Feature work happens in `BradleyMatera/ProjectHub` on a branch off `develop`.
2. Merge into `BradleyMatera/ProjectHub:develop`.
3. Prepare the staging tree from the intended `ProjectHub/develop` commit:
   - `cp .github/staging-AGENTS.md AGENTS.md`
   - `cp .github/staging-pages.yml .github/workflows/pages.yml`
   - generate `STAGING-SOURCE.json`
4. Commit as a staging wrapper commit.
5. Force-push the wrapper tree to `BradleyMatera/ProjectHub-dev:main`.
6. GitHub Pages rebuilds the staging site automatically.
7. Verify `STAGING-SOURCE.json`, the Pages workflow, `AGENTS.md`, and the live staging URL.
8. When validated, open a pull request from `develop` to `master` in `BradleyMatera/ProjectHub`.

## Dev Environment Differences

- Widget and page title show `(dev)` branding.
- **Widget loads locally** from `./ProjectHub.js` (not from the production CDN).
- **API calls go to** `https://dev.projecthub-chat.bradleymatera.dev` (set via `window.__PROJECTHUB_CHAT_API__`).
- Analytics dashboard is available on both sites, but the dev site shows the full operational view.
- The dev backend uses isolated data files and does not affect production.
- **Think Mode is removed.** There is no autonomous self-improvement or background learning loop.

## Runtime Architecture

- **Scout** is the portable intelligence/orchestration engine.
- **ProjectHub Recruiter Alpha** is the app powered by Scout.
- Primary inference for staging is **Cloudflare Workers AI** (`@cf/meta/llama-3.2-3b-instruct`).
- Ollama is for dev/test only; it is **not** qualified for production.
- Runtime JS never authors normal chatbot prose.
- Every user-visible reply carries a `proseSource` of `DIRECT_KB`, `MODEL_GENERATION`, or `TECHNICAL_ERROR`.
- There is **no deterministic chatbot fallback prose**.
- Default release mode is `SCOUT_AGENT_MODE=lite`.

## For Full Documentation

See `AGENTS.md` and `docs/common-tasks.md` in `BradleyMatera/ProjectHub`.
