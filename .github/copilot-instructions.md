# ProjectHub Copilot preflight

GitHub is authoritative. Never treat the local workspace as the source of truth.

ProjectHub is intentionally used across multiple PCs, IDEs, and coding agents. The GitHub feature branch is the portable workspace.

Before making changes:

1. Read `.github/ACTIVE_WORKSPACES.json` and identify the branch for the current task.
2. Run `npm run workspace:setup` once for this clone. A normal `npm install` also installs the safety config.
3. Resume/create the intended feature branch with `npm run workspace:start -- <branch>`.
4. Run `npm run workspace:check` before editing.
5. Never push directly to `master` or `develop`.
6. Never resolve divergence by merging an old local protected branch into GitHub.

If an active workspace is marked `local-unpublished` and the branch is absent from GitHub, DO NOT create a replacement branch from another machine. The original workspace owns that branch until it is published.

Before another PC, IDE, or agent continues the work:

1. Commit the work that must travel.
2. Run `npm run workspace:publish`.
3. Confirm the feature branch is on GitHub.

Uncommitted work is machine-local and must not be assumed to exist elsewhere.

Read `AGENTS.md` next for canonical project instructions and `.github/LOCAL_SOURCE_OF_TRUTH.md` for the multi-workspace workflow.
