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
   - Groq (`llama-3.1-8b-instant`)
   - Cloudflare Workers AI (`@cf/meta/llama-3.2-3b-instruct`)
   - GitHub Models (`openai/gpt-4o-mini`)
   - Google Gemini (`gemini-2.0-flash`)
   - xAI Grok (`grok-4.3`) optional
   - OpenAI-compatible (configurable) optional
4. If all free providers are exhausted or fail validation, the API returns a fast, deterministic grounded answer from `data/recruiter-knowledge.json`.
5. Every provider reply is validated against the grounded source facts before it is returned.
6. Safety and false-claim checks run BEFORE learned answers to block injection, XSS, social engineering, and exaggerated claims.
7. In-memory session cache keeps the last 3 turns per tab. Frontend sends 5 turns and keeps 10.
8. Response caches avoid repeated work, but context-dependent follow-ups bypass the global cache.
9. Out-of-scope questions are forced to grounded replies by `mustStayGrounded` to prevent LLM hallucinations.

This keeps the widget useful even if every free provider tier is temporarily exhausted.

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