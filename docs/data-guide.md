# data-guide.md

**Read when:** You need to add, remove, or modify project, CodePen, or suggestion data.

---

## Data Files

- `data.js` — canonical source for `projects`, `codePens`, and `suggestions`.
- `data/recruiter-knowledge.json` — canonical facts and guardrails for the recruiter assistant.
- `ProjectHub.js` — currently contains an inlined copy of the same data for CDN distribution.
- `scripts/build-knowledge.js` — ingests blog posts, site pages, project docs, and resume guardrails into `data/recruiter-knowledge.json` as `sourceMaterial`.

## Project Schema

```javascript
{
  name: "Project Name",
  desc: "Short description.",
  url: "https://live-demo-url.com/",
  platform: "GitHub Pages | Netlify | Vercel | GitHub",
  repo: "https://github.com/BradleyMatera/repo-name",
  tech: ["JavaScript", "React", "Node.js"],
  apiEndpoint: null // or a live API URL
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Unique, display name. Used for intent matching. |
| `desc` | yes | 1–3 sentence description. |
| `url` | yes | Live/demo URL or repo URL if no live site. |
| `platform` | yes | Hosting platform. Used for platform filters. |
| `repo` | yes | GitHub repo URL. Used for star/last-commit lookup. |
| `tech` | yes | Array of technology strings. Used for tech filters. |
| `apiEndpoint` | no | Optional live API endpoint for advanced queries. |

## CodePen Schema

```javascript
{
  name: "CodePen Title",
  url: "https://codepen.io/student-account-bradley-matera/pen/..."
}
```

## Suggestions Schema

Plain strings shown in the chat dropdown:

```javascript
[
  "What project has the most stars?",
  "Tell me about Interactive Pokedex"
]
```

## Update Workflow

1. Edit `data.js`.
2. If `ProjectHub.js` still contains the inlined data module, mirror the change there.
3. Open `local-test.html` locally and verify the new data appears in dropdowns and responses.
4. Commit and push to `main`.
5. Confirm on GitHub Pages after the build finishes.

## Recruiter Knowledge

`data/recruiter-knowledge.json` contains `identity`, `summary`, `goals`, `education`, `certifications`, `skills`, `experience`, `projects`, `faq`, `interviewStories`, `rules`, and `agent`.

## sourceMaterial

`sourceMaterial` is an array of chunks ingested by `scripts/build-knowledge.js` from the portfolio site, blog posts, and resume guardrails. Each chunk has:

```json
{
  "title": "Source title",
  "source": "file://path/to/file",
  "tags": ["blog", "website", "resume"],
  "content": "Plain text chunk..."
}
```

The backend `buildRagChunks` adds these to the retriever, so open-ended questions can RAG from the full body of source material.

## Update Workflow for Knowledge

1. Run `node scripts/build-knowledge.js` to regenerate `sourceMaterial` from source files.
2. Edit canonical sections in `data/recruiter-knowledge.json` manually if needed.
3. Commit and push the JSON.
4. The backend reads the raw GitHub URL; wait for the cache to refresh or restart the API.

## Data Integrity Tips

- Keep `name` values stable; `logic.js` matches against them.
- Avoid duplicate tech strings; `logic.js` deduplicates via `Set`.
- Make sure every `repo` points to a valid `https://github.com/BradleyMatera/...` URL.
