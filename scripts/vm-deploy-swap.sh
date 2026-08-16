#!/bin/bash
# Swap in the Scout alpha release on the GCP VM with backup + rollback.
# Expects: /tmp/release-952646e-server.js, /tmp/lib-release-952646e.tar.gz,
#          /tmp/release-952646e-free-tier.json
set -e
cd /opt/recruiter-chat-api

BACKUP_DIR="backups/$(date +%Y%m%d_%H%M%S)"
sudo mkdir -p "$BACKUP_DIR"

echo "Backing up current release..."
if [ -f server.js ]; then sudo cp server.js "$BACKUP_DIR/server.js"; fi
if [ -d lib ]; then sudo cp -r lib "$BACKUP_DIR/lib"; fi
if [ -f data/free-tier-limits.json ]; then sudo cp data/free-tier-limits.json "$BACKUP_DIR/free-tier-limits.json"; fi
echo "Backup saved to $BACKUP_DIR"

echo "Installing new release..."
sudo mv /tmp/release-952646e-server.js server.js
sudo chmod 644 server.js
sudo rm -rf lib lib.new
mkdir -p /tmp/release-952646e-lib-extract
tar -xzf /tmp/lib-release-952646e.tar.gz -C /tmp/release-952646e-lib-extract
sudo mv /tmp/release-952646e-lib-extract/lib lib
rm -rf /tmp/release-952646e-lib-extract /tmp/lib-release-952646e.tar.gz
sudo mkdir -p data
sudo mv /tmp/release-952646e-free-tier.json data/free-tier-limits.json
sudo chmod 644 data/free-tier-limits.json

echo "Verifying syntax on VM..."
node --check server.js

echo "Restarting service..."
sudo systemctl restart recruiter-chat-api
sleep 3

if ! systemctl is-active --quiet recruiter-chat-api; then
  echo "Service failed to start. Rolling back..."
  sudo cp "$BACKUP_DIR/server.js" server.js
  sudo rm -rf lib && sudo cp -r "$BACKUP_DIR/lib" lib
  sudo systemctl restart recruiter-chat-api || true
  sleep 2
  if systemctl is-active --quiet recruiter-chat-api; then
    echo "Rollback successful - service running with previous release"
  else
    echo "CRITICAL: Rollback failed. Manual intervention required."
  fi
  exit 1
fi

echo "Service is running"
sudo journalctl -u recruiter-chat-api --since "-15 seconds" --no-pager | tail -8
