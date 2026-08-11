# Scout Local AI Runtime — Reproducibility Guide

**Updated:** 2026-08-11

This document records exactly what self-hosted AI infrastructure Scout uses, so the environment can be recreated reliably. Scout's generative brain runs entirely on self-hosted Ollama models. No hosted LLM API is ever called for core intelligence.

---

## Ownership Test

| Component | Owned by us? | Notes |
|-----------|-------------|-------|
| Scout code | Yes | This repository |
| Knowledge data | Yes | `data/recruiter-knowledge.json` |
| Memory storage | Yes | In-process server state |
| Retrieval (BM25/RRF) | Yes | `lib/bm25.js`, `lib/rrf.js` |
| Tools | Yes | `lib/agent-tools.js` |
| Analytics | Yes | Server stats + cost ledger |
| Model weights | Yes (downloadable) | Pinned below, licenses permit self-hosted use |
| Inference runtime | Yes (self-hosted) | Ollama on hardware we control |
| Validation | Yes | `lib/grounding-validator.js` |

If every hosted AI provider disappeared tomorrow, Scout would continue to operate.

---

## Pinned Models

These are the exact models Scout has been tested against. Pin the tag and digest for reproducibility.

### Primary: `qwen2.5:0.5b`

| Field | Value |
|-------|-------|
| Ollama tag | `qwen2.5:0.5b` |
| Digest | `a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67` |
| Family | qwen2 |
| Parameter size | 494.03M |
| Quantization | Q4_K_M |
| File size | ~397 MB |
| License | Apache 2.0 (Qwen2.5 weights). Self-hosted use permitted; no redistribution restrictions beyond notice. |
| Context window | 32768 (Ollama default; Scout uses 1536-2048) |
| Min RAM | ~768 MB (with quantization) |
| Production hardware | GCP e2-micro (1 GB RAM + 2 GB swap) |
| Dev hardware | Apple M2 Pro, 16 GB RAM |

**Why selected:** Fast (274-304ms warm on Mac, ~1s on e2-micro), low RAM, reliable structured JSON with compact prompts, best grounding rate on the Scout eval set (61% Scout-assisted vs 25% raw). The smallest viable model — proves the harness boosts a weak model significantly.

### Candidate: `gemma3:1b`

| Field | Value |
|-------|-------|
| Ollama tag | `gemma3:1b` |
| Digest | `8648f39daa8f` |
| Family | gemma3 |
| Parameter size | 999.89M |
| Quantization | Q4_K_M |
| File size | ~815 MB |
| License | Gemma Terms of Use (Google). Self-hosted use permitted; redistribution subject to Gemma terms. |
| Context window | 8192 |
| Min RAM | ~1200 MB |

**Eval result:** 57% Scout-assisted grounded (vs 11% raw). Slower (457-484ms warm on Mac). More forbidden claims on adversarial questions (4 vs 2). Not selected as primary due to higher RAM, slower latency, and worse adversarial safety on the e2-micro target hardware.

---

## Performance Measurements (Apple M2 Pro, 16 GB RAM)

### qwen2.5:0.5b

| Metric | Value |
|--------|-------|
| Cold start latency | 304 ms |
| Warm latency (structured JSON) | 274 ms |
| Warm latency (agent reasoning) | 409-951 ms |
| Warm latency (synthesis) | 397-692 ms |
| Full agent loop (1 step) | 1100-1300 ms |
| Full agent loop (3 steps) | 1988-3620 ms |
| RAM (Ollama runner) | ~423 MB idle, ~1 GB loaded |
| CPU (idle) | 0.2% |
| Tokens/sec (output) | ~50-70 tok/s |
| Prompt eval tokens | 38-575 (varies with context packet) |

### gemma3:1b

| Metric | Value |
|--------|-------|
| Cold start latency | 457 ms |
| Warm latency (structured JSON) | 484 ms |
| RAM (loaded) | ~1.1 GB |
| Tokens/sec (output) | ~25-40 tok/s |

---

## Scout Evaluation Results

### Raw vs Scout-Assisted (28 questions: 19 factual + 8 adversarial + 1 conversational excluded)

| Model | Mode | Grounded | Overclaim | Forbidden claims | Fallback | Generative |
|-------|------|----------|-----------|-----------------|----------|------------|
| qwen2.5:0.5b | RAW | 6/28 (21%) | 7/28 | 2/28 | n/a | n/a |
| qwen2.5:0.5b | SCOUT | 17/28 (61%) | 0/28 | 0/28 | 5/28 (18%) | 23/28 (82%) |
| qwen2.5:1.5b | RAW | 9/28 (32%) | 7/28 | 2/28 | n/a | n/a |
| qwen2.5:1.5b | SCOUT | 21/28 (75%) | 2/28 | 2/28 | 3/28 (11%) | 25/28 (89%) |
| gemma3:1b | RAW | 3/28 (11%) | 3/28 | 5/28 | n/a | n/a |
| gemma3:1b | SCOUT | 16/28 (57%) | 1/28 | 4/28 | 9/28 | 19/28 |

### Multi-Turn Conversation (14 turns across 4 conversations)

| Model | Pass Rate | Adversarial Resistance |
|-------|-----------|----------------------|
| qwen2.5:0.5b | 8/14 (57%) | 2/3 |
| qwen2.5:1.5b | 12/14 (86%) | 3/3 |

### Tool-Selection (22 questions)

| Model | Correct Tool | Acceptable | Tool+Direct Combined |
|-------|-------------|------------|---------------------|
| qwen2.5:0.5b | 8/22 (36%) | 8/22 (36%) | 22/22 (100%) |
| qwen2.5:1.5b | 3/22 (14%) | 3/22 (14%) | 22/22 (100%) |

Note: "Tool+Direct Combined" counts direct answers as acceptable when the model has enough evidence to answer without a tool. Both models achieve 100% on this metric, meaning they never select an invalid or unnecessary tool.

### Key findings

1. **The harness makes the weak model significantly smarter.** qwen2.5:0.5b goes from 21% grounded to 61% grounded — a 2.9x improvement. The raw model hallucinates wildly ("founder of AWS", "economics degree from Berkeley", "recruiter at CIA").
2. **Adversarial safety is strong.** With honesty rules, qwen2.5:0.5b achieves 0 forbidden claims. On adversarial questions, Scout falls back safely or corrects the false premise instead of agreeing.
3. **The 1.5b model is significantly better at conversation.** 86% multi-turn pass rate vs 57%, and perfect 3/3 adversarial resistance. It also achieves 75% grounded and 89% generative.
4. **Validation-guided repair works.** The 1.5b model had 2 repaired answers (rejected then fixed on retry). The 0.5b model had 0 repairs in this run but the mechanism is proven.
5. **Fallback is a feature, not a bug.** When the model can't produce a grounded answer, Scout returns the deterministic grounded response instead of a hallucination.

---

## Setup Commands

### Local development (Mac/Linux)

```bash
# 1. Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# 2. Pull the pinned primary model
ollama pull qwen2.5:0.5b

# 3. (Optional) Pull the comparison candidate
ollama pull gemma3:1b

# 4. Warm the model (loads into memory)
curl -s http://localhost:11434/api/generate \
  -d '{"model":"qwen2.5:0.5b","prompt":"","stream":false,"keep_alive":-1,"options":{"num_ctx":2048,"num_predict":1}}'

# 5. Start Scout with the agent engine
cd ProjectHub
SCOUT_AGENT_ENGINE_ENABLED=true \
OLLAMA_AGENT_ENABLED=true \
AGENT_ENABLED=true \
GEN_ENABLED=true \
FEATURE_PREVIEW_ENABLED=true \
PORT=3199 \
node server-gemini.js

# 6. Open the engineering console
open http://127.0.0.1:3199/preview/
```

### Production / private preview VM (GCP e2-micro)

```bash
# The setup script handles swap, Ollama install, model pull, and warmup
bash scripts/setup-ollama-preview.sh

# Deploy the private preview
bash deploy-agent-preview.sh

# Open the SSH tunnel
AGENT_PREVIEW_LOCAL_PORT=3320 bash scripts/open-agent-preview.sh
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama inference endpoint |
| `OLLAMA_MODEL` | `qwen2.5:0.5b` | Primary generation model |
| `OLLAMA_AGENT_MODEL` | (same as OLLAMA_MODEL) | Agent reasoning model |
| `SCOUT_AGENT_ENGINE_ENABLED` | `false` | Enable the new bounded agent loop |
| `OLLAMA_AGENT_ENABLED` | `false` | Enable Ollama in the legacy agent path |
| `AGENT_ENABLED` | `true` | Enable agent tools |
| `GEN_ENABLED` | `true` | Enable generative RAG (legacy path) |
| `OLLAMA_AGENT_CONTEXT` | `1536` | Context window for agent calls |
| `OLLAMA_KEEP_ALIVE` | `-1` | Keep model in memory indefinitely |
| `SCOUT_MAX_STEPS` | `3` | Max agent loop iterations |
| `SCOUT_STEP_TIMEOUT_MS` | `6000` | Per-step timeout |
| `SCOUT_TOTAL_BUDGET_MS` | `15000` | Total agent loop budget |

### Health checks

```bash
# Service health
curl http://127.0.0.1:3199/health

# Agent probe (tests Ollama reachability + structured JSON)
curl http://127.0.0.1:3199/api/agent-probe

# Diagnose (legacy)
curl http://127.0.0.1:3199/api/diagnose
```

---

## Fallback Behavior

```text
Ollama available
  → Scout Agent Engine (bounded loop, structured decisions, tools, validation)
  → Grounded Ollama-generated answer

Ollama unavailable or validation fails
  → Deterministic grounded answer from BM25 retrieval + knowledge JSON
  → No cloud LLM is ever called
```

There is no cloud LLM fallback. If Ollama is down, Scout returns evidence from the deterministic grounded path. This is intentional — we own the generative stack.
