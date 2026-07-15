# api-guide.md

**Read when:** You need to understand or change the chat API contract, the free multi-provider LLM router, or AI fallback behavior.

---

## Backend overview

The production backend is `server-gemini.js`, a Node.js/Express app running on a GCP VM free tier. It serves:

- `GET /` — service status.
- `GET /health` — provider order, per-provider quota/cooldown status, learning system stats (including semantic cache size, stance store size, providers recently recovered), recent sessions.
- `GET /api/knowledge-health` — knowledge base coverage report, learned answers, gap clusters, learning verification.
- `GET /api/retrieve?q=...` — dev-only retrieval testing endpoint. Returns rewritten query, normalized query, classified intent, BM25 results, dense results (when enabled), fused results, and legacy results for comparison.
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

When the question is routed to the deterministic fallback, `provider` is `grounded` and `model` is `knowledge-json`. When the multi-provider network succeeds, `provider` and `model` reflect the winning provider. If every provider fails, the response falls back to the grounded answer and `fallback` is `true`. The `pipeline` array shows the exact decision path, including `semantic-cache-hit` when a paraphrase match is found. The `followUps` array contains 0-2 contextual follow-up suggestions.

## Retrieval Pipeline

The server uses a multi-stage retrieval pipeline to find the most relevant knowledge chunks for each query:

1. **Query understanding** (`lib/query-understanding.js`): Normalizes the query (lowercase, strip punctuation), corrects typos via Damerau-Levenshtein distance against the knowledge vocabulary, classifies intent (role-fit, factual-lookup, experience-detail, contact, smalltalk, meta), and rewrites bare follow-ups using conversation history for context.
2. **BM25 search** (`lib/bm25.js`): Okapi BM25 scoring with TF saturation (k1=1.2), IDF weighting, and document-length normalization (b=0.75). The index is rebuilt whenever the knowledge cache refreshes (~600 chunks, <1ms query).
3. **Dense vector search** (`lib/vector-index.js`, optional): When `USE_VECTOR_RETRIEVAL=true`, the rewritten query is embedded via Cloudflare Workers AI (`@cf/baai/bge-small-en-v1.5`, 384-d) and compared against pre-built chunk embeddings using brute-force cosine similarity.
4. **Hybrid fusion** (`lib/hybrid-retrieve.js`): When both BM25 and dense results are available, they are fused via Reciprocal Rank Fusion (RRF, k=60) and then diversified via Maximal Marginal Relevance (MMR, λ=0.7). Tag-aware boosting adjusts scores based on classified intent (e.g., role-fit boosts faq/experience tags).

Feature flags:
- `USE_BM25_RETRIEVAL=true` (default) — enables BM25 + query understanding
- `USE_VECTOR_RETRIEVAL=false` (default) — enables dense retrieval + hybrid fusion (requires pre-built embeddings)

### `/api/retrieve` Dev Endpoint

```bash
curl 'https://dev.projecthub-chat.bradleymatera.dev/api/retrieve?q=what+is+his+tech+stack'
```

Returns:
```json
{
  "ok": true,
  "query": "what is his tech stack",
  "rewritten": "what is his tech stack",
  "normalized": "what is his tech stack",
  "intent": "factual-lookup",
  "bm25": [{ "tag": "skills-web", "text": "...", "score": 3.21 }],
  "dense": [],
  "fused": [],
  "legacy": [{ "tag": "skills-web", "text": "...", "score": 2.0 }]
}
```

Pass history for contextual rewriting: `&h=[{"user":"tell me about his projects","assistant":"..."}]`

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
| `USE_BM25_RETRIEVAL` | Enable BM25 + query understanding retrieval (default `true`) |
| `USE_VECTOR_RETRIEVAL` | Enable dense vector retrieval + hybrid fusion (default `false`, requires pre-built embeddings) |
| `EMBEDDING_MODEL` | Cloudflare Workers AI embedding model (default `@cf/baai/bge-small-en-v1.5`) |
| `SEMANTIC_CACHE_THRESHOLD` | Cosine similarity threshold for semantic cache hits (default `0.92`) |

## Session Memory

The browser creates a per-tab `sessionId` and sends the last 5 turns as `history`. The GCP backend keeps only the last three turns per session in memory; there is no external database dependency. The frontend keeps 10 turns of conversation context.

Context-dependent messages such as “tell me more,” “what about that project,” or “same for AWS” bypass the global response cache so the router can use recent session context.

### Stance Consistency

The server maintains a per-session stance store (`stanceStore`) that records the first sentence of each reply keyed by topic. On subsequent turns, prior stances are injected into the LLM prompt as `YOUR PRIOR STANCE ON THESE TOPICS (stay consistent, don't contradict)`. This prevents Scout from contradicting itself across turns. The store has a 30-min TTL and caps at 8 stances per session.

### Semantic Cache

When vector retrieval is enabled, the server maintains a semantic cache (`semanticCache`) that deduplicates paraphrased queries. Query embeddings are compared via cosine similarity (≥`SEMANTIC_CACHE_THRESHOLD`, default 0.92). On a cache hit, the cached reply is served immediately without running the retrieval pipeline or LLM network. LRU, 200 entries, 10-min TTL. Only active for no-history queries (paraphrase dedup doesn't work mid-conversation).

The widget asks for the visitor's name at the start of each browser tab session and stores it in `sessionStorage`. Clear Memory resets the local transcript, session id, captured name, and recent browser context.

Repeated or semantically repeated questions should not return the same answer verbatim. The backend checks recent session memory; if the same core question has already been answered, it politely says so, quotes the useful part of the earlier answer, and offers follow-ups. Forced-choice recruiter questions such as “if you had to pick one strongest role” resolve to one answer instead of cycling through target-role lists.

Profile-adjacent personal questions that are not in verified data, such as favorite food or hobbies, are forced to the grounded "not in recruiter data" reply by `mustStayGrounded`, preventing LLM hallucinations on out-of-scope topics.

## Security Requirements

- Accept requests only from allowed origins via CORS.
- Run HTTPS.
- Do **not** expose `localhost:11434` to the internet.
- Keep all API keys in the VM `.env` file; never commit them to the repo.
