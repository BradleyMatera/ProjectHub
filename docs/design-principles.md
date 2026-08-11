# Scout Design Principles

These principles guide every change to the ProjectHub / Scout recruiter assistant.

## 1. Single Source of Truth

Local Ollama generation and the grounded fallback consume the **same canonical knowledge block** (`buildKnowledgeContext`). If a fact is not in `data/recruiter-knowledge.json`, it is not in an answer.

## 2. Grounded-Only Answers

Scout answers from Bradley's verified data. It does not use the LLM's general training knowledge. The prompt explicitly forbids outside facts, assumptions, and industry generalizations.

## 3. Indistinguishable Fallback

When local generation is slow or fails validation, the grounded fallback must be:

- Factually identical to what the LLM would have said.
- Conversational, direct, and free of broken grammar.
- Fast enough that users don't notice the switch.

We achieve this by sharing context, using natural sentence templates, and avoiding the repetitive "Bradley is a..." opener in every turn.

## 4. Safety by Design

These requests are always handled deterministically:

- Prompt injection / secret extraction attempts.
- Requests for false claims or overselling.
- Private data (salary, address, etc.).
- Structured-output constraints.

Safety checks run before any LLM call or learned-answer lookup.

## 5. Graceful Degradation

The small local model can be cold, slow, or wrong. Scout degrades gracefully:

- Response cache warms common questions so first-time visitors get instant replies.
- A bounded Ollama deadline prevents a slow generation from holding the request open.
- The grounded knowledge base is always ready; it needs no model call and keeps Scout useful if Ollama is cold, unavailable, or wrong.

## 6. Fast Feedback

A recruiter should not wait indefinitely for local generation. The request has a 15-second end-to-end budget, and cached or grounded answers usually return much faster.

## 7. Observability

Every reply reports its route, local model, pipeline, and latency. Runtime state is summarized by `/health`; weak relevant answers are logged and stashed for local Think Mode.

## 8. Continuous Validation

Changes are validated against unit, retrieval, API, memory, latency, safety, and browser checks before deployment. Local Ollama output must pass the same evidence and overclaim rules as every grounded answer.

## 9. Subject Fidelity and Honest Potential

Scout must answer the subject the visitor actually named, including after frustration or misspellings. For an unverified technology, it separates present evidence from transferable skills and learning potential. It neither converts “can learn” into “already knows” nor falls back to an unrelated generic biography.

The active feature's acceptance evidence and known gaps are in `current-feature-handoff.md`.
