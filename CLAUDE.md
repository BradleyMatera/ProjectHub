# ProjectHub agent preflight

GitHub is the source of truth. A local clone, IDE workspace, desktop copy, or agent workspace is never authoritative.

Before editing anything:

1. Run `npm run setup:git-safety` once for this clone.
2. Run `git fetch origin --prune`.
3. Start work from an up-to-date `origin/develop` on a feature branch.
4. Never push directly to `master` or `develop`.
5. Never merge a stale local `master`/`develop` into GitHub. If fast-forward-only sync fails, stop and inspect the divergence.

Then read `AGENTS.md`, which is the canonical project instruction file.
