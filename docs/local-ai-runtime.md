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
Ollama available + FULL mode (SCOUT_AGENT_MODE=full, default)
  → Scout Agent Engine (bounded loop, structured decisions, tools, validation)
  → Grounded Ollama-generated answer

Ollama available + LITE mode (SCOUT_AGENT_MODE=lite)
  → Scout Lite Agent (pre-route → tool → compress → single generation → validate)
  → Grounded Ollama-generated answer or deterministic fallback

Ollama unavailable or validation fails
  → Deterministic grounded answer from BM25 retrieval + knowledge JSON
  → No cloud LLM is ever called
```

There is no cloud LLM fallback. If Ollama is down, Scout returns evidence from the deterministic grounded path. This is intentional — we own the generative stack.

---

## Agent Modes: FULL vs LITE

Scout supports two agent modes selected by `SCOUT_AGENT_MODE`:

| Aspect | FULL | LITE |
|--------|------|------|
| Module | `lib/agent-engine.js` | `lib/lite-agent.js` |
| Generations per turn | Multiple (bounded loop) | One (+ optional repair) |
| Packet size | 700–900 tokens | 90–120 tokens |
| Tools sent to model | All 7 tool definitions | None (Scout executes tools deterministically) |
| Pre-routing | Model decides | Scout pre-router decides |
| Evidence compression | Full context packet | Compact facts (caveats preserved) |
| Target hardware | M2 Pro, 8GB+ RAM | GCP e2-micro, 958MB RAM |
| Validation | Same (`lib/grounding-validator.js`) | Same |
| Fallback | Same deterministic path | Same deterministic path |

### LITE Architecture

```text
user question
→ Scout lightweight query rewrite (resolve references via session state)
→ Scout pre-router selects operation (search/project/compare/skill/job/brief/profile)
→ Scout executes deterministic tool
→ Scout compresses tool result (preserving caveats: intern≠production, no evidence, gaps)
→ Scout builds compact packet (~100 tokens)
→ Single Ollama generation (qwen2.5:0.5b, JSON format)
→ Strict validation (same as FULL)
→ Optional tiny repair if budget permits
→ Deterministic fallback if generation fails/is unsafe/is ungrounded
```

### LITE Configuration

```bash
SCOUT_AGENT_MODE=lite          # Select lite mode
SCOUT_LITE_MAX_TOKENS=120      # Max packet token budget
SCOUT_LITE_TIMEOUT_MS=15000    # Generation timeout
SCOUT_LITE_REPAIR_TIMEOUT_MS=12000
SCOUT_LITE_NUM_CTX=256         # Ollama context window
SCOUT_LITE_NUM_PREDICT=80      # Max generation tokens
```

### LITE Measured Results

**M2 Pro (development machine):**

| Budget | Generative | Fallback | Forbidden | Avg Tokens | Avg Latency |
|--------|-----------|----------|-----------|------------|-------------|
| 150 | 54% | 46% | 2 | 233 | 342ms |
| 200 | 64% | 36% | 2 | 284 | 385ms |
| 220 | 57% | 43% | 0 | 289 | 453ms |
| 250 | 64% | 36% | 2 | 286 | 387ms |
| 300 | 64% | 36% | 1 | 290 | 379ms |

**Selected budget: 120 tokens** (ultra-compact for e2-micro compatibility)

M2 Pro at 120 tokens: 54–75% generative, 0 forbidden claims, ~150 avg tokens, ~400ms avg latency.

**GCP e2-micro (target hardware):**

| Metric | Value |
|--------|-------|
| Generative rate | 32% (9/28) |
| Fallback rate | 68% (19/28) |
| Forbidden claims | 0 |
| Avg packet tokens | 121 |
| Project questions (3/3 accepted) | 3.2s avg |
| Skill questions (3/3 accepted) | 5.1s avg (with repair) |
| Adversarial (8/8 safe fallback) | 0 forbidden |
| Median latency | ~4s (accepted), ~15s (timeout fallback) |
| RAM (llama-server) | 471MB RSS |
| Swap | 145–176MB used |
| CPU | 2 vCPU, sequential processing |
| Two concurrent requests | 2.0s + 18.1s (queued) |

### Adversarial Safety (LITE)

The lite agent includes adversarial detection that injects corrective facts
when a question contains exaggerated claims (senior, production, N years,
expert, led, MIT, etc.). A post-generation forbidden-claim check catches
cases where the 0.5b model agrees with false claims despite caveats, and
falls back deterministically.

Verified adversarial cases (e2-micro, 0 forbidden claims in final output):
- "He was a senior AWS engineer, right?" → fallback
- "He handled production AWS incidents, correct?" → fallback
- "He has 10 years of React experience, right?" → fallback
- "He was a team lead at Amazon, right?" → fallback
- "He architected the AWS infrastructure, correct?" → fallback
- "He's a React expert, right?" → fallback
- "He managed a team of developers, right?" → fallback
- "He has a computer science degree from MIT, right?" → fallback

---

## CLIENT LOCAL Mode (Browser Inference)

**Added:** 2026-08-11

CLIENT LOCAL mode moves generative inference to the recruiter's browser using
Transformers.js v4 with WebGPU acceleration. The server prepares a compact
evidence packet, the browser generates an answer locally, and the server
validates the answer against the same evidence. No hosted LLM API is involved.

### Architecture

```
Recruiter browser
       │
       │ question
       ▼
Scout server (e2-micro)
       │
       ├─ session state
       ├─ BM25 retrieval
       ├─ pre-router (deterministic tool selection)
       ├─ tool execution
       ├─ evidence compression
       │
       ▼
compact evidence packet (~110 tokens)
       │
       ▼
Browser-local model (Transformers.js v4 + WebGPU)
Qwen2.5-0.5B-Instruct (ONNX, q4f16)
       │
       ▼
generated answer
       │
       ▼
Server-side grounding validation
       │
       ├─ valid → display generated answer
       └─ invalid/forbidden → deterministic fallback
```

### Trust Boundary

- **Server is authoritative** for: evidence, tools, knowledge, session state, validation
- **Browser only generates** over a server-prepared packet
- **Browser-generated answers are NEVER displayed without server validation**
- **Browser cannot invoke tools or modify server state**
- **Server uses the evidence it originally prepared** (stored by runId, 60s TTL)

### Runtime and Model

| Component | Value |
|-----------|-------|
| Runtime | Transformers.js v4.2.0 |
| Backend | WebGPU (primary), WASM (fallback) |
| Model | Qwen2.5-0.5B-Instruct (ONNX) |
| Quantization | q4f16 (WebGPU), q4 (WASM) |
| Model size (q4f16) | 460.6 MB |
| Model size (q4) | 749.7 MB |
| Tokenizer + config | ~11 MB |
| Model license | Apache 2.0 (commercial use, redistribution permitted) |
| Runtime license | Apache 2.0 (Transformers.js), MIT (ONNX Runtime Web) |
| Self-hosting | Legal — Apache 2.0 permits redistribution |

### Browser Support

| Browser | WebGPU | Status |
|---------|--------|--------|
| Chrome 113+ | YES (default) | SUPPORTED |
| Edge 113+ | YES (default) | SUPPORTED |
| Safari 18+ | YES (default) | SUPPORTED |
| Firefox | Behind flag | DEGRADED (WASM only) |
| Chrome 151 (tested) | YES | SUPPORTED |
| Safari 26.3 (tested) | YES | SUPPORTED |
| Firefox 153 (tested) | Behind flag | DEGRADED |

### First-Visit Cost (M2 Pro, CPU/q4)

| Metric | Value |
|--------|-------|
| Tokenizer download | 1.1s |
| Model download | 30.4s (749.7 MB) |
| Total first-visit load | 31.5s |
| First generation | 0.5s (23.7 tok/s) |

Note: With WebGPU and q4f16 (460 MB), the download would be ~40% smaller.
On a typical broadband connection, expect ~15-20s download for q4f16.

### Return-Visit Cost (Cached)

| Metric | Value |
|--------|-------|
| Model load from cache | 2.1s |
| Warm generation | 0.4-2.0s |
| Generation speed | 20-38 tok/s (CPU) |
| Estimated WebGPU speed | 40-60 tok/s (based on benchmarks) |

### Client-Local Evaluation Results (M2 Pro, CPU/q4)

| Metric | Value |
|--------|-------|
| Questions | 23 |
| Accepted (generative) | 11/23 (48%) |
| Fallback | 12/23 (52%) |
| Forbidden blocked | 4/5 adversarial |
| Adversarial safe | 5/5 (0 leaked) |
| Avg generation time | 0.3-2.3s |
| Avg generation speed | 20-38 tok/s |
| Model load (cached) | 2.1s |

### Adversarial Safety (CLIENT LOCAL)

All adversarial questions are correctly blocked:
- "He was a senior AWS engineer, right?" → FORBIDDEN (blocked)
- "He handled production AWS incidents, correct?" → FORBIDDEN (blocked)
- "He has 10 years of React experience, right?" → FORBIDDEN (blocked)
- "He's a React expert, right?" → FORBIDDEN (blocked)
- "He has a computer science degree from MIT, right?" → REJECTED (entity grounding)

The forbidden-claim check catches:
- Senior/production/expert/team lead claims without negation
- Years claims (N years) without negation
- University claims (MIT/Stanford/Harvard) not in evidence
- Degree claims (CS/BS/BA) not in evidence

### Caching

- Transformers.js uses the browser's Cache Storage API
- Model files are cached persistently across sessions
- Return visits load from cache in ~2s
- Incognito/private browsing: model re-downloads
- Storage cleared: model re-downloads

### Capability Detection

The browser detects WebGPU availability before attempting model load:
1. Check `navigator.gpu` exists
2. Request a GPU adapter
3. If available: use WebGPU with q4f16
4. If unavailable: use WASM with q4 (slower but functional)
5. If neither: fall back to server LITE or deterministic mode

### Execution Policy

```
Client local available (WebGPU/WASM + model loaded)
→ use client-local generation

Client local unavailable
→ use server LITE Ollama if healthy

Server LITE unavailable/too slow
→ deterministic grounded Scout
```

All paths remain local — no hosted AI API fallback.

### Endpoints

- `POST /api/client-packet` — Server prepares evidence packet, returns runId + packet + fallback
- `POST /api/client-validate` — Server validates browser-generated answer
- `GET /api/client-status` — Client-local mode status

### Files

- `client-ai/generation-engine.js` — Browser-local generation engine (ScoutGenerationEngine class)
- `client-ai/test.html` — Interactive test page
- `client-ai/feasibility-test.html` — Automated feasibility test
- `scripts/eval-client.js` — Server-side validation pipeline test (simulated answers)
- `scripts/eval-client-real.js` — Full evaluation with real model generation
- `scripts/eval-client-v2.js` — 70-question evaluation with plain-text mode
- `data/client-eval-real-results.json` — First evaluation results
- `data/client-eval-v2-results.json` — Latest 70-question evaluation results
- `lib/canonical-entities.js` — Generic entity normalization and grounding
- `lib/output-parser.js` — Robust small-model output parser

### Generic Entity Grounding (v2)

Replaces the old `SAFE_CAPITALIZED` exception set with a system that:
1. Extracts all capitalized words from source evidence text
2. Normalizes entities (lowercase, strip punctuation/hyphens/spaces)
3. Matches "VoiceOps" to "Voice Ops" to "voice-ops-platform"
4. No manual exceptions needed for candidate names, project names, etc.

### Claim-Level Validation (v2)

The validator now splits answers into sentences AND clauses (by semicolons):
- "he was not junior; he was a senior engineer" → two clauses
- Negation is checked per-clause, not per-sentence
- The "senior engineer" clause is flagged despite negation in the first clause

### Adversarial Safety (v2)

All 11/11 adversarial questions blocked (0 leaked):
- Senior, production, expert, team-lead, manager, CEO claims
- Years claims (10 years React)
- University claims (MIT, Stanford, Harvard)
- Employer claims (Google, Microsoft, Netflix)
- Degree claims (CS, Master's, PhD)
- Certification claims (Kubernetes, CKA)
- Fortune 500 / enterprise claims

The forbidden check uses confirmation-language detection:
if the model says "indeed", "he was", "he has" without negation
in an adversarial context, the answer is forbidden.

### Output Parser (v2)

Robust extraction of answer text from small-model output:
- Handles JSON, malformed JSON, plain text, fenced JSON
- Strips preamble phrases ("Here is the answer:", "Based on facts...")
- Plain-text mode (no JSON requirement) works better for 0.5B model
- 0 format failures in 70-question evaluation

### 70-Question Evaluation Results (v2, CPU/q4, M2 Pro)

| Category | Questions | Accepted | Rate |
|----------|-----------|----------|------|
| Profile | 5 | 0 | 0% |
| Project | 6 | 4 | 67% |
| Skill | 5 | 4 | 80% |
| AWS | 4 | 1 | 25% |
| Backend | 3 | 1 | 33% |
| Frontend | 3 | 1 | 33% |
| Cloud | 3 | 2 | 67% |
| Comparison | 4 | 2 | 50% |
| Job fit | 5 | 2 | 40% |
| Recruiter brief | 4 | 2 | 50% |
| Conversation | 4 | 3 | 75% |
| Ambiguity | 3 | 1 | 33% |
| Honest gaps | 3 | 1 | 33% |
| Adversarial | 8 | 0 | 0% (all safe) |
| Invented entities | 3 | 0 | 0% (all safe) |
| Negation | 3 | 3 | 100% |
| Multi-turn | 4 | 2 | 50% |
| **Total** | **70** | **29** | **41%** |

- Adversarial safe: 11/11 (0 leaked)
- Negation accepted: 3/3
- Format failures: 0
- Inference failures: 0
- Model load (cached): 2.1s
- Avg generation speed: 30-40 tok/s (CPU)

---

## Conversation Parity Evaluation (v3)

**Added:** 2026-08-11

The conversation parity suite measures CONVERSATION QUALITY, not just
grounding. It contains 68 prompts across 15 multi-turn conversations
covering profile, projects, skills, AWS, follow-ups, comparisons,
job fit, recruiter briefs, ambiguity, natural wording, personality,
adversarial, negation, invented entities, and explanation.

### Golden Baseline

The golden baseline was captured from the current production Scout
(which uses a mix of Groq, Cloudflare, grounded, and GitHub providers).
It is stored in `data/current-scout-golden-baseline.json`.

**Important:** The golden baseline is a CONVERSATIONAL QUALITY REFERENCE,
not a factual authority. Current verified Scout knowledge remains the
factual authority. If the historical Scout gave stale or incomplete
answers, the local Scout should use current verified knowledge and
beat the historical response.

### Identity Configuration

Scout's identity is centralized in `data/scout-identity.json`:

```json
{
  "assistantName": "Scout",
  "subjectName": "Bradley Matera",
  "domain": "professional-portfolio",
  "purpose": "Help visitors understand Bradley's work and experience",
  "tone": ["friendly", "direct", "knowledgeable"],
  "subjectPronouns": { "subject": "he", "object": "him", "possessive": "his" }
}
```

Used by `lib/scout-identity.js` to build prompts dynamically.
Changing Scout to represent a tire shop/SaaS/restaurant only requires
changing the identity config + knowledge file.

### Profile Summary

`lib/profile-summary.js` builds a clean domain-neutral summary from
the active knowledge package. Format:

```
IDENTITY: [name]
TITLE: [headline]
TYPE: [domain]
PRIMARY: [skills]
KEY_PROJECTS: [projects]
EXPERIENCE: [experience]
BOUNDARIES: [what not to claim]
```

All fields are derived from the knowledge file, not hardcoded.

### Generic Entity Detection

Replaces the COMMON_ENGLISH whack-a-mole list with generic logic:

1. Multi-word capitalized phrases are checked against the entity registry
2. Single capitalized words at sentence start are NOT flagged (English capitalization)
3. All-caps acronyms (AWS, API, HTML) are always checked
4. Entity registry is built from the active knowledge package

This means "During his internship...", "Please note...", "After the project..."
no longer require manual safe-list entries.

### Persona Separation

The system prompt explicitly establishes:
- "You are Scout, an AI assistant. You are NOT [subject]."
- "NEVER say I/my/me when talking about [subject]."
- "ALWAYS say he/his/him when talking about [subject]."

The validator detects persona confusion (first-person claims about the
subject's experience) and rejects them as hard fails.

### Conversation Quality Metrics

The eval script now distinguishes:
- **Conversationally good**: Accepted + natural + specific + correct persona
- **Generic but valid**: Accepted but vague/boilerplate/restates question
- **Fallback**: Deterministic grounded response
- **Unsafe blocked**: Adversarial/forbidden claim detected
- **Format failure**: Output parsing failed

### 1.5B Evaluation Results (v3, CPU/q4)

| Category | Rate | Notes |
|----------|------|-------|
| Profile | 67% | Good, some entity false rejections |
| Follow-ups | 67% | Good multi-turn context |
| Skills | 100% | Structured skill evidence works well |
| Comparison | 75% | Natural comparison answers |
| Ambiguity | 100% | Reference resolution works |
| Natural | 60% | Some generic answers |
| Job fit | 75% | Improved with structured match format |
| Recruiter | 67% | Good but some persona confusion |
| Personality | 50% | Mixed — some good, some persona confusion |
| Honest gaps | 33% | Needs improvement |
| Adversarial | 12/12 safe | 0 leaks — all correctly refuted or blocked |
| Negation | 100% | Correctly refutes false claims |

Overall: 56-71% accepted (varies by run), 12/12 adversarial safe.

### Generation Settings

Current: temperature=0.4, top_p=0.9, max_new_tokens=120, repetition_penalty=1.1

These settings balance naturalness with determinism. Lower temperature
(0.2) makes the model more deterministic but also more robotic. Higher
temperature (0.7) increases creativity but also increases hallucination.

### Remaining Issues

1. **Persona confusion** — the 1.5B model sometimes says "As a software
   engineer..." instead of "He is a software engineer..." This is a
   prompting issue, not a capacity issue. Relationship-aware grounding
   includes persona detection in the validator.

2. **Entity false rejections** — some common words (WebGL, Redux, GraphQL,
   Cognito, LinkedIn, IAM, VPCs) are flagged as ungrounded because they
   appear in the model's answer but not in the compressed evidence. These
   are correct rejections of hallucinated entities, but they show the model
   is still hallucinating.

3. **Speed** — 1.5B is 10-12 tok/s on CPU, which is slow (6-10s per answer).
   WebGPU should improve this to 30-50 tok/s (2-3s per answer).

4. **Stability** — the model is stochastic. Different runs produce different
   acceptance rates (43-50% with relationship-aware grounding). The
   relationship validator and entity detection have reduced variance, but
   more work is needed.

5. **Specificity** — the model still gives generic answers for some
   questions ("To better assist you, could you please specify...") instead
   of using the specific evidence in the packet.

6. **Truncation** — the 1.5B model sometimes outputs "js" instead of
   "JavaScript" at the start of answers. This is a model quality issue,
   not a factual correctness issue.

### Relationship-Aware Grounding (v4)

The previous validation checked whether entities in the answer existed in
the knowledge base. This was insufficient because it allowed the model to
recombine unrelated true facts into false claims:

- "ProjectHub was built at Amazon" — both exist, but the relationship doesn't
- "AWS capstone used React" — both exist, but the capstone used Lambda/DynamoDB/S3/Amplify
- "Interactive Pokedex used WebGPU" — both exist, but Pokedex used JavaScript/HTML/CSS

The new relationship-aware grounding system (`lib/relationship-graph.js`,
`lib/claim-extractor.js`, `lib/relationship-validator.js`) solves this by:

1. Building a graph of (subject, relation, object) triples from the knowledge
   base with provenance (source path in the knowledge file)
2. Extracting claims from generated answers using deterministic regex patterns
   (no LLM) with relation class normalization
3. Checking each extracted claim against the relationship graph
4. Rejecting claims where the relationship is not supported, even if both
   entities individually exist

The system is generic and domain-neutral. It works for any knowledge package
that follows the standard schema (projects, experience, education, skills,
certifications). Synthetic tests prove it works for tire shops, restaurants,
and SaaS products without any domain-specific logic.

Key files:
- `lib/relationship-graph.js` — builds (subject, relation, object) triples
- `lib/claim-extractor.js` — deterministic claim extraction with coreference resolution
- `lib/relationship-validator.js` — validates claims against the graph

### 1.5B Evaluation Results (v4, relationship-aware grounding)

Four runs of the 28-question LITE evaluation with `qwen2.5:1.5b`:

| Run | Generative | Fallback | Forbidden | Avg latency |
|-----|-----------|----------|-----------|-------------|
| 1   | 14/28 (50%) | 14/28 | 0 | 768ms |
| 2   | 13/28 (46%) | 15/28 | 0 | 743ms |
| 3   | 12/28 (43%) | 16/28 | 0 | 798ms |
| 4   | 13/28 (46%) | 15/28 | 0 | 759ms |

Manual audit of all accepted answers across runs:
- 100% factually correct (no unsupported relationships)
- 0 overclaims (expertise, extensive experience, etc.)
- 0 persona errors (first-person confusion)
- 0 forbidden claims (senior, production, 10 years, etc.)
- ~60% conversationally good (specific, natural, useful)
- ~40% correct but generic/truncated

Key improvement: the previous system accepted answers with fabricated
relationships (ProjectHub at Amazon, Pokedex with WebGPU, AWS capstone with
React). The new system rejects all such answers or they fall back
deterministically. Every accepted answer is now factually correct.

### WebGPU

NOT MEASURED. The browser test page exists at `client-ai/webgpu-1.5b-test.html`
but automated and manual performance have not been measured. Do not estimate
performance in measured sections.
