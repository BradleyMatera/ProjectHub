#!/bin/bash
# Merge Scout alpha env vars into /opt/recruiter-chat-api/.env on the GCP VM.
# Reads KEY=VALUE lines from /tmp/scout-env-update, updates or appends each key.
set -e
cd /opt/recruiter-chat-api

BACKUP=".env.backup.$(date +%Y%m%d_%H%M%S)"
sudo cp .env "$BACKUP"
echo "Backup: $BACKUP"

while IFS='=' read -r key value; do
  [ -z "$key" ] && continue
  if sudo grep -q "^${key}=" .env; then
    sudo sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" | sudo tee -a .env > /dev/null
  fi
done < /tmp/scout-env-update

sudo rm -f /tmp/scout-env-update
echo "MERGED OK"
sudo grep -E '^(SCOUT_|CLOUDFLARE_|AGENT_ENABLED|USE_BM25|REQUEST_DEADLINE)' .env \
  | sed -E 's/(TOKEN|ACCOUNT_ID)=(.{10}).*/\1=\2...<redacted>/'
