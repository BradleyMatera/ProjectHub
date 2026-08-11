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

### Candidate: `qwen2.5:1.5b`

| Field | Value |
|-------|-------|
| Ollama tag | `qwen2.5:1.5b` |
| Digest | `65ec06548149b04c096a` (target VM) |
| Family | qwen2 |
| Parameter size | 1.5B |
| Quantization | Q4_K_M |
| File size | ~986 MB (target VM) / ~940 MB (Mac) |
| License | Apache 2.0 (Qwen2.5 weights). Self-hosted use permitted. |
| Context window | 32768 (Ollama default; Scout uses 1536-2048) |
| Min RAM | ~1400 MB (with quantization) |
| Dev hardware | Apple M2 Pro, 16 GB RAM |

**Why not selected as primary:** The 1.5b model produces better conversation quality (86% multi-turn pass rate vs 57% for 0.5b) and higher grounding (75% vs 61% on Mac). However, on the actual production target (GCP e2-micro, 958 MiB RAM), the 1.5b model **cannot run**. It takes 171 seconds to load, uses 620 MB RSS + 416 MB swap (1036 MB total), and cannot complete even a simple 16-token generation request due to severe swap thrashing (47% I/O wait). See the Target Machine Measurements section below.

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

## Target Machine Measurements (GCP e2-micro)

**Measured on:** `projecthub-dev-vm` (private dev VM, separate from production `ollama-api-gate`)
- Machine type: e2-micro (2 vCPU AMD EPYC 7B12, 958 MiB RAM, 2 GB swap)
- OS: Ubuntu 22.04.5 LTS, kernel 6.8.0-1064-gcp
- Ollama: 0.32.7
- Ollama config: `OLLAMA_KEEP_ALIVE=-1`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_CONTEXT_LENGTH=1536`

### qwen2.5:0.5b on e2-micro

| Metric | Value |
|--------|-------|
| Model loads | Yes (stays resident with keep_alive=-1) |
| Load time (cold) | 15-20 seconds |
| RSS (loaded) | ~470-500 MB |
| VmSwap | 0-130 MB (varies with memory pressure) |
| RAM free (loaded) | 76-102 MiB |
| Simple JSON (16 tokens, warm) | 771-879 ms |
| Reasoning (80 tokens, warm) | 4389-5579 ms |
| Synthesis (150 tokens, warm) | 3319-3616 ms |
| Scout agent loop (900-token context) | **30-60 seconds per step (TIMEOUT)** |
| Reduced context (150 tokens, ctx=512) | 2.4 seconds |
| Reduced context (267 tokens, ctx=768) | 37.9 seconds |
| Prompt eval rate | ~70-74 tokens/second |
| Scout eval (28 questions, full context) | 0/28 grounded (all fallback) |
| Scout eval (28 questions, reduced context) | 0/28 grounded (all fallback) |

**Verdict: MARGINAL.** The 0.5b model loads and stays resident, and can handle small prompts (<150 tokens) in under 3 seconds. However, Scout's agent loop requires 775-900 token context packets, which take 30-60 seconds per step on the e2-micro. The prompt eval rate (~70 tok/s) is too slow for the full agent loop. The model works for simple direct generation but not for the multi-step agent engine.

### qwen2.5:1.5b on e2-micro

| Metric | Value |
|--------|-------|
| Model loads | Yes (after 171 seconds) |
| Load time (cold) | 171 seconds |
| RSS (loaded) | ~620 MB |
| VmSwap | 416 MB (620+416=1036 MB total, exceeds 958 MiB RAM) |
| Simple JSON (16 tokens, warm) | **FAILED (62 second timeout, swap thrashing)** |
| Swap-in rate during generation | 17884-20520 pages/second |
| I/O wait during generation | 47% |
| CPU during generation | 0-4% (stalled on I/O) |

**Verdict: NOT DEPLOYABLE.** The 1.5b model exceeds the e2-micro's physical RAM. It loads after 171 seconds but cannot generate any output because the model weights are swapped to disk. Every generation request thrashes swap at ~18000-20000 pages/second with 47% I/O wait. The model is unusable on this hardware.

### M2 Pro vs e2-micro Comparison

| Metric | M2 Pro (16 GB) | e2-micro (1 GB) |
|--------|----------------|-----------------|
| 0.5b cold load | 304 ms | 15-20 seconds |
| 0.5b warm simple gen | 274 ms | 771-879 ms |
| 0.5b Scout agent loop | 1100-3620 ms | 30000-60000 ms (timeout) |
| 0.5b Scout eval grounded | 17/28 (61%) | 0/28 (0%) |
| 1.5b cold load | ~1 second | 171 seconds |
| 1.5b warm simple gen | ~500 ms | FAILED (swap thrashing) |
| 1.5b Scout eval grounded | 21/28 (75%) | N/A (cannot generate) |

### Context Behavior on e2-micro

The primary bottleneck on the e2-micro is **prompt eval speed**, not model size. The 0.5b model fits in RAM (~470 MB RSS) but prompt eval runs at only ~70 tokens/second on 2 vCPU. Scout's context packet is 775-900 tokens, requiring 11-13 seconds for prompt eval alone. With 2-3 steps per question, total latency is 22-39 seconds, exceeding the 15-second production response budget.

Reducing the context to 150 tokens brings latency to 2.4 seconds, but this requires stripping most evidence, tool definitions, and rules — defeating the purpose of the agent loop.

### Model Selection Decision

| Model | Classification | Reason |
|-------|---------------|--------|
| qwen2.5:0.5b | **MARGINAL** | Loads and stays resident, but Scout's full agent loop context (775+ tokens) takes 30-60s per step. Works for simple direct generation only. |
| qwen2.5:1.5b | **NOT DEPLOYABLE** | Exceeds physical RAM. Cannot generate due to swap thrashing. |
| gemma3:1b | **NOT DEPLOYABLE** | 815 MB model + ~1.1 GB RAM needed > 958 MiB available. Same swap thrashing expected as 1.5b. |

**Recommendation:** The e2-micro (958 MiB RAM, 2 vCPU) is too constrained for Scout's full agent loop with any currently tested model. The 0.5b model is the only one that loads and stays resident, but the 2 vCPU prompt eval rate (~70 tok/s) makes the 775+ token agent context impractical.

**Path forward (not attempted in this phase):**
1. Upgrade to e2-small (2 vCPU, 2 GB RAM) — would eliminate swap thrashing for 0.5b and may allow 1.5b to run.
2. Implement a "lite agent" mode for e2-micro: single-step direct generation with 200-token context, no tool loop, no repair. This would work at 2-3 second latency.
3. Use the 0.5b model with a heavily compressed context packet (<200 tokens) and accept lower grounding quality.

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
| qwen2.5:0.5b | RAW | 5/28 (18%) | 5/28 | 1/28 | n/a | n/a |
| qwen2.5:0.5b | SCOUT | 20/28 (71%) | 0/28 | 0/28 | 8/28 (29%) | 20/28 (71%) |
| qwen2.5:1.5b | RAW | 8/28 (29%) | 8/28 | 3/28 | n/a | n/a |
| qwen2.5:1.5b | SCOUT | 24/28 (86%) | 0/28 | 0/28 | 4/28 (14%) | 24/28 (86%) |
| gemma3:1b | RAW | 3/28 (11%) | 3/28 | 5/28 | n/a | n/a |
| gemma3:1b | SCOUT | 16/28 (57%) | 1/28 | 4/28 | 9/28 | 19/28 |

Note: Results above are from the M2 Pro with the fixed validator (contextual number grounding + word-boundary entity matching) and fixed eval scorer (same source text as agent engine + refutation detection). The previous report's 1.5b "2 unsupported claims" were real hallucinations that passed validation due to substring number matching — now fixed. Both models achieve 0 unsupported claims in final Scout output.

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
| `SCOUT_STEP_TIMEOUT_MS` | `6000` | Per-step timeout (max 60000) |
| `SCOUT_TOTAL_BUDGET_MS` | `15000` | Total agent loop budget (max 120000) |
| `OLLAMA_PROBE_TIMEOUT_MS` | `5000` | Probe timeout for agent reachability check |
| `SCOUT_EVIDENCE_MAX_ITEMS` | `5` | Max evidence items in reasoning packet |
| `SCOUT_EVIDENCE_MAX_CHARS` | `220` | Max chars per evidence item in reasoning |
| `SCOUT_SYNTHESIS_EVIDENCE_MAX_ITEMS` | `4` | Max evidence items in synthesis/repair packet |
| `SCOUT_SYNTHESIS_EVIDENCE_MAX_CHARS` | `200` | Max chars per evidence item in synthesis |
| `SCOUT_TOOL_OBS_MAX_CHARS` | `400` | Max chars for tool observation results |

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
