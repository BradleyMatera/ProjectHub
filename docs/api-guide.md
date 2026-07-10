# api-guide.md

**Read when:** You need to understand or change the chat API contract, the free multi-provider LLM router, or AI fallback behavior.

---

## Backend overview

The production backend is `server-gemini.js`, a Node.js/Express app running on a GCP VM free tier. It serves:

- `GET /` — service status.
- `GET /health` — provider order, per-provider quota/cooldown status, and configuration.
- `POST /api/chat` — the main recruiter chat endpoint.

The frontend widget (`ProjectHub.js`) is vanilla JavaScript and loads the backend endpoint from the published GitHub Pages URL. No build step or framework is required on either side.

## Recruiter Chat API Contract

Current production URL:

```text
POST https://projecthub-chat.bradleymatera.dev/api/chat
Content-Type: application/json
```

Request body:

```json
{
  "message": "user's raw query",
  "sessionId": "stable browser session id",
  "options": {
    "memoryEnabled": true,
    "flavorEnabled": true,
    "visitorName": "Jordan"
  },
  "context": [
    { "role": "user", "content": "recent user question" },
    { "role": "assistant", "content": "recent assistant answer" }
  ]
}
```

To clear session memory, the widget sends:

```json
{
  "action": "clearMemory",
  "sessionId": "stable browser session id"
}
```

Response body:

```json
{
  "reply": "Recruiter-safe answer text",
  "provider": "groq",
  "model": "llama-3.1-8b-instant",
  "fallback": false,
  "cached": false
}
```

When the question is routed to the deterministic fallback, `provider` is `grounded` and `model` is `knowledge-json`. When the multi-provider network succeeds, `provider` and `model` reflect the winning provider. If every provider fails, the response falls back to the grounded answer and `fallback` is `true`.

The browser should treat `reply` as the primary answer. The current widget renders it directly in the chat transcript.

## Multi-Provider LLM Network

Open-ended questions are routed through a priority network of free providers:

1. **Groq** (`llama-3.1-8b-instant`)
2. **Cloudflare Workers AI** (`@cf/meta/llama-3.2-3b-instruct`)
3. **GitHub Models** (`openai/gpt-4o-mini`)
4. **Google Gemini** (`gemini-2.0-flash`)
5. **Local Ollama** (`smollm2:135m`) final fallback

The order is controlled by `PROVIDER_ORDER` in the VM `.env`. Each provider has a daily request limit and is paused for 60 seconds on rate-limit errors or for 24 hours on credit-exhaustion errors. The `/health` endpoint exposes current quota usage and cooldown status.

For every provider call, the backend sends a RAG prompt built from `recruiter-knowledge.json` and recent session context. The returned text is validated against the source facts to block slop, false claims, overclaiming, and invented numbers. If no provider produces a valid reply, the deterministic grounded answer is returned.

## Environment Variables

Key variables on the GCP VM (`.env`):

| Variable | Purpose |
|----------|---------|
| `GROQ_API_KEY` | Groq API key |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Workers AI token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `GITHUB_MODELS_TOKEN` | GitHub personal access token with `models:read` |
| `GEMINI_API_KEY` | Google Gemini API key |
| `XAI_API_KEY` | xAI Grok API key |
| `PROVIDER_ORDER` | Comma-separated provider slugs, e.g. `groq,cloudflare,github,gemini,grok,ollama` |
| `GEN_MODEL` | Local Ollama fallback model, default `smollm2:135m` |
| `GEN_TIMEOUT_MS` | Per-provider timeout in ms, default `8000` |

## Session Memory

The browser creates a per-tab `sessionId` and sends the last few turns as `context`. The GCP backend keeps only the last three turns per session in memory; there is no external database dependency.

Context-dependent messages such as “tell me more,” “what about that project,” or “same for AWS” bypass the global response cache so the router can use recent session context.

The widget asks for the visitor's name at the start of each browser tab session and stores it in `sessionStorage`. Clear Memory resets the local transcript, session id, captured name, and recent browser context.

Repeated or semantically repeated questions should not return the same answer verbatim. The backend checks recent session memory; if the same core question has already been answered, it politely says so, quotes the useful part of the earlier answer, and offers follow-ups. Forced-choice recruiter questions such as “if you had to pick one strongest role” resolve to one answer instead of cycling through target-role lists.

Profile-adjacent personal questions that are not in verified data, such as favorite food or hobbies, go through the guarded generative fallback. The model may phrase the response naturally, but it must not invent personal facts; it should say the detail is not verified and bridge to recruiter-useful topics.

## Security Requirements

- Accept requests only from allowed origins via CORS.
- Run HTTPS.
- Do **not** expose `localhost:11434` to the internet.
- Keep all API keys in the VM `.env` file; never commit them to the repo.
