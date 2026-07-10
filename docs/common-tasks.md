# common-tasks.md

**Read when:** You need step-by-step workflows for routine development, testing, publishing, or maintenance.

---

## Add a New Project

1. Open `data.js`.
2. Add a new object to the `projects` array with these fields:
   - `name` (string)
   - `desc` (string)
   - `url` (string, live/demo URL)
   - `platform` (string, e.g., GitHub Pages, Netlify, Vercel)
   - `repo` (string, GitHub URL)
   - `tech` (array of strings)
   - `apiEndpoint` (string or `null`)
3. If `ProjectHub.js` still contains the inlined data module, mirror the change there.
4. Test locally by opening `local-test.html` or any HTML file that loads the widget.
5. Commit and push to `main`; GitHub Pages will redeploy.

## Add a New CodePen

1. Open `data.js`.
2. Add `{ name: "...", url: "..." }` to the `codePens` array.
3. Optionally add the name to `suggestions`.
4. Mirror in `ProjectHub.js` if needed.
5. Push.

## Add a New Suggestion

1. Open `data.js`.
2. Add the string to the `suggestions` array.
3. Mirror in `ProjectHub.js` if needed.

## Add or Modify a Query Intent

1. Open `logic.js`.
2. Locate the `handleQuery` function.
3. Add a new conditional block or modify an existing one.
4. Update `newTopic` to enable follow-up context.
5. Test with the local HTML file.
6. Mirror changes in `ProjectHub.js` if it is the live deployment file.

## Test the Widget Locally

```bash
# Simplest way
open local-test.html

# Or serve via a tiny static server
npx serve .
```

Check the browser console for errors. Verify:
- widget renders
- suggestions populate
- known queries return correct answers
- GitHub metadata loads (stars, last commit)
- recruiter questions hit the backend and return grounded or provider-generated answers

## Publish to GitHub Pages

1. Ensure `ProjectHub.js` is up to date with source modules.
2. Commit all changes.
3. Push to `main`.
4. GitHub Pages rebuilds automatically.
5. Verify the live URL: `https://bradleymatera.github.io/ProjectHub/ProjectHub.js`

## Deploy the Backend

1. Edit `server-gemini.js`.
2. Run `node --check server-gemini.js` to validate syntax.
3. Run `bash deploy-gcp.sh` to copy the file to the GCP VM and restart the `recruiter-chat-api` service.
4. Verify: `curl https://projecthub-chat.bradleymatera.dev/health`

## Test the Live API

```bash
# Health and provider status
curl https://projecthub-chat.bradleymatera.dev/health

# Simple recruiter question
curl -X POST https://projecthub-chat.bradleymatera.dev/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is Bradley strongest technical area?"}'
```

## Update Documentation

1. Find the relevant `docs/` guide.
2. Make edits.
3. If navigation or quick-reference info changed, update `AGENTS.md`.
4. Keep the README and landing page (`index.html`) in sync with the new docs.
