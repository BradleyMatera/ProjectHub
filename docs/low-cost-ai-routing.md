# low-cost-ai-routing.md

**Read when:** You need to understand how ProjectHub stays 100% free by routing LLM calls through free provider tiers, with grounded knowledge as the final fallback.

---

## Budget Rule

ProjectHub is designed to operate on **zero recurring AI spend**. The only optional cost is the GCP VM, which fits within the Always Free tier. No paid LLM subscriptions or credits are required.

---

## Current Best Architecture

ProjectHub stays grounded-first and free-provider-first:

1. Browser widget calls `https://projecthub-chat.bradleymatera.dev/api/chat` directly from any allowed origin.
2. GCP VM API (`server-gemini.js`) always returns deterministic recruiter-safe answers for factual/profile/project questions.
3. For open-ended questions, the API walks a priority network of free providers:
   - Cloudflare Workers AI (`@cf/meta/llama-3.2-3b-instruct`)
   - Google Gemini (`gemini-3.6-flash`)
   - xAI Grok (`grok-4.3`) optional
   - OpenAI-compatible (configurable) optional
   - Groq optional, disabled by default, with an explicitly configured current model
4. If all free providers are exhausted or fail validation, the API returns a fast, deterministic grounded answer from `data/recruiter-knowledge.json`.
5. Every provider reply is validated against the grounded source facts before it is returned.
6. Safety and false-claim checks run BEFORE learned answers to block injection, XSS, social engineering, and exaggerated claims.
7. In-memory session cache keeps the last 3 turns per tab. Frontend sends 5 turns and keeps 10.
8. Response caches avoid repeated work, but context-dependent follow-ups bypass the global cache.
9. Out-of-scope questions are forced to grounded replies by `mustStayGrounded` to prevent LLM hallucinations.
10. Evidence-heavy requests use deterministic bounded tools over local verified data. An opt-in Groq planner can use the same tools, but it is disabled by default.

This keeps the widget useful even if every free provider tier is temporarily exhausted.

`llama-3.1-8b-instant` was removed from all runtime defaults before its August 16, 2026 shutdown. ProjectHub does not silently replace it with GPT-OSS because Groq's published free allowance drops from 14,400 requests and 500,000 tokens per day for Llama 8B to 1,000 requests and 200,000 tokens per day for current replacements. The default network now begins with Cloudflare. Groq requires `GROQ_ENABLED=true` plus an explicit non-retired `GROQ_MODEL`; `lib/model-policy.js` blocks known retired model IDs even when an old environment still names one.

Groq is not a single point of failure for agent workflows. ProjectHub deterministically selects and executes local knowledge tools. `OLLAMA_AGENT_ENABLED=true` may use the already-installed local Ollama engine to choose an allowlisted presentation style, but the small local model never writes the factual answer. If local control fails, the deterministic answer is returned directly. General conversation continues through Cloudflare Workers AI, Gemini, Grok, and the grounded fallback.

GitHub Models was removed from the active network after its July 30, 2026 retirement. `lib/model-policy.js` hard-blocks the legacy provider definition so a stale environment cannot make retired inference calls. Gemini 2.0 Flash was also replaced with Google's documented stable replacement, `gemini-3.6-flash`.

---

## Netlify Usage

Netlify remains the DNS host for `bradleymatera.dev` and `bradleymatera.github.io` serves the widget landing page. No Netlify Functions or paid Netlify AI tokens are required:

- The widget calls the GCP backend directly from the browser.
- Session memory lives in the GCP backend process; no external database is needed.
- Quota enforcement and cooldowns are handled inside `server-gemini.js`.
- No paid AI polishing path is used; all generative responses come from free providers, with the grounded knowledge base as the final fallback.

---

## Google Cloud Spend

The backend is intended to run on a GCP Always Free `e2-micro` instance with no monthly compute bill. The grounded fallback requires no LLM calls and no local model, so it keeps the VM small and predictable.

Safer options:

- Keep the Always Free VM as the default backend.
- Add Google Cloud budget alerts at `$5`, `$10`, and `$20` as guardrails.
- If testing a larger VM, run it only on demand and stop it automatically.
- Avoid running large local models; rely on the free provider network and the grounded fallback instead.

---

## Think Mode Cost

Think Mode runs every 20 minutes and processes up to 3 stashed questions per cycle through the same free provider network. It adds zero cost because:
- It uses the same free LLM providers (no additional API calls beyond what the daily quota allows)
- The grounded knowledge base is the final fallback (no LLM charges)
- It pushes learned answers back to GitHub via the Contents API (free, no database)
- False-claim, safety, out-of-scope, and meta questions are filtered before stashing (no wasted LLM calls)
- The `learned.json` file on the VM is tiny (a few KB)

---

## Routing Policy

The multi-provider router tries each enabled provider in `PROVIDER_ORDER` until one returns a valid reply:

- Skip providers that are exhausted or in cooldown.
- Skip providers whose daily quota has been reached.
- Build a RAG prompt from the grounded knowledge JSON and recent session context.
- Validate every reply against anti-slop, false-claim, and number-check rules using the full prompt as the source.
- If a provider call fails or returns an invalid reply, mark it (rate-limit = 60s cooldown, credit exhaustion = 24h cooldown) and try the next provider.
- If no provider succeeds, return the grounded answer.

Deterministic/factual questions bypass the network entirely and return the grounded answer immediately to save quota and latency. The `mustStayGrounded` function enforces this for 15+ categories of questions including role fit, experience, work style, interpersonal skills, safety patterns, false-claim patterns, out-of-scope questions, and meta questions about the bot.

---

## Retrieval Pipeline Cost

The retrieval pipeline is designed to add zero recurring cost:

- **BM25 index** (`lib/bm25.js`): Pure in-memory, no external calls. Built once per knowledge cache refresh (~600 chunks, <50ms build, <1ms query). Default mode.
- **Query understanding** (`lib/query-understanding.js`): Pure JS heuristic — normalization, typo correction via Damerau-Levenshtein, intent classification via regex, contextual rewriting via history. No LLM calls. <1ms CPU.
- **Dense vector retrieval** (`lib/vector-index.js`, optional): When `USE_VECTOR_RETRIEVAL=true`, query embeddings are fetched from Cloudflare Workers AI free tier (`@cf/baai/bge-small-en-v1.5`, 50-150ms per call). Pre-built chunk embeddings are generated at build time via `npm run build:embeddings` and committed to `data/knowledge-vectors.json`. No runtime cost for chunk embeddings.
- **Hybrid fusion** (`lib/hybrid-retrieve.js`): Pure in-memory RRF + MMR computation. <2ms CPU.
- **Semantic cache**: When dense retrieval is enabled, paraphrased queries are deduplicated via embedding cosine similarity (≥0.92). On a cache hit, the entire retrieval + LLM pipeline is skipped, saving both latency and provider quota. LRU, 200 entries, 10-min TTL.
- **Stance consistency store**: Pure in-memory, no external calls. Per-session topic stances, 30-min TTL.

**Build-time embeddings** via `npm run build:embeddings` use Cloudflare Workers AI free tier to batch-embed ~600 chunks in <10 seconds. The script also embeds intent-centroid example sets. Output: `data/knowledge-vectors.json` and `data/intent-centroids.json` (committed to repo).

**Total added latency per message**: ~0ms (BM25-only mode), ~150ms typical (hybrid mode with embedding call), often less with semantic cache hits.
