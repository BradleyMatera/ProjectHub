#!/bin/bash
# deploy-gcp.sh - Deploy server-gemini.js to the production GCP VM
# Run this from your local machine after merging to master.
#
# LEGACY DEPLOYMENT PATH: This script SCPs source files to the VM and restarts
# a systemd/PM2 service. It does NOT deploy a Docker image and does NOT provide
# build-test-deploy parity. The new containerized deployment path (Docker image
# build → test → deploy same image) is being built separately. Do NOT use this
# script for the new containerized path.
#
# Requirements:
#   - Must be on the master branch
#   - Working tree must be clean
#   - gcloud CLI authenticated with access to the VM

set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT"
LOCAL_FILE="server-gemini.js"
HEALTH_URL="https://projecthub-chat.bradleymatera.dev/health"

echo "=== ProjectHub Production GCP Deploy ==="
echo ""

# --- Guards ---

# Check branch
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "master" ]; then
    echo "ERROR: Must be on released 'master' (currently on: $BRANCH)" >&2
    exit 1
fi

# Check clean working tree
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
    echo "ERROR: Working tree is not clean. Preserve and publish changes first." >&2
    exit 1
fi

git fetch --no-tags origin refs/heads/master:refs/remotes/origin/master
if [ "$(git rev-parse HEAD)" != "$(git rev-parse refs/remotes/origin/master)" ]; then
    echo "ERROR: HEAD must match freshly fetched origin/master." >&2
    exit 1
fi

# Print commit being deployed
COMMIT_SHA=$(git rev-parse HEAD)
SHORT_SHA=$(git rev-parse --short HEAD)
if [ "${DEPLOY_APPROVED_COMMIT:-}" != "$COMMIT_SHA" ]; then
    echo "ERROR: Release approval required. Set DEPLOY_APPROVED_COMMIT to the full approved master commit after staging qualification and release PR merge." >&2
    exit 1
fi
export DEPLOY_APPROVED_COMMIT
echo "Deploying approved master commit: $COMMIT_SHA"

# Check local files exist
[ -f "$LOCAL_FILE" ] && [ -f scripts/manual-deploy-dev.js ]

# Check syntax before upload
echo "Checking deployment and server syntax..."
node --check "$LOCAL_FILE"
node --check scripts/manual-deploy-dev.js

# --- Upload ---

echo "The shared deploy driver packages only committed runtime dependencies and bundled knowledge."

# --- Deploy with backup and rollback ---

  # Backup current release
  # Install new release
  # Verify syntax on VM
  # Restart service
node scripts/manual-deploy-dev.js --production

# --- Health check ---

echo "Source, model, provider, 15s budget and readiness verified inside the rollback transaction."

# --- Smoke test ---

echo "Successful supported-reply smoke verified inside the rollback transaction."
echo "Deploy complete!"
echo "  Commit: $SHORT_SHA"
echo "  Health: $HEALTH_URL"
echo "Timestamped backups, retired files and local packs are retained; no cleanup is performed."
