# ProjectHub Copilot preflight

GitHub is authoritative. Never treat the local workspace as the source of truth.

ProjectHub is intentionally used across multiple PCs, IDEs, and coding agents. The GitHub feature branch is the portable workspace.

Before making changes:

1. Run `npm run workspace:setup` once for this clone. A normal `npm install` also installs the safety config.
2. Resume/create the intended feature branch with `npm run workspace:start -- <branch>`.
3. Run `npm run workspace:check` before editing.
4. Never push directly to `master` or `develop`.
5. Never resolve divergence by merging an old local protected branch into GitHub.

Before another PC, IDE, or agent continues the work:

1. Commit the work that must travel.
2. Run `npm run workspace:publish`.
3. Confirm the feature branch is on GitHub.

Uncommitted work is machine-local and must not be assumed to exist elsewhere.

Read `AGENTS.md` next for canonical project instructions and `.github/LOCAL_SOURCE_OF_TRUTH.md` for the multi-workspace workflow.
