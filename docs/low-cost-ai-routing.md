# low-cost-ai-routing.md

**Read when:** You need to understand how ProjectHub keeps AI inference free and local.

---

## Budget Rule

ProjectHub has zero recurring AI spend. It does not require Groq, Cloudflare Workers AI, Gemini, GitHub Models, xAI, OpenAI, or another hosted inference API. The frontend remains on GitHub Pages and the Node/Ollama backend fits on the existing GCP Always Free `e2-micro` VM.

## Local-Only Architecture

1. The widget calls the Node API on the GCP VM.
2. The API reads bundled `data/recruiter-knowledge.json`; it does not fetch knowledge at runtime.
3. Safety, false-claim, scope, and intent checks run first.
4. Query understanding corrects typos and rewrites follow-ups using recent context.
5. Local BM25 retrieves verified facts. Evidence-heavy workflows use bounded read-only tools.
6. A deterministic grounded answer is computed before generation.
7. Open-ended questions may be phrased by pre-warmed `qwen2.5:0.5b` through loopback-only Ollama.
8. The prompt includes the five newest sanitized turns and the stored stance for the current topic.
9. Generated output is capped at 48 tokens and 15 seconds, then checked for unsupported numbers, new entities, overclaims, slop, safety problems, source overlap, and a two-sentence maximum.
10. Timeout or any failed check returns the deterministic grounded answer.

`LOCAL_ONLY_MODE=true` forces `PROVIDER_ORDER` to an empty list and forces dense vector retrieval off even when a stale environment variable enables it. Legacy hosted-provider adapters remain for backward compatibility outside local-only mode, but they are unreachable in the deployed local configuration.

## Why Qwen 2.5 0.5B

The free VM has roughly 1 GB RAM, so an 8B model is not viable. On this VM, `gemma3:1b` remained busy after roughly 90 seconds and pushed about 1 GB into swap. `qwen2.5:0.5b` measured 77.5 seconds on its first cold load but 3.71 seconds after loading at a fixed 1536-token context. Deployments therefore pre-warm Qwen and keep it resident with one loaded model and one parallel request.

The small model is the conversational layer, not the source of truth. Retrieval, tools, memory, stance tracking, and validation do the reliability work a larger model would otherwise need to do.

## Coherence and NLP

- **Memory:** five recent sanitized user/assistant turns.
- **Stance:** up to 12 topic summaries per session, retained for 60 minutes.
- **Query understanding:** normalization, typo correction, intent classification, and contextual rewriting in pure JavaScript.
- **Retrieval:** in-memory Okapi BM25; current Recall@6 is 0.925 on the 40-query golden set.
- **Tools:** deterministic comparison, role-matching, evidence, and interview-question workflows.
- **Persona:** Scout remains concise, warm, honest, and third-person.

## Latency and Failure Policy

The user-facing budget is 15 seconds. The model is pre-warmed during setup and deployment, uses a 1536-token context, produces at most 48 tokens, and stays loaded indefinitely. If Ollama is cold, overloaded, unavailable, or produces invalid text, the already-computed grounded answer is returned. This keeps availability independent of model quality.

## Think Mode

Think Mode may use the same local Ollama model to examine weak answers. In local-only mode it cannot push changes to GitHub, and it cannot invoke cloud providers. Any permanent knowledge change still follows the normal reviewed branch and release process.

## Cost Boundary

- No AI API key or paid model subscription.
- No external embedding request; BM25 is the production retrieval mode.
- No runtime database; session and stance memory are in process.
- No runtime knowledge download; the JSON is deployed with the server.
- No provider quota, provider cooldown, or Aug 16 dependency.

The remaining infrastructure is GitHub Pages, DNS/HTTPS, and the GCP VM. “Local-only” refers to inference and knowledge processing on that VM, not to browser-only execution.
