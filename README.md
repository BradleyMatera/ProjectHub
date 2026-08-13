# ProjectHub

ProjectHub is Bradley Matera's embeddable portfolio and recruiter assistant. The browser widget is vanilla JavaScript and GitHub Pages friendly. Scout's backend is being developed as a cloud-hosted generative AI replacement for the existing website chatbot (Groq-hosted Llama 8B, retiring August 16, 2026). The backend provides grounded retrieval, memory, validation, and orchestration with generative inference.

```html
<script src="https://bradleymatera.github.io/ProjectHub/ProjectHub.js"></script>
```

## What Scout does

- Answers questions about Bradley's projects, skills, experience, education, and target roles.
- Corrects common typos and rewrites short follow-ups using recent conversation context.
- Retrieves verified facts with local BM25 search.
- Fuses multiple local BM25 views with RRF for context-dependent follow-ups while leaving stronger standalone rankings unchanged.
- Retains five recent turns plus topic stances for coherent multi-turn conversation.
- Uses deterministic read-only tools for evidence gathering (project comparison, role matching, profile lookup).
- Uses `qwen2.5:1.5b` via Ollama as the development/evaluation inference runtime for natural conversational phrasing.
- Validates all generated answers for factual accuracy, entity correctness, polarity, and safety.
- Target architecture: cloud-hosted backend with generative inference for 100% of user-visible chat replies.
- Future optimization: capable browsers may use WebGPU-assisted generation; incapable browsers use cloud generation.

The cloud backend remains authoritative for RAG, state, evidence, validation, and orchestration regardless of where generation occurs.

## Architecture

```text
GitHub Pages widget
        |
        v
ProjectHub Express API (cloud-hosted, Docker-containerized)
        |
        +-- query understanding
        +-- BM25 over bundled recruiter knowledge
        +-- five-turn memory and stance retention
        +-- deterministic read-only evidence tools
        +-- generative inference (qwen2.5:1.5b via Ollama in dev/test)
        +-- safety and grounded-output validators
        +-- generative recovery contracts (no deterministic final prose)
```

The inference layer is behind an adapter boundary (`lib/local-model-router.js`) so the backend can switch between local Ollama (development), cloud inference (production), or browser WebGPU without rewriting the harness.

## Docker (production-parity testing)

```bash
# Build and start the full stack (API + inference)
docker compose up --build -d

# Wait for health
curl http://localhost:3000/health

# Run tests against the containerized API
docker compose run --rm test-runner npm test
```

See `docker-compose.yml` and `Dockerfile` for the production-equivalent container stack.

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
| `lib/rrf.js` | Contextual reciprocal-rank fusion over local BM25 rankings |
| `lib/local-conversation.js` | Prompt memory and generated-answer validation |
| `lib/agent-tools.js` | Read-only evidence tools |
| `lib/agent-fallback.js` | Deterministic local agent planner |
| `agent-preview/` | Private feature-preview frontend |
| `analytics/` | Carbon analytics dashboard source |
| `docs/local-ai-runtime.md` | Runtime design and verification |
| `docs/current-feature-handoff.md` | Current branch state, evidence, limitations, and exact continuation steps |
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

The current feature branch's exact test evidence and unfinished private-preview acceptance are recorded in `docs/current-feature-handoff.md`.

## Honest capability boundary

Scout is designed to always return a useful response, but no local model can correctly know every fact or perform every task. When verified information is unavailable, Scout says so and redirects to what it can support. It never invents a fact merely to avoid saying “unknown.”
