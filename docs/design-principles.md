# Scout Design Principles

These principles guide every change to the ProjectHub / Scout recruiter assistant.

## 1. Single Source of Truth

Both LLM providers and the grounded fallback consume the **same canonical knowledge block** (`buildKnowledgeContext`). If a fact is not in `data/recruiter-knowledge.json`, it is not in an answer.

## 2. Grounded-Only Answers

Scout answers from Bradley's verified data. It does not use the LLM's general training knowledge. The prompt explicitly forbids outside facts, assumptions, and industry generalizations.

## 3. Indistinguishable Fallback

When free LLM providers are unavailable, the grounded fallback must be:

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

The free provider network is unreliable by nature. Scout degrades gracefully:

- Per-provider retry once on transient errors.
- Circuit breaker opens when too many recent calls fail, skipping the network entirely.
- Response cache warms common questions so first-time visitors get instant replies.
- The grounded knowledge base is the last-resort fallback; it needs no LLM calls and keeps Scout online when all providers are unavailable.

## 6. Fast Feedback

A recruiter should not wait for a bad provider to time out. The circuit breaker and cache keep grounded-reply latency under one second during outages.

## 7. Observability

Every reply reports its provider, model, pipeline, and latency via the `/health` endpoint. Test failures, provider errors, and weak answers are logged and stashed for Think Mode.

## 8. Continuous Validation

Changes are validated against the conversation test suite before deployment. The suite checks correctness, latency, safety, and—when providers are healthy—naturalness and uniqueness. It is tolerant of grounded-dominant behavior during provider outages.
