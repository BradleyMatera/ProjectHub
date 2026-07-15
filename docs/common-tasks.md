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

### Production (`master`)

1. Ensure `ProjectHub.js` is up to date with source modules.
2. Commit all changes.
3. Push to `master`.
4. GitHub Pages rebuilds automatically.
5. Verify the live URL: `https://bradleymatera.github.io/ProjectHub/ProjectHub.js`

### Staging (`develop` -> `ProjectHub-dev`)

1. Make sure `develop` is clean and CI passed.
2. Push `develop` to the staging repo: `git push projecthub-dev develop:main`
3. GitHub Pages rebuilds `https://bradleymatera.github.io/ProjectHub-dev/`.
4. Verify the staging widget before opening a PR to `master`.

## Deploy the Backend

### Production (`master`)

1. Edit `server-gemini.js`.
2. Run `node --check server-gemini.js` to validate syntax.
3. Run `bash deploy-gcp.sh` to copy the file to the GCP VM and restart the `recruiter-chat-api` service.
   - Alternatively, deploy via `gcloud compute ssh`:
   ```bash
   cat server-gemini.js | gcloud compute ssh ollama-api-gate --zone=us-central1-a --project=ollamaapi-501903 --tunnel-through-iap --command="sudo tee /opt/recruiter-chat-api/server.js > /dev/null && sudo chmod 644 /opt/recruiter-chat-api/server.js && sudo systemctl restart recruiter-chat-api && sleep 15 && echo deployed"
   ```
4. Verify: `curl https://projecthub-chat.bradleymatera.dev/health`
5. Verify knowledge health: `curl https://projecthub-chat.bradleymatera.dev/api/knowledge-health`

### Staging (`develop`)

1. Edit `server-gemini.js` on the `develop` branch.
2. Run `node --check server-gemini.js`.
3. Run `bash deploy-gcp-dev.sh` to deploy to the staging VM and restart `recruiter-chat-api-dev`.
4. Verify: `curl https://dev.projecthub-chat.bradleymatera.dev/health`
5. Verify knowledge health: `curl https://dev.projecthub-chat.bradleymatera.dev/api/knowledge-health`

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

### Conversation Tests

Repository-level conversation tests exercise multi-turn behavior against the live API:

```bash
# Short scenario-based conversation test (8 scenarios, ~3-5 minutes)
python3 test-conversation.py

# Full-length conversation test (10 conversations, 8-15 messages each, ~5-8 minutes)
# Tests memory, tone adaptation, context retention, repetition, contradictions, and follow-ups.
python3 test-conversations-full.py

# Run one conversation with verbose output
python3 test-conversations-full.py --only "Follow-up heavy conversation" -v
```

## Update Documentation

1. Find the relevant `docs/` guide.
2. Make edits.
3. If navigation or quick-reference info changed, update `AGENTS.md`.
4. Keep the README and landing page (`index.html`) in sync with the new docs.


## Release Workflow

We use a `master`/`develop` model with a public staging repo (`ProjectHub-dev`) and a second GCP VM. **All changes start on `develop`.**

1. **Feature work:** branch from `develop` in `BradleyMatera/ProjectHub`.
2. **Pull request:** open a PR to `develop`. GitHub Actions runs `npm audit`, `npm run build`, checks `ProjectHub.js` freshness, and validates `server-gemini.js` syntax.
3. **Stage:** after merging to `develop`, push to the staging repo:
   ```bash
   git push projecthub-dev develop:main
   ```
   - Staging frontend: `https://bradleymatera.github.io/ProjectHub-dev/`
   - Staging backend: `https://dev.projecthub-chat.bradleymatera.dev/`
4. **Validate:** run the conversation test suites against the staging backend. Test knowledge-base changes by asking Scout sample questions on the staging widget.
5. **Release:** open a PR from `develop` to `master`. After merge, tag the release and run `bash deploy-gcp.sh`.
6. **Production verify:** check `/health`, `/api/knowledge-health`, and the live widget.

### Knowledge-Base Edits

- **All knowledge-base changes go through `develop` / `ProjectHub-dev` first.** This is especially important for new answers, role-fit wording, safety rules, and prompt changes.
- Small, low-risk edits (single typo fixes, date updates, URL corrections) may use a PR directly to `master` if they do not change answer logic or safety behavior.
- Never edit `data/recruiter-knowledge.json` on `master` and then immediately deploy the production backend without staging.
