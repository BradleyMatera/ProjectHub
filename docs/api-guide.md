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

## Fallback Proxy Contract

Current production fallback URL:

```text
POST https://projecthub-proxy-fcecbe65b068.herokuapp.com/api/chat
Content-Type: application/json
```

Request body:

```json
{
  "message": "user's raw query"
}
```

Response body:

```json
{
  "reply": "AI-generated text"
}
```

### Planned endpoint (GCP Ollama)

```text
POST https://chat.recruiterhub.yourdomain.com/api/chat
```

Same JSON contract. The proxy will forward to Ollama’s OpenAI-compatible endpoint:

```text
http://localhost:11434/v1/chat/completions
```

## Security Requirements for New Proxy

- Accept requests only from allowed origins via CORS.
- Require a valid API key in headers.
- Run HTTPS.
- Do **not** expose `localhost:11434` to the internet.
