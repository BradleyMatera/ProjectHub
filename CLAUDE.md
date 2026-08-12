# ProjectHub agent preflight

GitHub is the source of truth. A local clone, IDE workspace, desktop copy, or agent workspace is never authoritative.

This project is intentionally used across multiple PCs, IDEs, and coding agents. Work must travel through GitHub feature branches.

Before editing anything:

1. Run `npm run workspace:setup` once for this clone. A normal `npm install` also installs the safety config.
2. Resume or create the intended feature branch from GitHub with `npm run workspace:start -- <branch>`.
3. Run `npm run workspace:check` before making changes.
4. Never push directly to `master` or `develop`.
5. Never resolve divergence by merging a stale local protected branch into GitHub.

Before handing the task to another agent, IDE, or machine:

1. Commit the work that must travel.
2. Run `npm run workspace:publish`.
3. Confirm it succeeds before telling another workspace to continue.

Uncommitted changes are machine-local and must never be assumed to exist elsewhere.

Then read `AGENTS.md`, which is the canonical project instruction file, and `.github/LOCAL_SOURCE_OF_TRUTH.md` for the multi-workspace workflow.
