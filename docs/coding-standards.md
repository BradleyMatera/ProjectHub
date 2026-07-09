# coding-standards.md

**Read when:** You need naming conventions, file organization, style rules, or constraints for this repository.

---

## File Organization

- Keep the root flat for the CDN entry point: `ProjectHub.js` must be at repo root so GitHub Pages serves it at the expected URL.
- Put detailed documentation in `docs/`.
- Put shared source modules at root: `data.js`, `logic.js`, `ui.js`, `utils.js`.
- `ProjectHub.js` is the inlined/concatenated deployment artifact. When you edit a source module, mirror the change in `ProjectHub.js` if it is still the live distribution file.

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
- `package.json` is for metadata only. The `openai` dependency is not currently used in the browser code.
- The widget must run when loaded via `https://bradleymatera.github.io/ProjectHub/ProjectHub.js`.

## Documentation Rule

When changing a feature, update the relevant `docs/` guide and `AGENTS.md` if navigation/quick-reference info changes.
