# data-guide.md

**Read when:** You need to add, remove, or modify project, CodePen, or suggestion data.

---

## Data Files

- `data.js` — canonical source for `projects`, `codePens`, and `suggestions`.
- `ProjectHub.js` — currently contains an inlined copy of the same data for CDN distribution.

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
3. Open the widget locally and verify the new data appears in dropdowns and responses.
4. Commit and push to `main`.
5. Confirm on GitHub Pages after the build finishes.

## Data Integrity Tips

- Keep `name` values stable; `logic.js` matches against them.
- Avoid duplicate tech strings; `logic.js` deduplicates via `Set`.
- Make sure every `repo` points to a valid `https://github.com/BradleyMatera/...` URL.
