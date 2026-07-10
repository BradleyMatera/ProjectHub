# architecture-overview.md

**Read when:** You need to understand how ProjectHub is structured, how data flows, or how the backend AI integration works.

---

## High-Level System

```mermaid
flowchart LR
    A[Hosting Website] -- loads script --> B[ProjectHub.js on GitHub Pages]
    B --> C[ui.js renders floating chat widget]
    C --> D[logic.js matches intent]
    D --> E[data.js projects/codePens]
    D --> F[utils.js GitHub API]
    D --> G{Needs recruiter answer?}
    G -- yes --> H[GCP recruiter chat API]
    H --> M[(In-memory session cache)]
    H --> I[Free multi-provider LLM network]
    I --> J1[Groq]
    I --> J2[Cloudflare Workers AI]
    I --> J3[GitHub Models]
    I --> J4[Google Gemini]
    I --> J5[Local Ollama smollm2:135m]
    I --> K[Grounded knowledge + RAG + anti-slop validation]
```

---

## Components

| Component | Responsibility |
|-----------|----------------|
| `ProjectHub.js` | Entry point. Embeds the data, logic, utils, and UI as IIFE modules for single-file CDN consumption. |
| `data.js` | Canonical project, CodePen, and suggestion arrays. |
| `logic.js` | Intent detection, response generation, conversation history, AI fallback trigger. |
| `ui.js` | Chat DOM creation, event handling, styling, loading spinner. |
| `utils.js` | GitHub repo metadata fetcher. |
| GCP recruiter chat API | `server-gemini.js` running on a GCP VM free tier. Routes open-ended questions through a free multi-provider LLM network (Groq, Cloudflare Workers AI, GitHub Models, Gemini) with local Ollama (`smollm2:135m`) as the final fallback. Fetches the knowledge base, validates replies, and caches session memory in process. |
| Session memory | Per-tab session id with last 3 turns cached in process. |
| Recruiter knowledge | `data/recruiter-knowledge.json` hosted raw on GitHub — includes canonical facts plus `sourceMaterial` chunks. |

---

## Data Flow

1. User loads a site that embeds `https://bradleymatera.github.io/ProjectHub/ProjectHub.js`.
2. `ProjectHub.js` initializes:
   - defines `projects`, `codePens`, `suggestions`
   - defines `fetchGitHubRepoData`, `fetchAllGitHubData`
   - defines `handleQuery`
   - calls `setupChatUI(...)`
3. User types a query.
4. `ui.js` calls `handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData, chatSession)` with a per-tab session id and recent turn context.
5. `logic.js` tries exact/intent matches:
   - Bradley bio, GitHub, LinkedIn
   - project by name
   - CodePen by name
   - platform, tech, list, compare, most stars
6. If the query needs a recruiter-style answer, it calls `https://projecthub-chat.bradleymatera.dev/api/chat`.
7. The API fetches `data/recruiter-knowledge.json` from GitHub (cached in memory), builds a grounded fallback first, and then — for open-ended questions — walks the free provider network in priority order. Each provider receives a RAG prompt built from the grounded context. Replies are validated against anti-slop/false-claim rules. If no provider succeeds, the grounded answer is returned. The last 3 turns per session are kept in memory.

---

## Backend Runtime

The backend lives in this repo as `server-gemini.js` and is deployed to a GCP VM.

- **Server:** `server-gemini.js` — Express API that serves the widget endpoint and routes LLM calls through the free provider network.
- **Generative layer:** Free multi-provider LLM network (Groq, Cloudflare Workers AI, GitHub Models, Google Gemini) with local Ollama (`smollm2:135m`) as the final fallback.
- **Knowledge base:** `data/recruiter-knowledge.json` in this repo, fetched raw from GitHub. Includes canonical facts plus `sourceMaterial` chunks ingested by `scripts/build-knowledge.js`.
- **Session memory:** In-memory process cache of the last 3 turns per session.
- **Cost:** GCP Always Free VM + free LLM tiers + local Ollama. No paid LLM credits are required.
- **Agent:** The assistant is named **Scout** and uses the persona in `knowledge.agent`.

---

## Constraints

- No build step / no bundler.
- Must remain embeddable via one `<script>` tag.
- Files should stay readable in the browser without transpilation.
- Backend must fit within GCP Always Free limits.
- AI layer must remain free — free provider tiers and local Ollama only.
