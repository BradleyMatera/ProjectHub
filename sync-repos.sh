#!/bin/bash
# sync-repos.sh — Commit current changes and sync ProjectHub develop -> ProjectHub-dev main
# Run from the ProjectHub repo root.

set -e

cd "$(dirname "$0")"

# Remove any stale git locks
rm -f .git/index.lock .git/HEAD.lock .git/refs/heads/*.lock 2>/dev/null || true

# Show status
git status --short

echo ""
read -p "Press Enter to commit and push, or Ctrl-C to cancel..."

# Stage and commit
git add -f .github/staging-AGENTS.md .github/workflows/sync-staging.yml AGENTS.md

git commit -m "Add persistent staging AGENTS.md and fix staging repo visibility note" || true

# Push to develop
git push origin develop

# Sync to staging repo
git push projecthub-dev develop:main --force

echo ""
echo "Sync complete."
