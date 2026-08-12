#!/bin/bash
# deploy-gcp.sh - Deploy the latest server-gemini.js to the GCP VM
# Run this from your local machine after updating the code

set -e

VM_NAME="ollama-api-gate"
ZONE="us-central1-a"
PROJECT="ollamaapi-501903"
REMOTE_DIR="/opt/recruiter-chat-api"
LOCAL_FILE="server-gemini.js"
LOCAL_LIB_DIR="lib"
REMOTE_DATA_DIR="data"

echo "=== ProjectHub GCP Deploy Script ==="
echo ""

# Check if server-gemini.js exists locally
if [ ! -f "$LOCAL_FILE" ]; then
    echo "❌ Error: $LOCAL_FILE not found in current directory"
    echo "   Run this script from the ProjectHub repo root"
    exit 1
fi

echo "📁 Local file: $LOCAL_FILE"
echo "🖥️  Remote VM: $VM_NAME ($ZONE)"
echo "📂 Remote dir: $REMOTE_DIR"
echo ""

# Check syntax
echo "🔍 Checking syntax..."
node --check "$LOCAL_FILE"
echo "✅ Syntax OK"
echo ""

# Deploy via SCP
echo "📤 Copying $LOCAL_FILE to VM..."
gcloud compute scp "$LOCAL_FILE" "$VM_NAME:/tmp/server.js.new" --zone="$ZONE" --project="$PROJECT"
echo "✅ File copied"
echo ""

echo "📤 Copying lib/ files to VM..."
gcloud compute scp --recurse "$LOCAL_LIB_DIR" "$VM_NAME:/tmp/lib.new" --zone="$ZONE" --project="$PROJECT"
echo "✅ lib/ copied"
echo ""

echo "📤 Copying free-tier registry to VM..."
gcloud compute scp "$REMOTE_DATA_DIR/free-tier-limits.json" "$VM_NAME:/tmp/free-tier-limits.json" --zone="$ZONE" --project="$PROJECT"
echo "✅ free-tier-limits.json copied"
echo ""

# SSH to swap files and restart
echo "🔄 Swapping files and restarting service..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
  set -e
  cd /opt/recruiter-chat-api
  if [ -f server.js ]; then
    sudo cp server.js server.js.backup.\$(date +%Y%m%d_%H%M%S)
  fi
  sudo mv /tmp/server.js.new server.js
  sudo chmod 644 server.js
  sudo rm -rf lib && sudo mv /tmp/lib.new lib
  sudo mkdir -p data && sudo mv /tmp/free-tier-limits.json data/free-tier-limits.json
  sudo chmod 644 data/free-tier-limits.json
  node --check server.js
  if systemctl is-active --quiet recruiter-chat-api; then
      sudo systemctl restart recruiter-chat-api
      echo '✅ Service restarted via systemd'
  elif command -v pm2 >/dev/null 2>&1; then
      pm2 restart recruiter-chat-api
      echo '✅ Service restarted via pm2'
  else
      echo '⚠️  Could not auto-restart service. Please restart manually.'
  fi
  sleep 2
  if systemctl is-active --quiet recruiter-chat-api; then
      echo '🟢 Service is running'
  fi
"

echo ""
echo "🎉 Deploy complete!"
echo ""
echo "Test with:"
echo "  curl -X POST https://projecthub-chat.bradleymatera.dev/api/chat \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"message\": \"what's brads favorite food?\"}'"
