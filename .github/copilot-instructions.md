# ProjectHub Copilot preflight

GitHub is authoritative. Never treat the local workspace as the source of truth.

Before making changes:

1. Run `npm run setup:git-safety` once for this clone.
2. `git fetch origin --prune`.
3. Create work from an up-to-date `origin/develop` on a feature branch.
4. Never push directly to `master` or `develop`.
5. Never resolve divergence by merging an old local protected branch into GitHub. Fast-forward-only sync must succeed or the agent must stop and inspect.

Read `AGENTS.md` next for canonical project instructions.
