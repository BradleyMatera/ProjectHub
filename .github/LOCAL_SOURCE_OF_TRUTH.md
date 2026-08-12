# GitHub is the source of truth

This repository on GitHub is authoritative. Local clones, IDE workspaces, coding agents, and desktop copies must never be treated as canonical.

Before any work:

1. `git fetch origin --prune`
2. confirm the intended branch
3. pull/rebase from the GitHub branch before editing
4. never push directly to `master`
5. create a feature branch and open a pull request into `develop` or `master` as appropriate

If local history diverges from GitHub unexpectedly, stop and inspect before merging or pushing. Do not merge an old local `master` into GitHub `master`.

The remote repository is the source of truth. Local copies are disposable working copies.
