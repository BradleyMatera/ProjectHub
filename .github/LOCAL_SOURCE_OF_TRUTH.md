# GitHub is the source of truth

`https://github.com/BradleyMatera/ProjectHub` is authoritative. Local clones, IDE workspaces, coding-agent workspaces, laptops, desktops, and old project folders are disposable working copies and must never be treated as canonical.

## Mandatory setup for every clone

Run once from the repository root:

```bash
npm run setup:git-safety
```

That configures this clone to:

- use the tracked `.githooks/pre-push` hook;
- block direct pushes to `master` and `develop`;
- make `git pull` fast-forward-only, so a stale local branch cannot silently create a merge commit;
- prune stale remote refs;
- bind protected branches to `origin`.

## Before every work session

```bash
git fetch origin --prune
```

Then start from an up-to-date GitHub branch. Normal feature work starts from `origin/develop` on a new feature branch.

Do not push directly to `master` or `develop`. Open a pull request instead.

## If a protected local branch diverges

STOP. Do not run a normal merge pull and do not push the divergent branch.

Preserve any local-only work on a separate backup/feature branch, fetch GitHub, inspect the divergence, and restore the protected branch from the GitHub state only after the local work is safely preserved.

Never merge an old local `master` or `develop` into the GitHub protected branch just to make `git push` succeed.

The remote repository is the source of truth. Local copies are not backups of GitHub and are not allowed to redefine repository history.
