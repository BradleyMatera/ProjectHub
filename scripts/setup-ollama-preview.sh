#!/bin/bash
# Prepare the private dev VM for pre-warmed local-only Ollama conversation.
# This does not expose Ollama publicly and does not alter Caddy or the public API.

set -euo pipefail

VM_NAME="projecthub-dev-vm"
ZONE="us-central1-a"
PROJECT="ollamaapi-501903"
MODEL="qwen2.5:0.5b"
SWAP_FILE="/var/lib/projecthub/ollama.swap"

echo "Preparing ${VM_NAME} for local Ollama model ${MODEL}..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
  set -euo pipefail

  AVAILABLE_KB=\$(df --output=avail / | tail -1 | tr -d ' ')
  if [ \"\$AVAILABLE_KB\" -lt 4194304 ]; then
    echo 'ERROR: At least 4 GB of free disk is required for bounded swap, Ollama, and the model.'
    exit 1
  fi

  if ! sudo swapon --show=NAME --noheadings | grep -qF '$SWAP_FILE'; then
    sudo install -d -m 755 /var/lib/projecthub
    if [ ! -f '$SWAP_FILE' ]; then
      sudo fallocate -l 2G '$SWAP_FILE'
      sudo chmod 600 '$SWAP_FILE'
      sudo mkswap '$SWAP_FILE'
    fi
    sudo swapon '$SWAP_FILE'
    if ! grep -qF '$SWAP_FILE' /etc/fstab; then
      echo '$SWAP_FILE none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    fi
  fi

  if ! command -v ollama >/dev/null 2>&1; then
    curl -fsSL https://ollama.com/install.sh -o /tmp/projecthub-ollama-install.sh
    sudo sh /tmp/projecthub-ollama-install.sh
    unlink /tmp/projecthub-ollama-install.sh
  fi

  sudo install -d -m 755 /etc/systemd/system/ollama.service.d
  printf '%s\n' \
    '[Service]' \
    'Environment=OLLAMA_HOST=127.0.0.1:11434' \
    'Environment=OLLAMA_KEEP_ALIVE=-1' \
    'Environment=OLLAMA_NUM_PARALLEL=1' \
    'Environment=OLLAMA_MAX_LOADED_MODELS=1' \
    'Environment=OLLAMA_CONTEXT_LENGTH=1536' | sudo tee /etc/systemd/system/ollama.service.d/projecthub.conf >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now ollama
  sudo systemctl restart ollama

  for attempt in 1 2 3 4 5; do
    if curl --fail --silent http://127.0.0.1:11434/api/tags >/dev/null; then break; fi
    sleep 2
  done
  curl --fail --silent http://127.0.0.1:11434/api/tags >/dev/null
  ollama pull '$MODEL'
  timeout 120 curl --fail --silent --show-error \
    --header 'Content-Type: application/json' \
    --data '{"model":"$MODEL","prompt":"","stream":false,"keep_alive":-1,"options":{"num_ctx":1536,"num_predict":1}}' \
    http://127.0.0.1:11434/api/generate >/dev/null

  echo 'Ollama preview resources:'
  free -h
  swapon --show
  ollama list
  sudo ss -lnt '( sport = :11434 )'
"

echo "Ollama is pre-warmed on VM loopback only. Deploy the preview with: bash deploy-agent-preview.sh"
