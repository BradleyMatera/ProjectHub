# ProjectHub portable workspace workflow

GitHub is the source of truth for ProjectHub. PCs, IDEs, and agent workspaces are disposable clients of the GitHub repository.

## One-time setup on every clone

```bash
npm install
npm run workspace:setup
```

`npm install` installs the safety hook automatically. `workspace:setup` also fetches GitHub and verifies protected branch state.

## Start or resume the same work anywhere

```bash
npm run workspace:start -- feat/your-branch-name
npm run workspace:check
```

`workspace:start` always fetches GitHub first. Existing feature branches are resumed from `origin`; new feature branches are created from current `origin/master` and immediately published to GitHub.

`develop` is currently preserved while its older staging-only history is reconciled with modern `master`. Do not use `develop` as the base for new portable workspaces until that reconciliation is explicitly completed. Its pre-reconciliation state is preserved at `archive/develop-pre-multimachine-20260717`.

## Before switching PC, IDE, or coding agent

Commit the work that needs to travel, then run:

```bash
npm run workspace:publish
```

The command refuses to publish dirty workspaces, protected branches, or a branch that is behind/diverged from GitHub.

When it succeeds, another workspace can continue with:

```bash
npm run workspace:start -- feat/your-branch-name
```

## Rules

- GitHub `origin` is authoritative.
- Never work directly on `master` or `develop`.
- Never push directly to `master` or `develop`.
- Never merge stale local protected-branch history into GitHub.
- Never assume uncommitted changes exist on another machine.
- A machine switch is safe only after the feature branch is committed and `workspace:publish` succeeds.
- Until `develop` is reconciled, new feature branches start from `origin/master`.

See `.github/LOCAL_SOURCE_OF_TRUTH.md` for full recovery and divergence rules.
