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
5. Commit and push to `master`; GitHub Pages will redeploy.

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
3. Push to `master`.
4. GitHub Pages rebuilds automatically.
5. Verify the live URL: `https://bradleymatera.github.io/ProjectHub/ProjectHub.js`

## Deploy the Backend

1. Edit `server-gemini.js`.
2. Run `node --check server-gemini.js` to validate syntax.
3. Run `bash deploy-gcp.sh` to copy the file to the GCP VM and restart the `recruiter-chat-api` service.
   - Alternatively, deploy via `gcloud compute ssh`:
   ```bash
   cat server-gemini.js | gcloud compute ssh ollama-api-gate --zone=us-central1-a --project=ollamaapi-501903 --tunnel-through-iap --command="sudo tee /opt/recruiter-chat-api/server.js > /dev/null && sudo chmod 644 /opt/recruiter-chat-api/server.js && sudo systemctl restart recruiter-chat-api && sleep 15 && echo deployed"
   ```
4. Verify: `curl https://projecthub-chat.bradleymatera.dev/health`
5. Verify knowledge health: `curl https://projecthub-chat.bradleymatera.dev/api/knowledge-health`

## Test the Live API

```bash
# Health and provider status
curl https://projecthub-chat.bradleymatera.dev/health

# Knowledge base coverage
curl https://projecthub-chat.bradleymatera.dev/api/knowledge-health

# Simple recruiter question
curl -X POST https://projecthub-chat.bradleymatera.dev/api/chat \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://bradleymatera.github.io' \
  -d '{"message":"What is Bradley strongest technical area?","history":[{"user":"hi","assistant":"hello"}]}'

# Manually trigger think mode
curl -X POST https://projecthub-chat.bradleymatera.dev/api/think
```

## Run Test Suites

Test suites live in `/tmp/test-suite-*.py` and run against the live API. Run them sequentially with delays to avoid 429 rate limits:

```bash
# Run all suites sequentially
python3 /tmp/test-suite-adversarial.py && sleep 20 && \
python3 /tmp/test-suite-coverage.py && sleep 20 && \
python3 /tmp/test-suite-load.py && sleep 20 && \
python3 /tmp/test-suite-regression.py && sleep 20 && \
python3 /tmp/test-suite-edge-cases.py && sleep 20 && \
python3 /tmp/test-suite-verification.py
```

| Suite | File | Tests |
|-------|------|-------|
| Adversarial | `/tmp/test-suite-adversarial.py` | 67 |
| Coverage | `/tmp/test-suite-coverage.py` | 162 |
| Load/Stress | `/tmp/test-suite-load.py` | 41 |
| Regression | `/tmp/test-suite-regression.py` | 62 |
| Edge Cases | `/tmp/test-suite-edge-cases.py` | 28 |
| Verification | `/tmp/test-suite-verification.py` | 115 |

## Update Documentation

1. Find the relevant `docs/` guide.
2. Make edits.
3. If navigation or quick-reference info changed, update `AGENTS.md`.
4. Keep the README and landing page (`index.html`) in sync with the new docs.
