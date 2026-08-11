# api-guide.md

**Read when:** You need to understand or change the chat API contract, local-only Ollama RAG, memory, or fallback behavior.

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
  "provider": "cloudflare",
  "model": "@cf/meta/llama-3.2-3b-instruct",
  "grounded": false,
  "fallback": false,
  "cached": false,
  "pipeline": ["cache-miss", "knowledge-loaded", "learned-check:miss", "mustStayGrounded:false", "network:cloudflare:success", "shaped"],
  "followUps": ["What about his AWS certifications?", "Did he do real production work at AWS?"],
  "agent": {
    "used": true,
    "tools": ["search_portfolio", "compare_projects"],
    "steps": 2
  }
}
```

When the question is routed to the deterministic fallback, `provider` is `grounded` and `model` is `knowledge-json`. A validated local conversation reply uses `provider: ollama` and `model: qwen2.5:0.5b`. If Ollama times out or fails validation, the response falls back to the grounded answer. The `pipeline` shows `network:disabled-local-only` and the local RAG outcome. The `followUps` array contains 0-2 contextual suggestions.

The optional `agent` object is present only when Scout completes a bounded tool workflow. It reports the allowlisted read-only tools used and the number of completed steps; raw tool arguments and internal evidence payloads are never returned to the browser.

## Bounded Agent Workflows

Project comparisons, job-description matching, role evidence, recruiter briefs, and interview-question requests use bounded local tools before conversational generation. The orchestration remains inside ProjectHub:

1. `lib/agent-tools.js` selects up to five task-relevant read-only tools and executes them against the verified in-memory knowledge cache.
2. `lib/agent-runtime.js` validates tool names and JSON arguments, caps execution at two rounds and three tool calls, and fails closed on unknown tools.
3. ProjectHub deterministically selects and executes the allowlisted tools; no model or remote provider controls tool access.
4. Local Ollama may choose only `standard` or `brief` for deterministic tool answers. It never rewrites those facts.
5. Open-ended local RAG receives BM25 facts, the grounded draft, up to five recent turns, and prior topic stances.
6. Free-text output is validated for new entities, numbers, hype, source overlap, length, and safety.
7. If local generation cannot produce a valid answer within 15 seconds, the deterministic grounded answer remains the final fallback.

Current tools:

- `search_portfolio` — searches verified projects, experience, skills, and certifications.
- `get_project` — returns one verified project.
- `compare_projects` — compares two to four verified projects.
- `match_role` — matches a job description to verified evidence and honest gaps without making a hiring decision.
- `get_candidate_profile` — returns an allowlisted public profile section; identity/contact data is excluded.

Every local tool execution is recorded in the cost ledger as `agent-local-tools`. No tool makes an external call or persistent write.

## Retrieval Pipeline

The server uses a multi-stage retrieval pipeline to find the most relevant knowledge chunks for each query:

1. **Query understanding** (`lib/query-understanding.js`): Normalizes the query (lowercase, strip punctuation), corrects typos via Damerau-Levenshtein distance against the knowledge vocabulary, classifies intent (role-fit, factual-lookup, experience-detail, contact, smalltalk, meta), and rewrites bare follow-ups using conversation history for context.
2. **BM25 search** (`lib/bm25.js`): Okapi BM25 scoring with TF saturation (k1=1.2), IDF weighting, and document-length normalization (b=0.75). The index is rebuilt whenever the knowledge cache refreshes (~600 chunks, <1ms query).
3. **Dense vector search** (`lib/vector-index.js`, legacy non-local mode only): This path requires an external embedding API and is forcibly disabled when `LOCAL_ONLY_MODE=true`.
4. **Hybrid fusion** (`lib/hybrid-retrieve.js`): When both BM25 and dense results are available, they are fused via Reciprocal Rank Fusion (RRF, k=60) and then diversified via Maximal Marginal Relevance (MMR, λ=0.7). Tag-aware boosting adjusts scores based on classified intent (e.g., role-fit boosts faq/experience tags).

Feature flags:
- `USE_BM25_RETRIEVAL=true` (default) — enables BM25 + query understanding
- `USE_VECTOR_RETRIEVAL=false` (default) — BM25 only; local-only mode cannot enable dense retrieval

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

## Local-only Ollama Runtime

`LOCAL_ONLY_MODE=true` forces the runtime provider order to empty, disables all cloud provider eligibility, loads knowledge from the bundled JSON file, and disables Think Mode GitHub pushes. Open-ended replies use pre-warmed `qwen2.5:0.5b`; factual, agent-tool, safety, timeout, and invalid-generation paths use deterministic grounded output.

The deployment pre-warms Qwen with the same 1,536-token context used by requests and retains it with `keep_alive=-1`. Measured warm multi-turn inference is under the 15-second ceiling; a cold request fails safely while the deterministic path remains available.

Legacy provider definitions remain only for backward compatibility and explicit non-local development. GitHub Models and known retired Groq model IDs remain hard-blocked even outside local-only mode.

## Environment Variables

Key variables on the GCP VM (`.env`):

| Variable | Purpose |
|----------|---------|
| `LOCAL_ONLY_MODE` | Disable every cloud inference provider and runtime knowledge fetch (default `true`) |
| `KNOWLEDGE_FILE` | Bundled local knowledge path (default `data/recruiter-knowledge.json`) |
| `AGENT_ENABLED` | Enable bounded read-only agent workflows (default `true`) |
| `OLLAMA_AGENT_ENABLED` | Allow local Ollama to choose an allowlisted presentation style; never required for correctness (enabled on prepared hosts) |
| `OLLAMA_AGENT_MODEL` | Local conversation/style model (prepared hosts use `qwen2.5:0.5b`) |
| `OLLAMA_AGENT_TIMEOUT_MS` | Optional tool-answer style timeout, clamped to 1-5 seconds (default `2500`); deterministic tools never wait longer |
| `OLLAMA_AGENT_CONTEXT` | Shared local context window, clamped to 512-4096 tokens (default `1536`) |
| `OLLAMA_AGENT_KEEP_ALIVE` | Model retention; local-only deployment uses `-1` after boot-time prewarm |
| `PROVIDER_ORDER` | Empty and ignored in local-only deployments |
| `GEN_MODEL` | Local Ollama conversation model, default `qwen2.5:0.5b` |
| `GEN_TIMEOUT_MS` | Local generation ceiling in ms, clamped to 14.5 seconds (default `14500`), leaving response-shaping room inside the 15-second target |
| `USE_BM25_RETRIEVAL` | Enable BM25 + query understanding retrieval (default `true`) |
| `USE_VECTOR_RETRIEVAL` | Legacy dense retrieval switch; forced off in local-only mode |

## Session Memory

The browser creates a per-tab `sessionId` and keeps 10 turns of conversation context. The local RAG prompt uses the five newest sanitized turns. The backend separately retains up to 12 topic stances for 60 minutes so follow-ups remain consistent; there is no external database dependency.

Context-dependent messages such as “tell me more,” “what about that project,” or “same for AWS” bypass the global response cache so the router can use recent session context.

### Stance Consistency

The server maintains a per-session stance store (`stanceStore`) that records the first sentence of each reply keyed by topic. On subsequent turns, prior stances are injected into the local prompt. This prevents Scout from contradicting itself across turns. The store has a 60-minute TTL and caps at 12 stances per session.

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
