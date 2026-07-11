# api-guide.md

**Read when:** You need to understand or change the chat API contract, the free multi-provider LLM router, or AI fallback behavior.

---

## Backend overview

The production backend is `server-gemini.js`, a Node.js/Express app running on a GCP VM free tier. It serves:

- `GET /` — service status.
- `GET /health` — provider order, per-provider quota/cooldown status, learning system stats, recent sessions.
- `GET /api/knowledge-health` — knowledge base coverage report, learned answers, gap clusters, learning verification.
- `POST /api/chat` — the main recruiter chat endpoint.
- `POST /api/think` — manually trigger think mode to process stashed questions.

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
  "history": [
    { "user": "recent user question", "assistant": "recent assistant answer" }
  ],
  "options": {
    "memoryEnabled": true,
    "flavorEnabled": true,
    "visitorName": "Jordan"
  }
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
  "grounded": false,
  "fallback": false,
  "cached": false,
  "pipeline": ["cache-miss", "knowledge-loaded", "learned-check:miss", "mustStayGrounded:false", "network:groq:success", "shaped"],
  "followUps": ["What about his AWS certifications?", "Did he do real production work at AWS?"]
}
```

When the question is routed to the deterministic fallback, `provider` is `grounded` and `model` is `knowledge-json`. When the multi-provider network succeeds, `provider` and `model` reflect the winning provider. If every provider fails, the response falls back to the grounded answer and `fallback` is `true`. The `pipeline` array shows the exact decision path. The `followUps` array contains 0-2 contextual follow-up suggestions.

## Safety and False-Claim Checks

In `buildGroundedFallbackPayload`, the check order is:

1. **Safety regex** — blocks prompt injection, XSS, social engineering, secret extraction, data exfiltration attempts
2. **False-claim regex** — refuses requests to describe Bradley as senior/10x/rockstar/ninja/wizard/guru/world-class, or to write exaggerated claims. Returns an honest alternative instead.
3. **Learned answers** — checks GitHub knowledge `learnedAnswers` array for matching questions
4. **Grounded handlers** — 40+ deterministic handlers for common recruiter questions

This ordering ensures that even if a false-claim answer was accidentally learned by Think Mode, it is always blocked by the false-claim regex before the learned answer is returned.

The `mustStayGrounded` function determines whether a question should skip the LLM network entirely and use the grounded answer. It returns `true` for:
- Safety/injection patterns
- False-claim patterns
- Role fit, experience, work history questions
- Work style, coding style, problem-solving, learning style
- Interpersonal/social skills, customer service
- Smoke tests, greetings, meta questions
- Out-of-scope questions (not recruiter-related)
- Interview questions, banned buzzwords
- Repair/refinement requests ("shorter", "more honest", "just the facts")

The browser should treat `reply` as the primary answer. The current widget renders it directly in the chat transcript.

## Multi-Provider LLM Network

Open-ended questions are routed through a priority network of free providers:

1. **Groq** (`llama-3.1-8b-instant`)
2. **Cloudflare Workers AI** (`@cf/meta/llama-3.2-3b-instruct`)
3. **GitHub Models** (`openai/gpt-4o-mini`)
4. **Google Gemini** (`gemini-2.0-flash`)
5. **xAI Grok** (`grok-4.3`) — optional, free credits can be exhausted quickly
6. **OpenAI-compatible** (configurable) — optional, for custom endpoints

If every free provider is unavailable or the reply fails validation, the final fallback is a fast, deterministic grounded answer from `data/recruiter-knowledge.json`.

The order is controlled by `PROVIDER_ORDER` in the VM `.env`.

### Free-tier limit handling

Each provider has its own free-tier rules, and those rules can change. The backend is designed to tolerate that:

- **Daily caps** are tracked per provider in memory (`*_DAILY_LIMIT` env vars, or sensible defaults).
- **Rate-limit errors (429 / "too many requests")** pause the provider for 60 seconds.
- **Credit exhaustion / permission errors (402, 403, "credits", "spending limit")** pause the provider for 24 hours.
- **Invalid keys / auth failures (401)** are treated as a long-term exhaustion so the router stops wasting time on a dead provider.
- **Network timeouts** per provider are bounded by `GEN_TIMEOUT_MS` (default 8000 ms) so one slow provider does not blow the 15-second total budget.

If provider A is paused or exhausted, the router immediately tries provider B. If every free provider is unavailable or the reply fails validation, the deterministic grounded answer from `data/recruiter-knowledge.json` is returned. This layered fallback lets Scout stay online 24/7 without paid AI.

For every provider call, the backend sends a RAG prompt built from `recruiter-knowledge.json` and recent session context. The returned text is validated against the source facts to block slop, false claims, overclaiming, and invented numbers. If no provider produces a valid reply, the deterministic grounded answer is returned.

The `/health` endpoint exposes current provider order, enabled status, daily quota usage, and cooldown state.

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
| `OPENAI_API_KEY` | OpenAI-compatible API key (optional) |
| `OPENAI_BASE_URL` | OpenAI-compatible base URL (optional) |
| `OPENAI_MODEL` | OpenAI-compatible model name (optional) |
| `PROVIDER_ORDER` | Comma-separated provider slugs, e.g. `groq,cloudflare,github,gemini,grok,ollama` |
| `GEN_MODEL` | Local Ollama fallback model, default `smollm2:135m` |
| `GEN_TIMEOUT_MS` | Per-provider timeout in ms, default `8000` |

## Session Memory

The browser creates a per-tab `sessionId` and sends the last 5 turns as `history`. The GCP backend keeps only the last three turns per session in memory; there is no external database dependency. The frontend keeps 10 turns of conversation context.

Context-dependent messages such as “tell me more,” “what about that project,” or “same for AWS” bypass the global response cache so the router can use recent session context.

The widget asks for the visitor's name at the start of each browser tab session and stores it in `sessionStorage`. Clear Memory resets the local transcript, session id, captured name, and recent browser context.

Repeated or semantically repeated questions should not return the same answer verbatim. The backend checks recent session memory; if the same core question has already been answered, it politely says so, quotes the useful part of the earlier answer, and offers follow-ups. Forced-choice recruiter questions such as “if you had to pick one strongest role” resolve to one answer instead of cycling through target-role lists.

Profile-adjacent personal questions that are not in verified data, such as favorite food or hobbies, are forced to the grounded "not in recruiter data" reply by `mustStayGrounded`, preventing LLM hallucinations on out-of-scope topics.

## Security Requirements

- Accept requests only from allowed origins via CORS.
- Run HTTPS.
- Do **not** expose `localhost:11434` to the internet.
- Keep all API keys in the VM `.env` file; never commit them to the repo.
