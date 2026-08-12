# AGENTS.md — ProjectHub-dev

This is the **staging repository** for ProjectHub/Scout. It publishes to `https://bradleymatera.github.io/ProjectHub-dev/` via GitHub Pages.

## Important Rules

- The **source of truth** for code, documentation, and the knowledge base is `BradleyMatera/ProjectHub`.
- This repo is a **read-only deploy target**. It receives force-pushes from the `develop` branch of `BradleyMatera/ProjectHub`.
- Do **not** edit code directly in this repository. Make changes in `BradleyMatera/ProjectHub` first, then push `develop` here for staging.
- Any environment-specific files (e.g., dev deploy scripts, staging env templates) may live here, but they must not contain secrets.

## Workflow

1. Feature work happens in `BradleyMatera/ProjectHub` on a branch off `develop`.
2. Merge into `BradleyMatera/ProjectHub:develop`.
3. Push to this repo:
   ```bash
   git push projecthub-dev develop:main
   ```
4. GitHub Pages rebuilds the staging site automatically.
5. When validated, open a pull request from `develop` to `master` in `BradleyMatera/ProjectHub`.

## Dev Environment Differences

- Widget and page title show `(dev)` branding.
- Analytics dashboard is available only on the dev site.
- The dev backend uses `stats-dev.json` and `learned-dev.json`, isolated from production.
- Think Mode runs on dev but does **not** push learned answers to the production knowledge base (`THINK_PUSH_ENABLED=false`).

## For Full Documentation

See `AGENTS.md` and `docs/common-tasks.md` in `BradleyMatera/ProjectHub`.
