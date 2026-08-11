# Local AI Runtime

Scout performs model inference only through Ollama on the ProjectHub VM. The default model is `qwen2.5:0.5b`; it stays warm to avoid repeated load time and uses one inference thread so Node retains CPU time for request deadlines. Chat generation is cancelled inside Ollama after 10 seconds, and a separate 11-second route deadline returns the grounded answer even if the HTTP client is slow to surface the cancellation. This keeps the complete request inside the 15-second visitor budget without leaving stale generations queued.

## How Scout stays useful with a small model

1. Query understanding normalizes text, corrects common typos, classifies intent, and rewrites short follow-ups with conversation context.
2. BM25 retrieves verified facts from the bundled recruiter knowledge file.
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
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/diagnose
```

The checked-in suites currently cover 58 deterministic unit tests, a 40-query retrieval golden set, and a 55-request local API evaluation. The API evaluation includes a casual-dialogue regression that checks pronoun handling, user-provided context, response variety, and concise answers. The longer recruiter conversation scripts exercise 107 additional multi-turn prompts and should be run against the private preview before promotion.

No design can truthfully guarantee correct factual knowledge for every possible question. ProjectHub's contract is narrower and testable: every request receives a useful response, unknown facts are identified honestly, and unsupported claims are never presented as verified facts.
