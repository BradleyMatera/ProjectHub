# Backend Guide

ProjectHub's backend is `server-gemini.js`, deployed as `server.js` on a free GCP e2-micro VM. Caddy terminates HTTPS; Ollama listens only on loopback.

## Runtime files

- `server-gemini.js` — API, memory, retrieval, validation, and learning.
- `lib/` — BM25, query understanding, local tools, conversation memory, and cost tracking.
- `data/recruiter-knowledge.json` — bundled verified facts.
- `learned.json` — locally retained validated improvements.
- `stats.json` and `costs.json` — operational state.

## Required environment

```env
PORT=3000
OLLAMA_URL=http://127.0.0.1:11434
GEN_MODEL=qwen2.5:0.5b
GEN_TIMEOUT_MS=12500
GEN_ENABLED=true
OLLAMA_AGENT_ENABLED=true
OLLAMA_AGENT_MODEL=qwen2.5:0.5b
OLLAMA_AGENT_TIMEOUT_MS=2500
OLLAMA_AGENT_CONTEXT=1536
OLLAMA_AGENT_KEEP_ALIVE=-1
AGENT_ENABLED=true
USE_BM25_RETRIEVAL=true
KNOWLEDGE_FILE=data/recruiter-knowledge.json
STATS_FILE=stats.json
LEARNED_FILE=learned.json
COST_TRACKER=true
COST_FILE=costs.json
```

## Safe verification

```bash
node --check server-gemini.js
npm test
npm run eval-retrieval
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/diagnose
```

For feature work, use `deploy-agent-preview.sh` and `scripts/open-agent-preview.sh`. The preview service binds to `127.0.0.1:3200` and has no public route. Production deployment still follows `PROJECTHUB-DEVELOPMENT-AND-RELEASE-SPEC.md`.
