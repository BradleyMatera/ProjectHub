#!/bin/bash
# deploy-gcp-dev.sh - Deploy server-gemini.js to the staging GCP VM
# Run this from your local machine after testing on the develop branch.

set -e

VM_NAME="projecthub-dev-vm"
ZONE="us-central1-a"
PROJECT="ollamaapi-501903"
REMOTE_DIR="/opt/recruiter-chat-api-dev"
LOCAL_FILE="server-gemini.js"

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

echo "Swapping files and restarting service..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
  set -e
  sudo mkdir -p $REMOTE_DIR
  cd $REMOTE_DIR
  if [ -f server.js ]; then
    sudo cp server.js server.js.backup.\$(date +%Y%m%d_%H%M%S)
  fi
  sudo mv /tmp/server.js.new server.js
  sudo chmod 644 server.js
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
  sleep 2
  if systemctl is-active --quiet recruiter-chat-api-dev; then
      echo 'Service is running'
  fi
"

echo ""
echo "Dev deploy complete!"
echo ""
echo "Test with:"
echo "  curl -X POST https://dev.projecthub-chat.bradleymatera.dev/api/chat \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"message\": \"what is projecthub\"}'"
