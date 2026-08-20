---
name: projecthub-workspace-bootstrap
description: Verify and re-bootstrap the local workspace from the actual remote state before taking any action that depends on repository truth. Use at the start of every ProjectHub/Scout session.
---

# projecthub-workspace-bootstrap

## When to use

- First tool call of any new session.
- Before making commits, deploys, or evaluations.
- Whenever the workspace state is unknown or may be stale.

## Steps

1. **Identify git roots and remotes**
   - `git status --short`
   - `git branch -vv`
   - `git remote -v`

2. **Read the current handoff**
   - `docs/current-feature-handoff.md` (first 80 lines)
   - `AGENTS.md` (first 80 lines)
   - `package.json` for scripts

3. **Align with remote truth**
   - `git fetch origin`
   - `git fetch projecthub-dev`
   - Confirm local `develop` matches `origin/develop` before commits.
   - If out of sync, reset/merge/rebase before proceeding.

4. **Verify runtime source SHA**
   - `git rev-parse HEAD`
   - `git log --oneline -n 5`
   - `git diff origin/develop` (must be empty unless you are actively editing)

5. **Do not act on stale or assumed state.**
   - Re-bootstrap whenever the workspace state is unclear.
