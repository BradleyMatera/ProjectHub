# ProjectHub

ProjectHub is Bradley Matera's embeddable portfolio and recruiter assistant. The browser widget is vanilla JavaScript and GitHub Pages friendly; Scout's backend runs local Ollama inference with grounded retrieval, memory, and read-only evidence tools.

```html
<script src="https://bradleymatera.github.io/ProjectHub/ProjectHub.js"></script>
```

## What Scout does

- Answers questions about Bradley's projects, skills, experience, education, and target roles.
- Corrects common typos and rewrites short follow-ups using recent conversation context.
- Retrieves verified facts with local BM25 search.
- Retains five recent turns plus topic stances for coherent multi-turn conversation.
- Uses deterministic local tools for project comparison, role evidence, recruiter briefs, and interview questions.
- Uses `qwen2.5:0.5b` through local Ollama for natural open-ended phrasing.
- Rejects unsupported generations and returns a useful grounded answer instead.
- Learns locally from weak answers, retaining only validated improvements on disk.

There are no hosted model APIs or model-routing switches in this codebase.

## Architecture

```text
GitHub Pages widget
        |
        v
ProjectHub Express API on free VM
        |
        +-- query understanding
        +-- BM25 over bundled recruiter knowledge
        +-- five-turn memory and stance retention
        +-- deterministic read-only tools
        +-- local Ollama qwen2.5:0.5b
        +-- safety and grounded-output validators
        +-- deterministic fallback
```

The model is intentionally small enough for the free VM. Retrieval, memory, tools, validation, caching, and deterministic fallbacks provide the reliability that raw model size cannot.

## Local development

```bash
npm install
npm test
npm run eval-retrieval
npm run build
node --check server-gemini.js
```

Run Ollama separately with the configured model, copy `.env.development.example` to `.env`, then:

```bash
node server-gemini.js
```

Useful diagnostics:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/diagnose
curl "http://127.0.0.1:3000/api/retrieve?q=what%20did%20he%20build"
```

## Main files

| Path | Purpose |
|---|---|
| `ProjectHub.js` | Single-file embeddable widget artifact |
| `data.js`, `logic.js`, `ui.js`, `utils.js` | Widget source modules |
| `server-gemini.js` | Local AI API, memory, validation, analytics, and learning |
| `data/recruiter-knowledge.json` | Bundled verified recruiter facts |
| `lib/query-understanding.js` | Normalization, typo correction, intent, and contextual rewrite |
| `lib/bm25.js` | Offline lexical retrieval |
| `lib/local-conversation.js` | Prompt memory and generated-answer validation |
| `lib/agent-tools.js` | Read-only evidence tools |
| `lib/agent-fallback.js` | Deterministic local agent planner |
| `agent-preview/` | Private feature-preview frontend |
| `analytics/` | Carbon analytics dashboard source |
| `docs/local-ai-runtime.md` | Runtime design and verification |
| `PROJECTHUB-DEVELOPMENT-AND-RELEASE-SPEC.md` | Canonical release process |

## Private feature preview

Feature branches can be deployed as a loopback-only service on the staging VM:

```bash
bash deploy-agent-preview.sh
bash scripts/open-agent-preview.sh
```

The deploy script requires a clean `feat/*` branch, runs the automated tests, prewarms Ollama, verifies health, and leaves the preview inaccessible without the SSH tunnel.

## Release flow

1. Branch from `develop`.
2. Open a pull request to `develop`.
3. Validate the mirrored staging frontend and dev backend.
4. Open a pull request from `develop` to `master`.
5. Deploy and verify the production backend.
6. Trigger the GitHub Pages workflow.

Do not publish feature work directly to production. See the canonical release specification for acceptance and rollback details.

## Honest capability boundary

Scout is designed to always return a useful response, but no local model can correctly know every fact or perform every task. When verified information is unavailable, Scout says so and redirects to what it can support. It never invents a fact merely to avoid saying “unknown.”
