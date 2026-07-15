#!/bin/bash
# provision-gcp-dev.sh
# Create and configure the staging GCP VM for ProjectHub/Scout.
# Run from repo root on a machine with gcloud auth active.
set -e

PROJECT="ollamaapi-501903"
ZONE="us-central1-a"
VM_NAME="projecthub-dev-vm"
MACHINE_TYPE="e2-micro"
BOOT_DISK_SIZE="30GB"
SERVICE_NAME="recruiter-chat-api-dev"
REMOTE_DIR="/opt/recruiter-chat-api-dev"
DOMAIN="dev.projecthub-chat.bradleymatera.dev"
CADDY_CONFIG="/etc/caddy/Caddyfile"

function echo_step() {
  echo ""
  echo "===> $1"
}

echo_step "Checking gcloud auth and project"
gcloud config set project "$PROJECT" >/dev/null
gcloud config set compute/zone "$ZONE" >/dev/null

# Check if VM already exists
if gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT" >/dev/null 2>&1; then
  echo "VM $VM_NAME already exists. Skipping creation."
else
  echo_step "Creating e2-micro VM $VM_NAME"
  gcloud compute instances create "$VM_NAME" \
    --project="$PROJECT" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --boot-disk-size="$BOOT_DISK_SIZE" \
    --boot-disk-type=pd-standard \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --tags=http-server,https-server \
    --metadata=startup-script='#!/bin/bash
      apt-get update
      apt-get install -y curl git'
fi

EXTERNAL_IP=$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
echo ""
echo "VM external IP: $EXTERNAL_IP"
echo ""
echo "ACTION REQUIRED: Create an A record in Netlify DNS:"
echo "  Host: dev.projecthub-chat"
echo "  Points to: $EXTERNAL_IP"
echo ""
read -p "Press Enter after the DNS A record is set and propagated..."

# Ensure firewall rules allow HTTP/HTTPS (tagged http-server/https-server already does this by default)
echo_step "Ensuring HTTP/HTTPS firewall rules exist"
gcloud compute firewall-rules create allow-http-dev --allow=tcp:80 --target-tags=http-server --quiet 2>/dev/null || true
gcloud compute firewall-rules create allow-https-dev --allow=tcp:443 --target-tags=https-server --quiet 2>/dev/null || true

echo_step "Installing Node.js 20, Caddy, and Git on the VM"
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
  set -e
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
    sudo apt-get install -y nodejs git
  fi
  if ! command -v caddy >/dev/null 2>&1; then
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt-get update
    sudo apt-get install -y caddy
  fi
  sudo mkdir -p $REMOTE_DIR/lib $REMOTE_DIR/data
"

echo_step "Copying application files to VM"
gcloud compute scp "server-gemini.js" "$VM_NAME:/tmp/server.js.new" --zone="$ZONE" --project="$PROJECT"
gcloud compute scp --recurse "lib" "$VM_NAME:/tmp/lib.new" --zone="$ZONE" --project="$PROJECT"
gcloud compute scp "data/free-tier-limits.json" "$VM_NAME:/tmp/free-tier-limits.json" --zone="$ZONE" --project="$PROJECT"

echo_step "Writing environment file on VM"
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
  sudo tee $REMOTE_DIR/.env <<'EOF'
PORT=3000
KNOWLEDGE_URL=https://raw.githubusercontent.com/BradleyMatera/ProjectHub/develop/data/recruiter-knowledge.json
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8000,https://bradleymatera.github.io,https://bradleymatera.github.io/ProjectHub-dev
PROVIDER_ORDER=groq,cloudflare,github,gemini,grok
GEN_TIMEOUT_MS=13000
GEN_MODEL=smollm2:135m
GEN_ENABLED=true
RATE_LIMIT_MAX=20
STATS_FILE=stats-dev.json
LEARNED_FILE=learned-dev.json
COST_TRACKER=true
COST_FILE=costs-dev.json
THINK_PUSH_ENABLED=false
GROQ_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
GITHUB_MODELS_TOKEN=
GEMINI_API_KEY=
XAI_API_KEY=
GROQ_DAILY_LIMIT=100
CLOUDFLARE_DAILY_LIMIT=50
GITHUB_DAILY_LIMIT=25
GEMINI_DAILY_LIMIT=150
XAI_DAILY_LIMIT=50
EOF
  sudo chmod 600 $REMOTE_DIR/.env
"

echo_step "Installing application on VM"
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
  set -e
  cd $REMOTE_DIR
  sudo rm -f server.js
  sudo mv /tmp/server.js.new server.js
  sudo rm -rf lib && sudo mv /tmp/lib.new lib
  sudo mv /tmp/free-tier-limits.json data/free-tier-limits.json
  sudo chmod 644 server.js data/free-tier-limits.json
  sudo chown -R root:root $REMOTE_DIR
  node --check server.js
"

echo_step "Creating systemd service $SERVICE_NAME"
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
  sudo tee /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=ProjectHub Dev Recruiter Chat API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$REMOTE_DIR
EnvironmentFile=$REMOTE_DIR/.env
ExecStart=/usr/bin/node $REMOTE_DIR/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable $SERVICE_NAME
  sudo systemctl start $SERVICE_NAME
"

echo_step "Configuring Caddy reverse proxy for $DOMAIN"
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
  sudo tee $CADDY_CONFIG <<EOF
$DOMAIN {
  reverse_proxy 127.0.0.1:3000
}
EOF
  sudo systemctl reload caddy || sudo systemctl restart caddy
"

echo_step "Waiting for service and HTTPS to come up..."
sleep 5
for i in 1 2 3 4 5; do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
    echo "  /health OK"
    break
  fi
  echo "  retry $i..."
  sleep 5
done

echo ""
echo "=== Dev environment provisioned ==="
echo "Backend: https://$DOMAIN"
echo "Frontend: https://bradleymatera.github.io/ProjectHub-dev/"
echo ""
echo "Test:"
echo "  curl https://$DOMAIN/health"
echo "  curl https://$DOMAIN/api/costs"
echo ""
echo "Remember to fill in provider API keys in $REMOTE_DIR/.env and restart the service."
