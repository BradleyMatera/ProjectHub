---
name: projecthub-task-completion-gate
description: Verify that a declared completion actually meets all required conditions before responding. Use for staging, deploy, and test gates.
---

# projecthub-task-completion-gate

## When to use

- Before telling the user a task is done.
- Before moving to the next major step.
- After any publish/deploy/mirror operation.

## Steps

1. **Re-read the original requirement.**
   - Confirm every stated deliverable has evidence.

2. **Check remote state.**
   - `git fetch origin`
   - `git fetch projecthub-dev`
   - `git rev-parse origin/develop`
   - `git rev-parse projecthub-dev/main`

3. **Verify staging packaging (not just SHA updated).**
   - `git show projecthub-dev/main:STAGING-SOURCE.json` present and correct.
   - `git show projecthub-dev/main:.github/workflows/pages.yml` triggers on `main`.
   - `git show projecthub-dev/main:AGENTS.md` is the staging-specific file.

4. **Verify backend (if deployed).**
   - Health URL returns 200.
   - Chat smoke test passes.
   - Deployed from a pushed `ProjectHub/develop` commit.

5. **Verify tests.**
   - `npm test` passes.
   - `npm run eval-retrieval` passes.
   - `node --check server-gemini.js` passes.
   - `git diff --check` passes.

6. **Check for local-only important work.**
   - `git status --short` must not show uncommitted runtime changes.

7. **Only then declare the gate passed.**
