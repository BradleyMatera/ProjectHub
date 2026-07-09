#!/bin/bash
# deploy-gcp.sh - Deploy the latest server-gcp.js to the GCP VM
# Run this from your local machine after updating the code

set -e

VM_IP="35.208.20.1"
VM_USER="ubuntu"
REMOTE_DIR="/opt/recruiter-chat-api"
LOCAL_FILE="server-gcp.js"

echo "=== ProjectHub GCP Deploy Script ==="
echo ""

# Check if server-gcp.js exists locally
if [ ! -f "$LOCAL_FILE" ]; then
    echo "❌ Error: $LOCAL_FILE not found in current directory"
    echo "   Run this script from the ProjectHub repo root"
    exit 1
fi

echo "📁 Local file: $LOCAL_FILE"
echo "🖥️  Remote VM: $VM_USER@$VM_IP"
echo "📂 Remote dir: $REMOTE_DIR"
echo ""

# Check syntax
echo "🔍 Checking syntax..."
node --check "$LOCAL_FILE"
echo "✅ Syntax OK"
echo ""

# Deploy via SCP
echo "📤 Copying $LOCAL_FILE to VM..."
scp "$LOCAL_FILE" "$VM_USER@$VM_IP:$REMOTE_DIR/server-gcp.js.new"
echo "✅ File copied"
echo ""

# SSH to swap files and restart
echo "🔄 Swapping files and restarting service..."
ssh "$VM_USER@$VM_IP" << 'REMOTE_COMMANDS'
    set -e
    cd /opt/recruiter-chat-api
    
    # Backup current file
    cp server-gcp.js server-gcp.js.backup.$(date +%Y%m%d_%H%M%S)
    
    # Swap in new file
    mv server-gcp.js.new server-gcp.js
    
    # Check syntax on VM
    node --check server-gcp.js
    
    # Restart the service (adjust based on your setup)
    if systemctl is-active --quiet recruiter-chat-api; then
        sudo systemctl restart recruiter-chat-api
        echo "✅ Service restarted via systemd"
    elif command -v pm2 &> /dev/null; then
        pm2 restart recruiter-chat-api
        echo "✅ Service restarted via pm2"
    else
        echo "⚠️  Could not auto-restart service. Please restart manually."
    fi
    
    # Show status
    sleep 2
    if systemctl is-active --quiet recruiter-chat-api; then
        echo "🟢 Service is running"
    fi
REMOTE_COMMANDS

echo ""
echo "🎉 Deploy complete!"
echo ""
echo "Test with:"
echo "  curl -X POST https://projecthub-chat.bradleymatera.dev/api/chat \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"message\": \"what's brads favorite food?\"}'"
