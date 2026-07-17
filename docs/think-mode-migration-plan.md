# Think Mode Release Compatibility Migration Plan

## Current state

Think Mode runs every 20 minutes on the production backend. When it learns a new answer:
1. The answer is stored in `learned.json` (runtime queue)
2. `pushLearnedToGitHub()` uses the GitHub Contents API to directly commit to `master/data/recruiter-knowledge.json`
3. The knowledge cache is refreshed

This conflicts with branch protection on `master` (which requires pull requests) and with the coordinated release flow (which requires backend verification before frontend changes).

## Problem

Once `master` branch protection is enabled:
- Direct commits via the Contents API will be rejected with 403
- Learned answers will accumulate in the local queue with no way to reach production
- The queue grows indefinitely

## Target design

1. Think Mode stores candidate learned answers in its runtime queue (`learned.json`)
2. A controlled export creates a JSON patch file or a branch with a proposed update
3. The proposal targets `develop` (not `master`)
4. Tests and human review determine whether it is accepted
5. Accepted knowledge reaches production through the normal release process (PR to `master` → deploy backend → deploy Pages)

## Interim measures (implemented now)

- **Dev backend:** `THINK_PUSH_ENABLED=false` — learned answers stay local, no GitHub pushes
- **Prod backend:** `THINK_PUSH_ENABLED=true` but branch protection will reject pushes
- **Error handling:** 403 and 409 errors are logged clearly; learned answers are preserved in the local queue
- **Pages workflow:** No longer auto-deploys on `master` push, so even if a Think Mode commit somehow succeeds, it won't trigger a Pages deploy

## Implementation steps (future PRs)

1. **Add `/api/think/export` endpoint** — returns the current learned queue as a JSON patch
2. **Add `scripts/think-propose.js`** — fetches the export, creates a branch on `develop`, commits the knowledge update, opens a PR
3. **Run on a schedule** — daily or weekly, via GitHub Actions on the source repo (not the VM)
4. **Disable direct push** — set `THINK_PUSH_ENABLED=false` on production once the proposal workflow is active
5. **Review process** — Bradley reviews the PR, runs tests, merges through the normal release flow

## Environment variable reference

| Variable | Dev | Prod | Notes |
|---|---|---|---|
| `THINK_PUSH_ENABLED` | `false` | `true` (interim) → `false` (target) | Controls whether learned answers are pushed to GitHub |
| `THINK_REPO_OWNER` | `BradleyMatera` | `BradleyMatera` | GitHub repo owner for Contents API |
| `THINK_REPO_NAME` | `ProjectHub` | `ProjectHub` | GitHub repo name |
| `THINK_KNOWLEDGE_PATH` | `data/recruiter-knowledge.json` | `data/recruiter-knowledge.json` | Path to knowledge file in repo |
| `GITHUB_API_TOKEN` | Not set | Set (scoped token) | Used only when `THINK_PUSH_ENABLED=true` |
