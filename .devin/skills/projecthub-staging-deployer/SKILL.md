---
name: projecthub-staging-deployer
description: Prepare and deploy a correct staging tree to BradleyMatera/ProjectHub-dev:main. A manual staging mirror must never be a raw `develop:main --force` push.
---

# projecthub-staging-deployer

## When to use

- After `ProjectHub/develop` is updated with frontend/runtime changes that need staging.
- Before declaring the staging mirror complete.

## Prohibited operation

A manual staging mirror must **never** be:

```bash
git push projecthub-dev develop:main --force
```

This destroys staging-specific wrapper state (`AGENTS.md`, `pages.yml`, `STAGING-SOURCE.json`).

## Required steps

1. **Start from the exact intended `ProjectHub/develop` source commit.**
   - `git fetch origin`
   - `git rev-parse origin/develop`
   - `SOURCE_SHA=$(git rev-parse origin/develop)`

2. **Build a staging worktree.**
   - `git worktree add .tmp-staging $SOURCE_SHA` or use a clean clone.

3. **Apply staging transformations.**
   - `cp .github/staging-AGENTS.md AGENTS.md`
   - `cp .github/staging-pages.yml .github/workflows/pages.yml`

4. **Generate `STAGING-SOURCE.json`.**

   ```json
   {
     "sourceRepository": "BradleyMatera/ProjectHub",
     "sourceBranch": "develop",
     "sourceCommit": "$SOURCE_SHA",
     "generatedBy": "projecthub-staging-deployer"
   }
   ```

5. **Stage those files and create the staging wrapper commit.**
   - `git add -f AGENTS.md .github/workflows/pages.yml STAGING-SOURCE.json`
   - `git commit -m "staging: mirror from ProjectHub/develop $SOURCE_SHA"`

6. **Force-push the staging wrapper tree to `BradleyMatera/ProjectHub-dev:main`.**
   - `git push projecthub-dev <wrapper-sha>:main --force`

7. **Verify remotely.**
   - `git ls-remote projecthub-dev main`
   - `git show projecthub-dev/main:STAGING-SOURCE.json`
   - `git show projecthub-dev/main:AGENTS.md` must be staging-specific.
   - `git show projecthub-dev/main:.github/workflows/pages.yml` must trigger on `main`.

8. **Verify GitHub Pages deployment.**
   - Wait for Pages build.
   - Check `https://bradleymatera.github.io/ProjectHub-dev/` returns current content.

9. **Clean up the worktree.**

## Failure modes

- If `STAGING-SOURCE.json` is missing, the mirror is invalid.
- If `pages.yml` triggers on `master`, the staging repo is broken.
- If `AGENTS.md` is the source-repo `AGENTS.md`, the staging repo is broken.
