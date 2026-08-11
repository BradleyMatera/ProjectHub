# Local AI Runtime

Scout performs model inference only through Ollama on the ProjectHub VM. The default model is `qwen2.5:0.5b`; it stays warm to avoid repeated load time and uses one inference thread so Node retains CPU time for request deadlines. Chat generation is cancelled inside Ollama after 10 seconds, and a separate 11-second route deadline returns the grounded answer even if the HTTP client is slow to surface the cancellation. This keeps the complete request inside the 15-second visitor budget without leaving stale generations queued.

The exact current commit, production-corpus provenance, passing results, and pending private-preview run are maintained in `current-feature-handoff.md`.

## How Scout stays useful with a small model

1. Query understanding normalizes text, corrects common typos, classifies intent (including frustration), expands transferable-skill language, and rewrites short follow-ups with conversation context.
2. BM25 retrieves verified facts from the bundled recruiter knowledge file. Standalone questions use the best direct ranking; follow-ups use local RRF (k=60) to fuse literal, expanded, and context-rewritten BM25 rankings so an explicit subject such as COBOL survives contextual retrieval.
3. Five recent turns and retained topic stances preserve conversational coherence.
4. Read-only local tools handle comparisons, role evidence, recruiter briefs, and interview-question workflows deterministically.
5. Ollama phrases open-ended answers. Safety, source overlap, entity, number, length, and overclaim validators reject weak generations.
6. A deterministic grounded answer is always available when generation times out or fails validation.

Optional Ollama rephrasing stops once the five-turn retained context is full. At that point Scout continues with deterministic contextual answers, avoiding long-prompt CPU contention while preserving the remembered topic and stance.

## Local learning and retention

Weak relevant answers may be stashed in `learned.json`. Every 20 minutes, Think Mode processes at most three items through the same local model, compares candidates with the grounded baseline, and retains only measurable, validated improvements. Learned answers stay on local disk and never trigger an external write.

## Required settings

```env
OLLAMA_URL=http://127.0.0.1:11434
GEN_MODEL=qwen2.5:0.5b
GEN_TIMEOUT_MS=12500
GEN_ENABLED=true
OLLAMA_AGENT_ENABLED=true
OLLAMA_AGENT_CONTEXT=1536
OLLAMA_AGENT_KEEP_ALIVE=-1
USE_BM25_RETRIEVAL=true
```

## Verification

```bash
node --check server-gemini.js
npm test
npm run eval-retrieval
PROJECTHUB_API_URL=http://127.0.0.1:3000 npm run eval:local-api
npm run eval:production-conversations
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/diagnose
```

The checked-in suites currently cover 63 deterministic unit tests, a 40-query retrieval golden set, a 61-request local API evaluation, and a 132-input conversation regression. The retained production corpus contributes 81 complete turns across 26 sessions, one reconstructed 40-prompt older sequence, and five older complete request records; duplicate and truncated backup mirrors are not replayed twice. Six additional turns reproduce the reported COBOL/frustration failure. The API evaluation checks pronoun handling, user-provided context, response variety, concise answers, and direct assessments of unfamiliar technologies. The production-derived suite removes session metadata and old replies; its assertions require improved semantic behavior, local-only providers, useful uncertainty, response variety, and the 15-second latency ceiling. The longer recruiter conversation scripts exercise 107 additional multi-turn prompts and should be run against the private preview before promotion.

The RRF design follows the useful part of current retrieval research while respecting ProjectHub's local-only constraint: RRF is applied only where multiple contextual BM25 views exist. Offline evaluation showed that applying those correlated views to every standalone query reduced MRR, so standalone retrieval deliberately remains plain BM25. No hosted embedding model, neural reranker, HyDE query generation, or cloud API is required.

No design can truthfully guarantee correct factual knowledge for every possible question. ProjectHub's contract is narrower and testable: every request receives a useful response, unknown facts are identified honestly, and unsupported claims are never presented as verified facts.
