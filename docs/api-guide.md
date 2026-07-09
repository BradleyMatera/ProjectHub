# api-guide.md

**Read when:** You need to understand or change the chat API contract, GitHub API usage, or AI fallback behavior.

---

## Local Handlers (`logic.js`)

`handleQuery` receives:

```javascript
handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData)
```

Returns:

```javascript
{ reply: "HTML string", newTopic: "topic-name" }
```

## Intents

| Intent | Trigger keywords | Data source |
|--------|------------------|-------------|
| `summary` | bradley + web dev / developer / summarize / full summary | `projects`, `codePens` |
| `github` | github + bradley / profile | static URL |
| `linkedin` | linkedin + bradley / profile | static URL |
| `project` | project name substring | `projects` + GitHub API |
| `codepen` | CodePen name substring | `codePens` |
| `platform` | platform name (github, netlify, vercel, etc.) | `projects` |
| `tech` | technology name (react, docker, etc.) | `projects` |
| `projects` / `codepen` | list / all | `projects`, `codePens` |
| `compare` | compare + two project names | `projects` |
| `stars` | most stars | GitHub API |
| `unrelated` | no match and not about Bradley | fallback proxy |

## GitHub API

- Endpoint: `https://api.github.com/repos/{owner}/{repo}`
- Headers: `Accept: application/vnd.github.v3+json`
- No authentication currently used.
- Used for: `stargazers_count`, `pushed_at`.

## Recruiter Chat API Contract

Current production URL:

```text
POST https://projecthub-chat.bradleymatera.dev/api/chat
Content-Type: application/json
```

Request body:

```json
{
  "message": "user's raw query",
  "sessionId": "stable browser session id",
  "options": {
    "memoryEnabled": true,
    "flavorEnabled": true,
    "visitorName": "Jordan"
  },
  "context": [
    { "role": "user", "content": "recent user question" },
    { "role": "assistant", "content": "recent assistant answer" }
  ]
}
```

To clear session memory, the widget sends:

```json
{
  "action": "clearMemory",
  "sessionId": "stable browser session id"
}
```

Response body:

```json
{
  "reply": "Grounded recruiter-safe answer text",
  "flavor": "Tiny generated label",
  "flavorSource": "ollama-flavor",
  "followUps": ["Optional follow-up prompt", "Optional follow-up prompt"],
  "sessionMemory": { "enabled": true, "store": "neon", "turns": 4 },
  "model": "smollm2:135m",
  "fallback": true,
  "cached": false
}
```

The browser should treat `reply` as the primary answer and render `followUps` as short suggested next questions. The current widget renders follow-ups as clickable chips and displays `flavor` as a small label before the grounded answer. The backend deliberately returns grounded deterministic answers for recruiter-critical topics and only uses Ollama for tiny 3-5 word labels or low-risk conversational wording that passes guardrails.

## Session Memory

The browser creates a per-tab `sessionId` and sends the last few turns as `context`. The Netlify router persists trimmed session memory when `NETLIFY_DATABASE_URL` or `DATABASE_URL` is configured for Netlify DB/Neon. If those env vars are absent or Neon is unavailable, it falls back to short-lived in-memory session storage inside the function instance.

Context-dependent messages such as “tell me more,” “what about that project,” or “same for AWS” bypass the global response cache so the router can use recent session context.

The widget asks for the visitor's name at the start of each browser tab session and stores it in `sessionStorage`. Personalization can be turned off in widget settings. Clear Memory resets the local transcript, session id, captured name, recent browser context, and router-persisted session memory.

Repeated or semantically repeated questions should not return the same answer verbatim. The Netlify router checks recent session memory; if the same core question has already been answered, it politely says so, quotes the useful part of the earlier answer, and offers follow-ups for proof, tradeoffs, risk, or interview wording. Forced-choice recruiter questions such as “if you had to pick one strongest role” resolve to one answer instead of cycling through target-role lists.

Profile-adjacent personal questions that are not in verified data, such as favorite food or hobbies, should go through the guarded generative fallback. The model may phrase the response naturally, but it must not invent personal facts; it should say the detail is not verified and bridge to recruiter-useful topics.

## Security Requirements for New Proxy

- Accept requests only from allowed origins via CORS.
- Run HTTPS.
- Do **not** expose `localhost:11434` to the internet.
