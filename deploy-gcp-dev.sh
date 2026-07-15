#!/bin/bash
# deploy-gcp-dev.sh - Deploy server-gemini.js to the staging GCP VM
# Run this from your local machine after testing on the develop branch.
#
# Prerequisites:
# 1. Create the staging VM (e.g., gcloud compute instances create projecthub-dev-vm ...)
# 2. Set up Caddy + systemd service 'recruiter-chat-api-dev'
# 3. Copy .env.development.example to .env on the VM and fill in provider keys

set -e

VM_NAME="projecthub-dev-vm"
ZONE="us-central1-a"
PROJECT="ollamaapi-501903"
REMOTE_DIR="/opt/recruiter-chat-api-dev"
LOCAL_FILE="server-gemini.js"
LOCAL_LIB_DIR="lib"
REMOTE_DATA_DIR="data"

echo "=== ProjectHub Dev GCP Deploy Script ==="
echo ""

if [ ! -f "$LOCAL_FILE" ]; then
    echo "Error: $LOCAL_FILE not found in current directory"
    echo "Run this script from the ProjectHub repo root"
    exit 1
fi

echo "Local file: $LOCAL_FILE"
echo "Remote VM: $VM_NAME ($ZONE)"
echo "Remote dir: $REMOTE_DIR"
echo ""

echo "Checking syntax..."
node --check "$LOCAL_FILE"
echo "Syntax OK"
echo ""

echo "Copying $LOCAL_FILE to VM..."
gcloud compute scp "$LOCAL_FILE" "$VM_NAME:/tmp/server.js.new" --zone="$ZONE" --project="$PROJECT"
echo "File copied"
echo ""

echo "Copying lib/ files to VM..."
gcloud compute scp --recurse "$LOCAL_LIB_DIR" "$VM_NAME:/tmp/lib.new" --zone="$ZONE" --project="$PROJECT"
echo "lib/ copied"
echo ""

echo "Copying free-tier registry to VM..."
gcloud compute scp "$REMOTE_DATA_DIR/free-tier-limits.json" "$VM_NAME:/tmp/free-tier-limits.json" --zone="$ZONE" --project="$PROJECT"
echo "free-tier-limits.json copied"
echo ""

echo "Swapping files and restarting service..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
  set -e
  sudo mkdir -p $REMOTE_DIR/lib $REMOTE_DIR/data
  cd $REMOTE_DIR
  if [ -f server.js ]; then
    sudo cp server.js server.js.backup.\$(date +%Y%m%d_%H%M%S)
  fi
  sudo mv /tmp/server.js.new server.js
  sudo chmod 644 server.js
  sudo rm -rf lib && sudo mv /tmp/lib.new lib
  sudo mv /tmp/free-tier-limits.json data/free-tier-limits.json
  sudo chmod 644 data/free-tier-limits.json
  node --check server.js
  if systemctl is-active --quiet recruiter-chat-api-dev; then
      sudo systemctl restart recruiter-chat-api-dev
      echo 'Service restarted via systemd'
  elif command -v pm2 >/dev/null 2>&1; then
      pm2 restart recruiter-chat-api-dev
      echo 'Service restarted via pm2'
  else
      echo 'Could not auto-restart service. Please restart manually.'
  fi
  sleep 3
  if systemctl is-active --quiet recruiter-chat-api-dev; then
      echo 'Service is running'
  fi
"

echo ""
echo "Smoke testing endpoints..."
curl -fsS "https://dev.projecthub-chat.bradleymatera.dev/health" >/dev/null && echo "  /health OK" || echo "  /health FAILED (service may still starting)"
COST_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "https://dev.projecthub-chat.bradleymatera.dev/api/costs")
if [ "$COST_STATUS" = "200" ]; then
  echo "  /api/costs OK"
elif [ "$COST_STATUS" = "404" ]; then
  echo "  /api/costs 404 (COST_TRACKER not enabled)"
else
  echo "  /api/costs status $COST_STATUS"
fi

echo ""
echo "Dev deploy complete!"
echo ""
echo "Test with:"
echo "  curl -X POST https://dev.projecthub-chat.bradleymatera.dev/api/chat \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"message\": \"what is projecthub\"}'"
