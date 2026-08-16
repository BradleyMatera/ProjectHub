# GitHub is the source of truth

`https://github.com/BradleyMatera/ProjectHub` is authoritative. Local clones, IDE workspaces, coding-agent workspaces, laptops, desktops, and old project folders are disposable working copies and must never be treated as canonical.

This repository is expected to move between PCs, IDEs, and coding agents frequently. The same feature branch should travel through GitHub, not through machine-local history.

## Mandatory setup for every clone

Run once from the repository root:

```bash
npm run workspace:setup
```

A normal `npm install` also installs the local safety configuration automatically.

That configures this clone to:

- use the tracked `.githooks/pre-push` hook;
- block direct pushes to `master` and `develop`;
- make `git pull` and local merges fast-forward-only, so a stale local branch cannot silently create a merge commit;
- prune stale remote refs/tags;
- bind protected branches to `origin`;
- automatically set upstream tracking when a new feature branch is first pushed.

## Start or resume work on any PC / IDE

Use the same command everywhere:

```bash
npm run workspace:start -- feat/your-branch-name
```

If that branch already exists on GitHub, the command opens/tracks the GitHub branch and fast-forwards it safely.

If it does not exist yet, the command creates it from current `origin/master` and immediately publishes the new branch to GitHub.

### Temporary develop quarantine

`develop` contains older staging-specific history that diverged from modern `master`. It is preserved, not deleted, while that history is reconciled deliberately.

- Current old develop snapshot is preserved at `archive/develop-pre-multimachine-20260717`.
- Do not create new feature work from `develop` until reconciliation is complete.
- Do not merge `develop` into `master` or `master` into `develop` just to make the graphs line up.
- Portable feature work currently starts from `origin/master`.

Then run:

```bash
npm run workspace:check
```

The preflight fetches GitHub and refuses unsafe conditions such as:

- editing `master` or `develop`;
- a protected local branch being ahead of GitHub;
- a feature branch being behind/diverged from its GitHub upstream;
- the wrong `origin` repository;
- detached HEAD state.

## Before switching machines / IDEs / agents

First commit the work you want to carry with you. Then run:

```bash
npm run workspace:publish
```

This refuses to publish if:

- you are on `master` or `develop`;
- there are uncommitted changes;
- the GitHub feature branch has newer work from another machine;
- local and GitHub histories diverged.

When it succeeds, the committed feature branch is on GitHub and another machine can resume it with `workspace:start`.

### Important

**Uncommitted changes are never portable.** They only exist on the current machine. Do not shut down, swap PCs, or hand work to another agent until important changes are committed and `workspace:publish` succeeds.

## Protected branches

Do not push directly to `master` or `develop`. Open pull requests instead.

Until `develop` is reconciled, active feature work should stay on GitHub-backed feature branches created from `master`. Do not promote them automatically into production merely because `master` is the base; promotion still requires an intentional PR and validation.

## If a protected local branch diverges

STOP. Do not run a normal merge pull and do not push the divergent branch.

Preserve any local-only work on a separate backup/feature branch, fetch GitHub, inspect the divergence, and restore the protected branch from the GitHub state only after the local work is safely preserved.

Never merge an old local `master` or `develop` into the GitHub protected branch just to make `git push` succeed.

The remote repository is the source of truth. Local copies are not backups of GitHub and are not allowed to redefine repository history.
