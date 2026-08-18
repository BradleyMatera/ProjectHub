---
name: projecthub-git-remote-truth
description: Verify git remote state before declaring any publish/deploy step complete. Confirm not just SHAs but staging-specific packaging, backend source, and source-of-truth relationships.
---

# projecthub-git-remote-truth

## When to use

- Before and after pushing, mirroring, or deploying.
- Before declaring any gate passed.
- Whenever the user asks about the current state of repositories.

## Steps

1. **Fetch all remotes**
   - `git fetch origin`
   - `git fetch projecthub-dev`

2. **Resolve canonical SHAs**
   - `git rev-parse origin/develop`
   - `git rev-parse projecthub-dev/main`
   - `git rev-parse origin/master`

3. **Distinguish runtime source from doc-only commits**
   - `git diff --name-only <parent> <commit>` for the latest `develop` commit.
   - Runtime source is the last commit that changed executable code (`lib/`, `server-*.js`, `data/`, `ProjectHub.js`, etc.).
   - Doc-only commits do not change the runtime source.

4. **Verify staging packaging (not just SHA equality)**
   - `git show projecthub-dev/main:AGENTS.md` must be staging-specific, not `ProjectHub/AGENTS.md`.
   - `git show projecthub-dev/main:.github/workflows/pages.yml` must trigger on `branches: [main]`.
   - `git show projecthub-dev/main:STAGING-SOURCE.json` must exist and `sourceCommit` must match intended `ProjectHub/develop` commit.

5. **Verify backend source**
   - If backend was deployed, confirm the deployed SHA matches a pushed `ProjectHub/develop` commit and the runtime files are unchanged from that tree.

6. **Never accept SHA equality alone as proof of a correct mirror.**
