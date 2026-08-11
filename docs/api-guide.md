# Chat API Guide

The Express backend in `server-gemini.js` runs on the ProjectHub VM and performs inference only through local Ollama.

## Endpoints

- `POST /api/chat` — answer a visitor message.
- `GET /health` — runtime, memory, retrieval, learning, and local model status.
- `GET /api/diagnose` — live Ollama generation and validation probe.
- `GET /api/retrieve?q=...` — local query-understanding and BM25 diagnostic.
- `POST /api/think` — run one bounded local learning cycle.
- `GET /api/knowledge-health` — coverage and learning diagnostics.
- `GET /api/stats`, `/api/chat-log`, and `/api/costs` — operational telemetry.

## Chat request

```json
{
  "message": "Which project best demonstrates debugging?",
  "sessionId": "per-tab-id",
  "history": [
    { "user": "What is Bradley strongest at?", "assistant": "..." }
  ]
}
```

History is trimmed and sanitized. The frontend may send ten turns; the answer prompt uses the five most recent turns.

## Chat response

```json
{
  "reply": "Bradley's strongest debugging evidence is ...",
  "provider": "ollama",
  "model": "qwen2.5:0.5b",
  "grounded": false,
  "fallback": false,
  "pipeline": ["cache-miss", "knowledge-loaded", "local-rag:ollama:validated", "shaped"],
  "local": {
    "only": true,
    "memoryTurns": 2,
    "stanceTopics": 1,
    "model": "qwen2.5:0.5b"
  }
}
```

For evidence-heavy requests, `provider` is `local-agent`. When a generated draft fails, `provider` is `grounded`.

## Correctness contract

Safety and false-claim checks run before generation. BM25 retrieval, bounded memory, stance retention, read-only tools, and generated-output validators all operate locally. A deterministic grounded answer is always ready, so an Ollama timeout does not become an empty response.
