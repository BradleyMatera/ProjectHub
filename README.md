# 💬 ProjectHub 🤖 — Scout

[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=000&style=for-the-badge)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![AI Powered](https://img.shields.io/badge/AI-Powered-blueviolet?style=for-the-badge)]()
[![Hosted on GitHub Pages](https://img.shields.io/badge/Hosted-GitHub_Pages-181717?logo=github&logoColor=white&style=for-the-badge)](https://bradleymatera.github.io/ProjectHub/)
[![Free Tier](https://img.shields.io/badge/Stack-100%25%20Free-34d399?style=for-the-badge)]()

> **ProjectHub** is an **embeddable AI chat widget** powered by **Scout**, a free multi-provider recruiter assistant.
> It showcases my **projects, CodePens, skills, and background**, and answers recruiter questions from verified data — running entirely on free tiers.

---

## Table of Contents

1. [Quick Start](#-quick-start)
2. [Architecture Overview](#-architecture-overview)
3. [GitHub Knowledge Base Sync](#-github-knowledge-base-sync)
4. [Learning System (Think Mode)](#-learning-system-think-mode)
5. [Chat Pipeline (Step by Step)](#-chat-pipeline-step-by-step)
6. [Free Multi-Provider LLM Network](#-free-multi-provider-llm-network)
7. [Dashboard & Live Monitoring](#-dashboard--live-monitoring)
8. [Scout Intelligence](#-scout-intelligence)
9. [Analytics & Tracking](#-analytics--tracking)
10. [API Reference](#-api-reference)
11. [File Structure](#-file-structure)
12. [How Is This Free?](#-how-is-this-free)
13. [Deployment](#-deployment)
14. [Example Queries](#-example-queries)
15. [Links](#-links)

---

## 🚀 Quick Start

Add the ProjectHub chat widget to any site with one script tag:

```html
<script src="https://bradleymatera.github.io/ProjectHub/ProjectHub.js"></script>
```

This injects a floating chat widget in the bottom-right corner. Visitors can ask about projects, skills, AWS experience, role fit, and more. Each session starts by asking the visitor's name.

> If a consumer caches the script aggressively, append `?v=2` for cache-busting.

---

## 🏗 Architecture Overview

ProjectHub has three layers, all running on free infrastructure:

```
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND (GitHub Pages)                                        │
│  index.html · ProjectHub.js · data.js · logic.js · ui.js       │
│  Vanilla JS · No build step · No framework · No bundler         │
└────────────────────────┬────────────────────────────────────────┘
                         │ POST /api/chat
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  BACKEND (GCP e2-micro VM · Caddy HTTPS)                        │
│  server-gemini.js · Node.js / Express                           │
│                                                                 │
│  1. Fetch knowledge JSON from GitHub (cached 5 min)             │
│  2. Safety check — block injection, XSS, social engineering      │
│  3. False-claim check — refuse exaggerated/untrue claims         │
│  4. Check learned answers (from think mode)                      │
│  5. Compute grounded deterministic answer                        │
│  6. Route to free LLM providers if question is open-ended        │
│  7. Validate LLM reply against source facts                      │
│  8. Shape reply (tone, length, format)                           │
│  9. Return reply + pipeline + follow-ups                         │
│                                                                 │
│  Background: Think mode runs every 10 min                      │
│  → Processes stashed questions through LLM providers           │
│  → Validates and stores learned answers                        │
│  → Pushes learned answers back to GitHub knowledge JSON        │
└────────────────────────┬────────────────────────────────────────┘
                         │ fetch / push
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  GITHUB REPO (BradleyMatera/ProjectHub)                         │
│  data/recruiter-knowledge.json ← canonical knowledge base       │
│                                                                 │
│  FETCH: Server pulls this JSON every 5 min (cache)              │
│  PUSH:  Think mode writes learned answers back to this file     │
│         via GitHub Contents API (PUT request with SHA)          │
└─────────────────────────────────────────────────────────────────┘
```

### Key design principles

- **Grounded-first**: Every question gets a deterministic answer computed from the knowledge JSON. LLM providers only enhance open-ended questions — they never replace the grounded answer.
- **Validate everything**: Every LLM reply is validated against the source facts. If it fails validation, the grounded answer is returned instead.
- **Degrade, don't break**: If all LLM providers are exhausted, you still get a fast, correct grounded answer.
- **Learn and improve**: Questions Scout can't answer well are stashed, processed by think mode, and the learned answers are pushed back to the knowledge JSON on GitHub.

---

## 🔄 GitHub Knowledge Base Sync

This is the **bidirectional sync** between the GCP VM server and the GitHub repo. It is **not** a one-way pull — the server both reads from and writes to the knowledge JSON on GitHub.

### Direction 1: Server FETCHES from GitHub (read)

```
Server → fetch(KNOWLEDGE_URL) → raw.githubusercontent.com → data/recruiter-knowledge.json
```

- **URL**: `https://raw.githubusercontent.com/BradleyMatera/ProjectHub/master/data/recruiter-knowledge.json`
- **Cache**: 5 minutes in memory (`KNOWLEDGE_CACHE_MS = 5 * 60 * 1000`)
- **Fallback**: If the fetch fails, the server uses the last cached copy
- **Purpose**: This is the canonical source of truth for all of Scout's knowledge — identity, skills, projects, experience, education, certifications, target roles, rules, FAQ, and learned answers

The knowledge JSON contains:
- `agent` — Scout's name and persona
- `identity` — Bradley's name, title, location, contact info, short pitch
- `summary` — Who I am, what I do, what I'm looking for, core strengths
- `skills` — Languages, frameworks, cloud, tools
- `projects` — Project array with names, descriptions, tech stacks, links
- `experience` — Work history array
- `education` — Degree, school, GPA, graduation date
- `certifications` — AWS certs, AI Practitioner, etc.
- `goals` — Target roles
- `rules` — What Scout must not do (no hallucination, no overselling)
- `learnedAnswers` — Array of Q&A pairs learned by think mode and pushed back to this file

### Direction 2: Server PUSHES to GitHub (write)

```
Server → GitHub Contents API (PUT) → data/recruiter-knowledge.json
```

- **API**: `https://api.github.com/repos/BradleyMatera/ProjectHub/contents/data/recruiter-knowledge.json`
- **Auth**: `GITHUB_TOKEN` environment variable on the VM
- **Method**: `PUT` with the file's current SHA (to avoid conflicts)
- **Trigger**: Think mode pushes after successfully learning new answers
- **What gets pushed**: New `learnedAnswers` entries are appended to the existing JSON

#### Push flow (step by step)

1. Think mode processes stashed questions through LLM providers
2. For each successfully learned answer, it stores it in `learned.json` on the VM
3. After the batch, `pushLearnedToGitHub()` is called:
   - **GET** the current file from GitHub API → retrieves SHA + content
   - Parse the existing JSON, add new answers to `learnedAnswers[]` (dedup by question)
   - **PUT** the updated JSON back to GitHub with the SHA (atomic update)
   - Commit message: `"Scout learned N new answer(s) via think mode"`
4. If push succeeds, the local `learned.json` queue is cleared
5. The knowledge cache is force-refreshed (`knowledgeCacheAt = 0`) so the next request picks up the new answers
6. If push fails (no token, API error, conflict), learned answers stay in `learned.json` and will be retried next think cycle

#### What this means

- **The knowledge JSON on GitHub is the single source of truth.**
- The server reads it, caches it, and writes learned answers back to it.
- Anyone who edits `data/recruiter-knowledge.json` on GitHub changes what Scout knows — the server picks up changes within 5 minutes.
- Think mode's learned answers become permanent — they survive server restarts because they're in the repo.
- The `learnedAnswers` array in the JSON grows over time as Scout learns more.

### Why not a database?

- The knowledge base is small (one JSON file, ~5KB)
- GitHub provides free hosting, versioning, and an API for reading/writing
- No database hosting cost, no connection management, no schema migrations
- Changes are tracked in git history — you can see exactly when Scout learned something
- The GitHub Contents API handles concurrent access via SHA-based conflict detection

---

## 🧠 Learning System (Think Mode)

Scout has a self-improvement loop called **think mode** that runs automatically every 10 minutes on the VM.

### How it works

```
Recruiter asks question
        │
        ▼
Scout gives weak answer? ──yes──→ Stash question in learned.json
        │ no                              │
        ▼                                 ▼
Return good answer              Think mode runs (every 10 min)
                                        │
                                        ▼
                                Process up to 5 stashed questions
                                        │
                                        ▼
                                Try ALL LLM providers (not just first)
                                Pick the best (longest valid) answer
                                        │
                                        ▼
                                Validate against source facts
                                        │
                               ┌────────┴────────┐
                               │ pass             │ fail
                               ▼                  ▼
                          Store as learned    Re-stash for retry
                          Push to GitHub
                          Clear local queue
                          Force knowledge refresh
```

### What makes a "weak answer"?

A reply is stashed for learning if:
- It came from a grounded handler but the question was open-ended (not in `mustStayGrounded`)
- The LLM network failed and the grounded fallback was used
- The answer is too short or generic

### Think mode quality (Phase E improvements)

- **Multi-provider best-answer**: Instead of taking the first valid LLM reply, think mode now tries ALL providers and picks the longest valid answer (more complete = better)
- **Full prompt validation**: Answers are validated against the full RAG prompt text, not just the raw JSON — this allows paraphrasing while still checking facts
- **Slop removal**: Each candidate answer is cleaned through `removeSlop()` which strips corporate buzzwords, AI preambles, and disallowed phrases

### Files involved

| File | Location | Purpose |
|------|----------|---------|
| `learned.json` | VM filesystem (`/opt/recruiter-chat-api/learned.json`) | Runtime storage for stashed questions and learned answers pending push |
| `data/recruiter-knowledge.json` | GitHub repo | Canonical knowledge base; `learnedAnswers` array is appended to by think mode |
| `stats.json` | VM filesystem | Persistent analytics (requests, topics, referrers, hourly trends, provider health) |

### Manual trigger

```
POST https://projecthub-chat.bradleymatera.dev/api/think
```

This triggers think mode immediately instead of waiting for the 10-minute interval.

---

## 🧭 Chat Pipeline (Step by Step)

Every chat request goes through a deterministic pipeline. The `pipeline` field in the API response shows exactly which steps were taken:

```
1. Cache check
   ├── Cache hit → return cached reply (pipeline: ["cache-hit"])
   └── Cache miss → continue

2. Knowledge load
   ├── Fetch from GitHub (or use 5-min cache)
   └── If unavailable → grounded fallback (pipeline: ["knowledge-unavailable"])

3. Safety check (in `buildGroundedFallbackPayload`)
   ├── Injection/XSS/social engineering → blocked (pipeline: ["grounded"])
   └── Pass → continue

4. False-claim check
   ├── Exaggerated/untrue claims → refused with honest alternative
   └── Pass → continue

5. Learned answer check
   ├── Hit → return learned answer (pipeline: ["learned-check:hit"])
   └── Miss → continue

6. Grounded answer computation
   └── Always computed — deterministic reply from knowledge JSON

7. mustStayGrounded check
   ├── true → use grounded answer (saves LLM quota)
   └── false → try LLM network

8. LLM network (if needed)
   ├── Try providers in order: groq → cloudflare → github → gemini → grok → ollama
   ├── First valid reply wins → use it (pipeline: ["network:groq:success"])
   └── All fail → use grounded answer (pipeline: ["network:all-failed"])

9. Reply shaping
   └── Apply tone, length, format rules (pipeline: ["shaped"])

10. Frustration detection
    └── If user seems frustrated → strip preambles, be ultra-direct

11. Follow-up generation
    └── Generate 2 contextual follow-up suggestions based on topic

12. Weak answer check
    └── If answer is weak → stash for think mode learning

13. Return response
    └── { reply, provider, model, pipeline, followUps, grounded, fallback }
```

### Example pipeline values

- `["cache-hit"]` — served from response cache
- `["cache-miss", "knowledge-loaded", "learned-check:miss", "mustStayGrounded:true", "shaped"]` — grounded answer, no LLM needed
- `["cache-miss", "knowledge-loaded", "learned-check:miss", "mustStayGrounded:false", "network:groq:success", "shaped"]` — LLM via Groq
- `["cache-miss", "knowledge-loaded", "learned-check:hit"]` — answered from learned answers

---

## 🌐 Free Multi-Provider LLM Network

Scout never relies on a single paid API. It rotates through free providers:

| Provider | Type | Model | Daily Limit | Cooldown on failure |
|----------|------|-------|-------------|---------------------|
| **Groq** | OpenAI-compatible | `llama-3.1-8b-instant` | 1000 | 60s (rate limit), 24h (credits) |
| **Cloudflare Workers AI** | Cloudflare | `@cf/meta/llama-3.2-3b-instruct` | 300 | 60s (rate limit), 24h (credits) |
| **GitHub Models** | OpenAI-compatible | `openai/gpt-4o-mini` | 150 | 60s (rate limit), 24h (credits) |
| **Google Gemini** | Gemini | `gemini-2.0-flash` | 1500 | 60s (rate limit), 24h (credits) |
| **xAI Grok** | OpenAI-compatible | `grok-4.3` | 1000 | 60s (rate limit), 24h (credits) |
| **OpenAI-compatible** | OpenAI-compatible | configurable | 200 | 60s (rate limit), 24h (credits) |
| **Local Ollama** | Ollama | `smollm2:135m` | ∞ | N/A (runs on VM CPU) |

### Provider order

Configurable via `PROVIDER_ORDER` env var. Default: `groq,cloudflare,github,gemini,grok,ollama`

The server tracks success/failure/avg latency per provider in `stats.json` and exposes it on the dashboard:

- **Success rate** — percentage of successful responses
- **Average latency** — mean response time in ms
- **Failure count** — total failures (rate limits, timeouts, invalid output)

### Validation

Every LLM reply is validated against the source facts:
1. **Slop removal** — strips corporate buzzwords, AI preambles
2. **Length check** — minimum 15 characters
3. **Fact validation** — reply must be grounded in the source text (no hallucination)
4. **OUT_OF_SCOPE check** — rejects replies that say the question is out of scope

If validation fails, the next provider is tried. If all fail, the grounded answer is returned.

---

## 📊 Dashboard & Live Monitoring

The dashboard at [bradleymatera.github.io/ProjectHub](https://bradleymatera.github.io/ProjectHub/) shows real-time stats from the running backend. It refreshes every 5 seconds.

### Dashboard sections

| Section | What it shows |
|---------|---------------|
| **API status** | Online/offline, uptime, requests this restart, all-time requests |
| **Answer breakdown** | Grounded vs LLM vs cached vs learned counts |
| **Last provider** | Which provider answered the most recent request |
| **Provider table** | Per-provider status, used today, daily limit, all-time usage |
| **Live activity feed** | Real-time stream of requests with provider, latency, topic, and full pipeline path |
| **Last request pipeline** | Visual breakdown of the decision path for the most recent request |
| **Where visitors come from** | Referrer domain breakdown (which sites embed the widget) |
| **What recruiters ask about** | Topic analytics — most asked topics with bar charts |
| **Request trend (24h)** | Stacked bar chart showing requests per hour, split by grounded/LLM/cached |
| **Knowledge coverage gaps** | Stashed questions and "other" topic questions that lack dedicated handlers |
| **Provider health history** | Success rate, avg latency, and failure count per provider |
| **Recent sessions** | Active chat sessions with visitor intent, turn count, topics, duration |
| **Learning system** | Stashed count, learned count, think mode status, GitHub sync status |
| **Recent requests** | Last 40 requests with provider, time, latency, topic, referrer |

### Visitor intent classification

Every visitor is classified based on their question patterns:

| Intent | Trigger | Color on dashboard |
|--------|---------|-------------------|
| `recruiter` | Asks about role fit, experience, skills, gaps | Green |
| `casual` | "Hi", "what is this", first message | Blue |
| `bot` | Very short generic queries (test, ping) | Red |
| `engaged` | Has 2+ turns of history | Yellow |
| `visitor` | Default | Purple |

---

## 🧠 Scout Intelligence

### Conversation memory

- **5 turns** of history sent to the server (increased from 3)
- **10 turns** kept in the frontend conversation context (increased from 8)
- **Conversation summary** — after 3+ turns, the LLM prompt includes a summary of topics already covered to avoid repetition

### Follow-up suggestions

Every response includes 0-2 contextual follow-up questions based on the topic:

| Topic | Example follow-ups |
|-------|-------------------|
| AWS | "What about his AWS certifications?", "Did he do real production work at AWS?" |
| Projects | "What tech stack does he use?", "Which project is most relevant?" |
| Skills | "What are his strongest skills?", "How does he debug issues?" |
| Role fit | "Is he a fit for a junior web role?", "What are his honest gaps?" |

### Frustration detection

When Scout detects frustration patterns ("just answer", "not making sense", "stop avoiding"), it:
- Strips all preambles and apologies
- Removes follow-up suggestions
- Returns only the direct answer
- Logs the frustration event in the pipeline

### Grounded handlers

Scout has 40+ deterministic handlers for common recruiter questions:

- Projects, CodePens, portfolio
- AWS experience, certifications, internship reality check
- Skills, tech stack, strongest skills
- Education, GPA, coursework
- Experience, work history, CIRIS
- Contact info, LinkedIn, email
- Role fit (junior web, cloud support, DevOps, SRE, data science, QA)
- Strengths, weaknesses, honest gaps
- Interpersonal skills, customer service, teamwork
- Army/military service
- Salary (honest: not in the data)
- Summary (short, full, web dev focused)
- "What data do you have" — lists available topics
- Confusion/clarification — apologetic redirect
- Out-of-scope — honest refusal for non-recruiter questions
- Prompt injection / security — refuses to reveal system info

### `mustStayGrounded` function

Certain question patterns are forced to use grounded answers (no LLM) to save quota and ensure accuracy:
- Role fit questions ("is he a good fit for...")
- Honest assessment questions ("is he worth interviewing")
- AWS reality checks ("what happened there")
- Interpersonal/social skills
- Customer service / help desk
- Work style, coding style, problem-solving
- Learning style, mentorship
- Experience, work history, background
- "What data do you have"
- Confusion/clarification prompts
- Out-of-scope questions (not recruiter-related)
- Safety/injection attempts (always blocked)
- False-claim requests (always refused with honest alternative)
- Smoke tests, greetings, meta questions about the bot
- Interview questions, banned buzzwords

### Think Mode safety

Think Mode filters questions before stashing to prevent learning false claims:
- Safety regex blocks injection, XSS, social engineering, secret extraction
- False-claim regex blocks requests to describe Bradley as senior/10x/rockstar/etc.
- Tone/style requests are not stashed
- Out-of-scope questions are not stashed
- Format/shape requests (JSON, table, bullet) are not stashed

In `buildGroundedFallbackPayload`, the check order is:
1. Safety regex (injection, secrets, social engineering)
2. False-claim regex (exaggerated claims, buzzwords) — runs BEFORE learned answers
3. Learned answers (from GitHub knowledge)
4. Grounded handlers (40+ deterministic handlers)

This ensures that even if a false-claim answer was accidentally learned, it is always blocked.

---

## 🧪 Test Suites

ProjectHub has 6 comprehensive test suites (474+ tests total):

| Suite | Tests | Purpose |
|-------|-------|---------|
| **Adversarial** | 67 | Prompt injection, XSS, social engineering, false claims, data exfiltration |
| **Coverage** | 162 | Every grounded handler path returns expected reply |
| **Load/Stress** | 41 | Concurrency, rapid-fire, session continuity, cache, rate limits |
| **Regression** | 62 | Topic classification, provider routing, gap questions, banned words |
| **Edge Cases** | 28 | Empty input, long input, special chars, unicode, rapid session |
| **Verification** | 115 | ETL pipeline, cost, infrastructure, data integrity, Think Mode safety |

All tests run against the live API at `https://projecthub-chat.bradleymatera.dev`.

---

## 📈 Analytics & Tracking

The server tracks detailed analytics in `stats.json` on the VM:

| Metric | What it tracks |
|--------|---------------|
| `recentRequests` | Last 40 requests with question, provider, timestamp, referrer, topic, latency, pipeline |
| `referrerBreakdown` | Count per referrer domain (which sites embed the widget) |
| `topicBreakdown` | Daily counts per topic category (projects, aws, skills, etc.) |
| `hourlyRequests` | Per-hour counts split by grounded/LLM/cached (last 48h) |
| `providerHealth` | Per-provider success count, failure count, avg latency |
| `lastPipeline` | Full decision path of the most recent request |
| `recentSessions` | Active chat sessions with intent, turns, topics, duration |
| `providerBreakdown` | All-time count per provider |
| `deployCount` | Number of server deployments |
| `totalRequestsAllTime` | Total requests across all restarts |

### Topic classification

Every incoming question is classified into one of 16 topics:

`projects` · `aws` · `skills` · `experience` · `education` · `contact` · `role-fit` · `strengths` · `weaknesses` · `interpersonal` · `salary` · `army` · `work-style` · `summary` · `out-of-scope` · `other`

The `other` topic is highlighted on the dashboard as a potential knowledge gap.

---

## 🔌 API Reference

### `POST /api/chat`

Send a chat message and receive Scout's reply.

```json
// Request
{
  "message": "What AWS experience does Bradley have?",
  "sessionId": "ph_abc123_xyz",
  "history": [
    { "user": "Who is Bradley?", "assistant": "Bradley is a junior..." }
  ]
}

// Response
{
  "reply": "Bradley completed an AWS Cloud Support Engineer internship...",
  "provider": "grounded",
  "model": "knowledge-json",
  "grounded": true,
  "fallback": false,
  "pipeline": ["cache-miss", "knowledge-loaded", "learned-check:miss", "mustStayGrounded:true", "shaped"],
  "followUps": ["What about his AWS certifications?", "Did he do real production work at AWS?"]
}
```

### `GET /health`

Returns full server status, provider table, recent requests, analytics, and learning system stats.

### `GET /api/knowledge-health`

Returns knowledge base coverage report:

```json
{
  "ok": true,
  "knowledgeVersion": "1.1.0",
  "fieldCoverage": {
    "total": 79,
    "populated": 79,
    "empty": [],
    "coveragePercent": 100
  },
  "gapClusters": [
    { "topic": "serverless+architecture", "count": 3, "examples": ["..."] }
  ],
  "hotTopics": [["aws", 27], ["role-fit", 23]],
  "uncoveredTopics": [["other", 97]],
  "learnedAnswers": [...],
  "stashedCount": 13,
  "learnedCount": 0
}
```

### `POST /api/think`

Manually trigger think mode to process stashed questions immediately.

---

## 📁 File Structure

| File | Purpose |
|------|---------|
| `ProjectHub.js` | Entry point; concatenation of data.js + utils.js + logic.js + ui.js |
| `data.js` | Canonical project/CodePen/suggestion data arrays |
| `logic.js` | Query intent detection, AI backend calls, response generation |
| `ui.js` | DOM creation, event handling, chat widget rendering |
| `utils.js` | Shared helpers (GitHub API fetching) |
| `server-gemini.js` | Backend server — chat API, LLM network, learning system, analytics |
| `data/recruiter-knowledge.json` | Canonical knowledge base (read by server, written by think mode) |
| `index.html` | Public GitHub Pages landing site + live dashboard |
| `local-test.html` | Local test page for the widget |
| `live-test.html` | Cache-busting test of the live GitHub Pages script |
| `deploy-gcp.sh` | Deploy script — copies server-gemini.js to GCP VM and restarts service |
| `docs/` | Detailed on-demand guides |
| `AGENTS.md` | Canonical instruction source for AI coding agents |

### Rebuilding ProjectHub.js

After editing `data.js`, `utils.js`, `logic.js`, or `ui.js`:

```bash
cat data.js utils.js logic.js ui.js > ProjectHub.js
```

The inlined copies in `ProjectHub.js` are a deployment artifact and should stay in sync with the source files.

---

## 💸 How Is This Free?

ProjectHub runs on **zero recurring AI spend** and only free-tier infrastructure.

### Frontend — free

- **GitHub Pages** hosts all static assets free for public repos
- No build step, no bundler, no CI/CD needed
- Widget consumed via one `<script>` tag

### Backend — free

- **GCP e2-micro VM** in Always Free region (`us-central1`)
  - 720 free instance hours/month = 24/7 operation
  - 30 GB standard persistent disk included
- **Caddy** handles HTTPS with free Let's Encrypt certificates
- **No database** — knowledge JSON on GitHub, stats in local files
- **No paid Node dependencies**

### AI / LLM — free

- **6 free LLM providers** with automatic failover
- Local Ollama as unlimited final fallback
- Daily quota guards per provider
- Every reply validated against source facts

### What this avoids

- No OpenAI, Anthropic, or paid API subscriptions
- No database hosting
- No paid serverless functions
- No paid DNS or domain transfer

### Honest caveats

- Free LLM providers have caps that can change
- On a very busy day, all providers could be exhausted — Scout degrades to grounded answers, not errors
- Local Ollama (`smollm2:135m`) is a small model — less natural than cloud providers but always available
- The widget is designed to degrade, not break

---

## 🚢 Deployment

### Frontend (GitHub Pages)

1. Commit and push to `master`
2. GitHub Pages rebuilds automatically from the default branch
3. Live at `https://bradleymatera.github.io/ProjectHub/`

### Backend (GCP VM)

```bash
bash deploy-gcp.sh
```

This script:
1. Copies `server-gemini.js` to the GCP VM via `gcloud compute scp`
2. Restarts the systemd service (`recruiter-chat-api`)
3. Verifies the service is running
4. No downtime — the swap is atomic

### Environment variables on the VM

The server reads API keys and config from `.env` on the VM:

```
GROQ_API_KEY=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
GITHUB_TOKEN=...          # Used for both GitHub Models LLM AND knowledge JSON push
GEMINI_API_KEY=...
XAI_API_KEY=...
KNOWLEDGE_URL=https://raw.githubusercontent.com/BradleyMatera/ProjectHub/master/data/recruiter-knowledge.json
PROVIDER_ORDER=groq,cloudflare,github,gemini,grok,ollama
```

> The `GITHUB_TOKEN` is dual-purpose: it authenticates to GitHub Models for LLM calls AND authorizes think mode to push learned answers back to the knowledge JSON via the GitHub Contents API.

---

## 💡 Example Queries

Try asking Scout:

- **Project Inquiry** → *"Tell me about Interactive Pokedex"*
- **AWS Experience** → *"What AWS experience does Bradley have?"*
- **Role Fit** → *"Would Bradley be a good fit for a junior web role?"*
- **Honest Assessment** → *"What are his honest gaps?"*
- **Interpersonal** → *"How is Brad with people?"*
- **Customer Service** → *"What about customer service experience?"*
- **Strengths** → *"What are his strongest skills?"*
- **Contact** → *"How can I reach Bradley?"*
- **Summary** → *"Summarize Bradley as a web developer"*

---

## 🔗 Links

- 🌍 [Live Demo + Dashboard (GitHub Pages)](https://bradleymatera.github.io/ProjectHub/)
- 📂 [Repository](https://github.com/BradleyMatera/ProjectHub)
- 💼 [LinkedIn](https://www.linkedin.com/in/bradmatera)
- 🐙 [GitHub Profile](https://github.com/BradleyMatera)
- 🏥 [API Health Check](https://projecthub-chat.bradleymatera.dev/health)
- 📊 [Knowledge Health](https://projecthub-chat.bradleymatera.dev/api/knowledge-health)

---

## 🤝 Contributions

Contributions welcome! Fork the repo, open issues, or submit PRs.

---

## 📄 License

MIT License

---

<p align="center">
  <img src="https://komarev.com/ghpvc/?username=BradleyMatera&style=flat-square&color=blue" alt="Profile views" />
</p>
