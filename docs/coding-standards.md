# coding-standards.md

**Read when:** You need naming conventions, file organization, style rules, or constraints for this repository.

---

## File Organization

- Keep the root flat for the CDN entry point: `ProjectHub.js` must be at repo root so GitHub Pages serves it at the expected URL.
- Put detailed documentation in `docs/`.
- Put shared source modules at root: `data.js`, `logic.js`, `ui.js`, `utils.js`.
- Put shared backend modules in `lib/` — these are `require()`d by `server-gemini.js` and `scripts/`.
- Put unit tests in `test/` — one `test/*.test.js` file per `lib/` module.
- Put build-time and evaluation tools in `scripts/` — not loaded at runtime.
- Put generated data artifacts in `data/` — `knowledge-vectors.json`, `intent-centroids.json`, `eval-golden.json`.
- `ProjectHub.js` is the inlined/concatenated deployment artifact. When you edit a source module, mirror the change in `ProjectHub.js` if it is still the live distribution file.
- `server-gemini.js` is the backend server. It is deployed to the VM as `server.js`. Edit `server-gemini.js` in the repo, then deploy.
- Test suites live in `/tmp/test-suite-*.py` and run against the live API. Run them sequentially with delays to avoid 429 rate limits.

## Naming Conventions

- Files: kebab-case for docs (`architecture-overview.md`), camelCase for JS modules (`ProjectHub.js`, `data.js`).
- Functions: camelCase, descriptive verbs (`handleQuery`, `fetchGitHubRepoData`, `setupChatUI`).
- Variables: camelCase; use `const` by default, `let` when reassignment is needed.
- DOM ids: kebab-case (`chat-output`, `chat-input`, `loading-icon`).

## Style Rules

- Vanilla JavaScript only. No frameworks, no TypeScript, no build tools.
- Use semicolons.
- Prefer `async/await` over promise chains.
- Use template literals for HTML strings.
- Avoid global pollution; expose globals only where required for embeddability (`setupChatUI`, `handleQuery`, etc.).
- Inline styles are acceptable because the widget is self-contained and must work without external CSS.

## No-Build Constraints

- Do not add a bundler (Webpack, Vite, Rollup, etc.).
- Do not add JSX/TSX.
- `package.json` is for metadata only. The backend calls all providers with vanilla `fetch`; no OpenAI SDK is required in production.
- The widget must run when loaded via `https://bradleymatera.github.io/ProjectHub/ProjectHub.js`.
- `index.html` is the public GitHub Pages landing site; use `local-test.html` for local widget testing.
- `server-gemini.js` must pass `node --check` before deployment.
- `data/recruiter-knowledge.json` must be valid JSON — verify with `python3 -c "import json; json.load(open('data/recruiter-knowledge.json'))"` before pushing.

## lib/ Module Conventions

- Start with `'use strict';`
- Export via `module.exports = { ... }` at the bottom
- Pure JS, no npm dependencies (except what's already in `package.json`)
- Prefer <200 lines; split into a new module if larger
- Each `lib/` module should have a corresponding `test/*.test.js` file
- No side effects on require — only on explicit function calls

## test/ Directory Rules

- Tests use Node.js built-in test runner: `const { test } = require('node:test')` + `const assert = require('node:assert/strict')`
- Naming: `test/<module-name>.test.js` (e.g., `test/bm25.test.js` for `lib/bm25.js`)
- Run with: `node --test test/<file>.test.js` or `npm run test:retrieval`
- Each test file should cover: happy path, edge cases, error handling
- Tests must be self-contained — no network calls, no file system reads beyond the test fixture

## scripts/ Conventions

- `scripts/*.js` are one-off build/eval tasks, not loaded at runtime by the server
- Must be runnable via `node scripts/<name>.js`
- Add a corresponding `package.json` script entry (e.g., `"build:embeddings": "node scripts/build-embeddings.js"`)
- May require env vars — document them in `.env.development.example` and `.env.production.example`
- Must handle missing env vars gracefully with a clear error message

## Documentation Rule

When changing a feature, update the relevant `docs/` guide and `AGENTS.md` if navigation/quick-reference info changes.
