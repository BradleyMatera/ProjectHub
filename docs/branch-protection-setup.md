# Branch Protection and Environment Setup

This guide describes the manual GitHub Settings actions required to enforce the release discipline defined in `PROJECTHUB-DEVELOPMENT-AND-RELEASE-SPEC.md`.

Run `scripts/setup-branch-protection.sh` to configure everything via the GitHub API, or follow the manual steps below.

---

## 1. Protect `master` branch

**Settings → Branches → Add branch protection rule**

- **Branch name pattern:** `master`
- **Require a pull request before merging:** ✓
  - **Required approvals:** 0 (single maintainer — self-merge allowed when checks pass)
  - **Dismiss stale pull request approvals when new commits are pushed:** ✓
  - **Require review from Code Owners:** ✗ (no CODEOWNERS file)
- **Require status checks to pass before merging:** ✓
  - **Require branches to be up to date before merging:** ✓
  - **Required checks:** `Test and Verify / verify`
- **Require conversation resolution before merging:** ✓
- **Do not allow bypassing the above settings:** ✓
- **Restrict who can push to matching branches:** ✗ (let PRs handle it)
- **Allow force pushes:** ✗ (Never)
- **Allow deletions:** ✗ (Never)

## 2. Protect `develop` branch

**Settings → Branches → Add branch protection rule**

- **Branch name pattern:** `develop`
- **Require a pull request before merging:** ✓
  - **Required approvals:** 0
- **Require status checks to pass before merging:** ✓
  - **Required checks:** `Test and Verify / verify`
- **Allow force pushes:** ✗
- **Allow deletions:** ✗

## 3. Create GitHub environments

**Settings → Environments**

### `staging`
- **Name:** staging
- **Deployment branches:** `develop` (or all branches — staging deploys from `ProjectHub-dev:main` which is synced from develop)
- **Wait for approval:** No (automatic after sync workflow)
- **Environment secrets:** None required (staging token is in repo secrets)

### `production`
- **Name:** production
- **Deployment branches:** `master`
- **Required reviewers:** Bradley Matera
- **Wait timer:** 0 minutes
- **Environment secrets:** None required for Pages deploy (backend deploys are manual via `deploy-gcp.sh`)

## 4. Notes for single-maintainer repositories

GitHub does not allow self-approval of pull requests. With only one maintainer:

- Set **Required approvals** to 0 — PRs can be merged by the author when CI passes
- The pull request requirement still provides value: it creates a reviewable diff and runs CI
- Force-push and deletion protection are the most important rules
- The `production` environment's required reviewer provides the manual approval gate for Pages deploys

## 5. Verify configuration

After setup, verify:

```bash
gh api repos/BradleyMatera/ProjectHub/branches/master/protection --jq '.required_status_checks.contexts'
gh api repos/BradleyMatera/ProjectHub/branches/develop/protection --jq '.required_status_checks.contexts'
gh api repos/BradleyMatera/ProjectHub/environments --jq '.environments[].name'
```
