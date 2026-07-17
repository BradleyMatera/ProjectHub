#!/bin/bash
# deploy-gcp-dev.sh - Deploy server-gemini.js to the staging GCP VM
# Run this from your local machine after testing on the develop branch.
#
# Requirements:
#   - Must be on the develop branch
#   - Working tree must be clean
#   - gcloud CLI authenticated with access to the VM

set -e

VM_NAME="projecthub-dev-vm"
ZONE="us-central1-a"
PROJECT="ollamaapi-501903"
REMOTE_DIR="/opt/recruiter-chat-api-dev"
LOCAL_FILE="server-gemini.js"
LOCAL_LIB_DIR="lib"
REMOTE_DATA_DIR="data"
HEALTH_URL="https://dev.projecthub-chat.bradleymatera.dev/health"
SERVICE_NAME="recruiter-chat-api-dev"

echo "=== ProjectHub Dev GCP Deploy ==="
echo ""

# --- Guards ---

# Check branch
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
if [ "$BRANCH" != "develop" ]; then
    echo "ERROR: Must be on 'develop' branch (currently on: $BRANCH)"
    echo "  git checkout develop && git pull --ff-only origin develop"
    exit 1
fi

# Check clean working tree
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "ERROR: Working tree is not clean. Commit or stash changes first."
    git status --short
    exit 1
fi

# Print commit being deployed
COMMIT_SHA=$(git rev-parse HEAD)
SHORT_SHA=$(git rev-parse --short HEAD)
echo "Deploying commit: $COMMIT_SHA"
echo "Branch: $BRANCH"
echo ""

# Check local files exist
if [ ! -f "$LOCAL_FILE" ]; then
    echo "ERROR: $LOCAL_FILE not found. Run from repo root."
    exit 1
fi

# Check syntax before upload
echo "Checking syntax..."
node --check "$LOCAL_FILE"
echo "Syntax OK"
echo ""

echo "Remote VM: $VM_NAME ($ZONE)"
echo "Remote dir: $REMOTE_DIR"
echo ""

# --- Upload ---

RELEASE_TAG="release-${SHORT_SHA}"
echo "Uploading to /tmp/${RELEASE_TAG}..."

gcloud compute scp "$LOCAL_FILE" "$VM_NAME:/tmp/${RELEASE_TAG}-server.js" --zone="$ZONE" --project="$PROJECT"
gcloud compute scp --recurse "$LOCAL_LIB_DIR" "$VM_NAME:/tmp/${RELEASE_TAG}-lib" --zone="$ZONE" --project="$PROJECT"
gcloud compute scp "$REMOTE_DATA_DIR/free-tier-limits.json" "$VM_NAME:/tmp/${RELEASE_TAG}-free-tier.json" --zone="$ZONE" --project="$PROJECT"

echo "Upload complete"
echo ""

# --- Deploy with backup and rollback ---

echo "Swapping files and restarting service..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
  set -e
  sudo mkdir -p $REMOTE_DIR/lib $REMOTE_DIR/data $REMOTE_DIR/backups
  cd $REMOTE_DIR

  RELEASE_TAG='${RELEASE_TAG}'
  BACKUP_DIR=\"backups/\$(date +%Y%m%d_%H%M%S)\"
  sudo mkdir -p \"\$BACKUP_DIR\"

  # Backup current release
  echo 'Backing up current release...'
  if [ -f server.js ]; then sudo cp server.js \"\$BACKUP_DIR/server.js\"; fi
  if [ -d lib ]; then sudo cp -r lib \"\$BACKUP_DIR/lib\"; fi
  if [ -f data/free-tier-limits.json ]; then sudo cp data/free-tier-limits.json \"\$BACKUP_DIR/free-tier-limits.json\"; fi
  echo \"Backup saved to \$BACKUP_DIR\"

  # Install new release
  echo 'Installing new release...'
  sudo mv /tmp/\${RELEASE_TAG}-server.js server.js
  sudo chmod 644 server.js
  sudo rm -rf lib.new && sudo mv /tmp/\${RELEASE_TAG}-lib lib
  sudo mv /tmp/\${RELEASE_TAG}-free-tier.json data/free-tier-limits.json
  sudo chmod 644 data/free-tier-limits.json

  # Verify syntax on VM
  node --check server.js

  # Restart service
  if systemctl is-active --quiet $SERVICE_NAME; then
      sudo systemctl restart $SERVICE_NAME
      echo 'Service restarted via systemd'
  elif command -v pm2 >/dev/null 2>&1; then
      pm2 restart $SERVICE_NAME
      echo 'Service restarted via pm2'
  else
      echo 'WARNING: Could not auto-restart service. Rolling back...'
      sudo cp \"\$BACKUP_DIR/server.js\" server.js
      sudo cp -r \"\$BACKUP_DIR/lib\" lib
      sudo systemctl restart $SERVICE_NAME || true
      exit 1
  fi

  sleep 3
  if ! systemctl is-active --quiet $SERVICE_NAME; then
      echo 'Service failed to start. Rolling back...'
      sudo cp \"\$BACKUP_DIR/server.js\" server.js
      sudo rm -rf lib && sudo cp -r \"\$BACKUP_DIR/lib\" lib
      sudo systemctl restart $SERVICE_NAME || true
      sleep 2
      if systemctl is-active --quiet $SERVICE_NAME; then
          echo 'Rollback successful — service running with previous release'
      else
          echo 'CRITICAL: Rollback failed. Manual intervention required.'
      fi
      exit 1
  fi
  echo 'Service is running'
"

# --- Health check ---

echo ""
echo "Health check..."
sleep 2
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$HEALTH_STATUS" != "200" ]; then
    echo "WARNING: Health check returned $HEALTH_STATUS (service may still be starting)"
    echo "  Check manually: curl -f $HEALTH_URL"
else
    echo "Health check OK (200)"
fi

# --- Smoke test ---

echo ""
echo "Smoke test..."
SMOKE_RESULT=$(curl -s -X POST "https://dev.projecthub-chat.bradleymatera.dev/api/chat" \
  -H "Content-Type: application/json" \
  -H "Origin: https://bradleymatera.github.io" \
  -d '{"message":"What is ProjectHub?","history":[]}' 2>/dev/null | \
  node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.reply?'OK':'FAIL')}catch{console.log('FAIL')}" 2>/dev/null || echo "FAIL")

if [ "$SMOKE_RESULT" = "OK" ]; then
    echo "Smoke test passed"
else
    echo "WARNING: Smoke test did not return a valid reply. Check manually."
fi

echo ""
echo "Dev deploy complete!"
echo "  Commit: $SHORT_SHA"
echo "  Health: $HEALTH_URL"
echo ""
echo "To rollback: SSH to VM and restore from $REMOTE_DIR/backups/"
