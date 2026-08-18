---
name: projecthub-staging-deployer
description: Prepare and deploy a correct staging tree to BradleyMatera/ProjectHub-dev:main. A manual staging mirror must never be a raw `develop:main --force` push. The generated STAGING-SOURCE.json must be normal, valid, parseable UTF-8 JSON.
---

# projecthub-staging-deployer

## When to use

- After `ProjectHub/develop` is updated with frontend/runtime changes that need staging.
- Before declaring the staging mirror complete.
- Whenever `ProjectHub-dev/main:STAGING-SOURCE.json` is malformed or out of sync.

## Prohibited operation

A manual staging mirror must **never** be:

```bash
git push projecthub-dev develop:main --force
```

This destroys staging-specific wrapper state (`AGENTS.md`, `pages.yml`, `STAGING-SOURCE.json`).

## Required steps

The canonical automation is `scripts/stage-projecthub-dev.js`.

```bash
node scripts/stage-projecthub-dev.js
```

This script:

1. Fetches `origin`.
2. Resolves `ProjectHub/develop` HEAD to `SOURCE_SHA`.
3. Creates a clean worktree at `.tmp-staging` detached at `SOURCE_SHA`.
4. Applies staging transformations:
   - `cp .github/staging-AGENTS.md AGENTS.md`
   - `cp .github/staging-pages.yml .github/workflows/pages.yml`
5. Generates `STAGING-SOURCE.json` with `JSON.stringify` (no BOM, no escaped quotes, valid JSON).
6. Validates locally:
   - `JSON.parse` succeeds.
   - All required fields are present: `sourceRepository`, `sourceBranch`, `sourceCommit`, `generatedBy`.
   - `sourceCommit` equals the intended `SOURCE_SHA`.
7. Creates a wrapper commit.
8. Force-pushes the wrapper commit to `projecthub-dev:main`.
9. Verifies remotely:
   - `git ls-remote projecthub-dev main`
   - `git show projecthub-dev/main:STAGING-SOURCE.json` parses as JSON.
   - Remote `sourceCommit` matches `SOURCE_SHA`.
   - `git show projecthub-dev/main:.github/workflows/pages.yml` triggers on `main`.
   - `git show projecthub-dev/main:AGENTS.md` is staging-specific.
10. Cleans up the worktree.

## Manual fallback

If the script cannot be used, follow these exact steps and add the same validation:

```bash
SOURCE_SHA=$(git rev-parse origin/develop)
rm -rf .tmp-staging
git worktree add .tmp-staging "$SOURCE_SHA"
cd .tmp-staging
cp .github/staging-AGENTS.md AGENTS.md
cp .github/staging-pages.yml .github/workflows/pages.yml

# Generate valid JSON with no BOM and no escaped quote characters
node -e '
const fs = require("fs");
const sha = process.argv[1];
const marker = {
  sourceRepository: "BradleyMatera/ProjectHub",
  sourceBranch: "develop",
  sourceCommit: sha,
  generatedBy: "projecthub-staging-deployer"
};
fs.writeFileSync("STAGING-SOURCE.json", JSON.stringify(marker, null, 2) + "\n", "utf8");
' "$SOURCE_SHA"

# Validate the marker before committing
node -e '
const fs = require("fs");
const text = fs.readFileSync("STAGING-SOURCE.json", "utf8").replace(/^\uFEFF/, "");
const j = JSON.parse(text);
if (!j.sourceRepository || !j.sourceBranch || !j.sourceCommit || !j.generatedBy) process.exit(1);
if (j.sourceCommit !== process.argv[1]) { console.error("sourceCommit mismatch"); process.exit(1); }
console.log(j);
' "$SOURCE_SHA"

git add -f AGENTS.md .github/workflows/pages.yml STAGING-SOURCE.json
git commit -m "staging: mirror from ProjectHub/develop $SOURCE_SHA"
WRAPPER_SHA=$(git rev-parse HEAD)
git push projecthub-dev "$WRAPPER_SHA":main --force
cd ..
git worktree remove .tmp-staging
```

## Verification checklist

- `git ls-remote projecthub-dev main` returns the wrapper SHA.
- `git show projecthub-dev/main:STAGING-SOURCE.json` is valid JSON and `JSON.parse` succeeds.
- Remote `sourceCommit` matches the intended `ProjectHub/develop` source.
- Remote `pages.yml` triggers on `main`.
- Remote `AGENTS.md` is staging-specific.

## Failure modes

- If `STAGING-SOURCE.json` is missing, the mirror is invalid.
- If `STAGING-SOURCE.json` is not valid JSON, the mirror is invalid.
- If `sourceCommit` does not match the intended source, the mirror is invalid.
- If `pages.yml` triggers on `master`, the staging repo is broken.
- If `AGENTS.md` is the source-repo `AGENTS.md`, the staging repo is broken.
- The skill must not declare success merely because the marker file exists.
