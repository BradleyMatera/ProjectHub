#!/bin/bash
# Deploy the current feature branch as a private, loopback-only preview on the
# staging VM. The service is not added to Caddy and is reachable only through
# scripts/open-agent-preview.sh and an authenticated gcloud SSH session.

set -euo pipefail

VM_NAME="projecthub-dev-vm"
ZONE="us-central1-a"
PROJECT="ollamaapi-501903"
REMOTE_DIR="/opt/recruiter-chat-api-feature"
SOURCE_ENV="/opt/recruiter-chat-api-dev/.env"
SERVICE_NAME="projecthub-agent-preview"
PREVIEW_PORT="3200"

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
if [[ "$BRANCH" != feat/* ]]; then
  echo "ERROR: Private previews must be deployed from a feat/* branch (currently: $BRANCH)."
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree is not clean. Commit the exact preview before deploying."
  git status --short
  exit 1
fi

for path in server-gemini.js lib agent-preview data/free-tier-limits.json data/recruiter-knowledge.json deploy/projecthub-agent-preview.service; do
  if [ ! -e "$path" ]; then
    echo "ERROR: Required preview path is missing: $path"
    exit 1
  fi
done

SHORT_SHA=$(git rev-parse --short HEAD)
RELEASE_TAG="agent-preview-${SHORT_SHA}"
REMOTE_TMP="/tmp/${RELEASE_TAG}"

echo "Testing private agent preview commit ${SHORT_SHA}..."
node --check server-gemini.js
node --check agent-preview/app.js
npm test

echo "Preparing isolated upload on ${VM_NAME}..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" \
  --command="rm -rf '$REMOTE_TMP' && mkdir -p '$REMOTE_TMP'"
gcloud compute scp server-gemini.js "$VM_NAME:$REMOTE_TMP/server.js" --zone="$ZONE" --project="$PROJECT"
gcloud compute scp --recurse lib "$VM_NAME:$REMOTE_TMP/" --zone="$ZONE" --project="$PROJECT"
gcloud compute scp --recurse agent-preview "$VM_NAME:$REMOTE_TMP/" --zone="$ZONE" --project="$PROJECT"
gcloud compute scp data/free-tier-limits.json "$VM_NAME:$REMOTE_TMP/free-tier-limits.json" --zone="$ZONE" --project="$PROJECT"
gcloud compute scp data/recruiter-knowledge.json "$VM_NAME:$REMOTE_TMP/recruiter-knowledge.json" --zone="$ZONE" --project="$PROJECT"
gcloud compute scp deploy/projecthub-agent-preview.service "$VM_NAME:$REMOTE_TMP/projecthub-agent-preview.service" --zone="$ZONE" --project="$PROJECT"

echo "Installing loopback-only service without a public Caddy route..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
  set -euo pipefail
  test -f '$SOURCE_ENV'
  test -d /opt/recruiter-chat-api-dev/node_modules
  curl --fail --silent http://127.0.0.1:11434/api/tags | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);if(!(d.models||[]).some(m=>m.name.startsWith('qwen2.5:0.5b')))process.exit(1)})\"

  sudo install -d -m 755 '$REMOTE_DIR' '$REMOTE_DIR/data' '$REMOTE_DIR/backups'
  if [ -f '$REMOTE_DIR/server.js' ]; then
    BACKUP_DIR='$REMOTE_DIR/backups/'\"\$(date +%Y%m%d_%H%M%S)\"
    sudo install -d -m 755 \"\$BACKUP_DIR\"
    sudo cp '$REMOTE_DIR/server.js' \"\$BACKUP_DIR/server.js\"
    [ ! -d '$REMOTE_DIR/lib' ] || sudo cp -r '$REMOTE_DIR/lib' \"\$BACKUP_DIR/lib\"
    [ ! -d '$REMOTE_DIR/agent-preview' ] || sudo cp -r '$REMOTE_DIR/agent-preview' \"\$BACKUP_DIR/agent-preview\"
  fi

  sudo install -m 644 '$REMOTE_TMP/server.js' '$REMOTE_DIR/server.js'
  sudo rm -rf '$REMOTE_DIR/lib' '$REMOTE_DIR/agent-preview'
  sudo cp -r '$REMOTE_TMP/lib' '$REMOTE_DIR/lib'
  sudo cp -r '$REMOTE_TMP/agent-preview' '$REMOTE_DIR/agent-preview'
  sudo install -m 644 '$REMOTE_TMP/free-tier-limits.json' '$REMOTE_DIR/data/free-tier-limits.json'
  sudo install -m 644 '$REMOTE_TMP/recruiter-knowledge.json' '$REMOTE_DIR/data/recruiter-knowledge.json'
  sudo ln -sfn /opt/recruiter-chat-api-dev/node_modules '$REMOTE_DIR/node_modules'

  sudo grep -Ev '^(PORT|LOCAL_ONLY_MODE|PROVIDER_ORDER|KNOWLEDGE_FILE|FEATURE_PREVIEW_ENABLED|AGENT_ENABLED|AGENT_GROQ_ENABLED|GROQ_ENABLED|GROQ_MODEL|GROQ_AGENT_MODEL|GEMINI_MODEL|OLLAMA_AGENT_ENABLED|OLLAMA_AGENT_MODEL|OLLAMA_AGENT_TIMEOUT_MS|OLLAMA_AGENT_CONTEXT|OLLAMA_AGENT_KEEP_ALIVE|OLLAMA_URL|GEN_ENABLED|GEN_MODEL|GEN_TIMEOUT_MS|THINK_PUSH_ENABLED|THINK_|GITHUB_TOKEN|GITHUB_PAT|STATS_FILE|LEARNED_FILE|COST_FILE|USE_VECTOR_RETRIEVAL)=' '$SOURCE_ENV' > /tmp/projecthub-agent-preview.env
  printf '%s\n' \
    'PORT=$PREVIEW_PORT' \
    'LOCAL_ONLY_MODE=true' \
    'PROVIDER_ORDER=' \
    'KNOWLEDGE_FILE=data/recruiter-knowledge.json' \
    'FEATURE_PREVIEW_ENABLED=true' \
    'AGENT_ENABLED=true' \
    'GROQ_ENABLED=false' \
    'GROQ_MODEL=' \
    'GROQ_AGENT_MODEL=' \
    'AGENT_GROQ_ENABLED=false' \
    'GEMINI_MODEL=gemini-3.6-flash' \
    'OLLAMA_AGENT_ENABLED=true' \
    'OLLAMA_AGENT_MODEL=qwen2.5:0.5b' \
    'OLLAMA_AGENT_TIMEOUT_MS=2500' \
    'OLLAMA_AGENT_CONTEXT=1536' \
    'OLLAMA_AGENT_KEEP_ALIVE=-1' \
    'GEN_ENABLED=true' \
    'GEN_MODEL=qwen2.5:0.5b' \
    'GEN_TIMEOUT_MS=14500' \
    'THINK_PUSH_ENABLED=false' \
    'USE_VECTOR_RETRIEVAL=false' \
    'STATS_FILE=stats-feature.json' \
    'LEARNED_FILE=learned-feature.json' \
    'COST_FILE=costs-feature.json' >> /tmp/projecthub-agent-preview.env
  sudo install -m 600 /tmp/projecthub-agent-preview.env '$REMOTE_DIR/.env'
  rm -f /tmp/projecthub-agent-preview.env

  timeout 120 curl --fail --silent --show-error \
    --header 'Content-Type: application/json' \
    --data '{\"model\":\"qwen2.5:0.5b\",\"prompt\":\"\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_ctx\":1536,\"num_predict\":1,\"num_thread\":2}}' \
    http://127.0.0.1:11434/api/generate >/dev/null

  sudo install -m 644 '$REMOTE_TMP/projecthub-agent-preview.service' /etc/systemd/system/$SERVICE_NAME.service
  cd '$REMOTE_DIR'
  node --check server.js
  sudo systemctl daemon-reload
  sudo systemctl enable --now $SERVICE_NAME
  sudo systemctl restart $SERVICE_NAME

  for attempt in 1 2 3 4 5; do
    if curl --fail --silent 'http://127.0.0.1:$PREVIEW_PORT/health' >/tmp/projecthub-agent-health.json; then break; fi
    sleep 2
  done
  systemctl is-active --quiet $SERVICE_NAME
  curl --fail --silent 'http://127.0.0.1:$PREVIEW_PORT/preview/' >/dev/null
  node -e \"const h=require('/tmp/projecthub-agent-health.json'); if(!h.ok || !h.localOnly || h.providerOrder.length || !h.agent?.enabled || h.agent.groqPlannerEnabled || !h.agent.ollamaControllerEnabled || h.agent.ollamaModel!=='qwen2.5:0.5b' || h.agent.groqModel || !h.agent.deterministicFallback) process.exit(1); console.log(JSON.stringify({ok:h.ok, localOnly:h.localOnly, agent:h.agent, providerOrder:h.providerOrder, providers:h.providers.map(p=>({slug:p.slug,enabled:p.enabled,blockedReason:p.blockedReason}))}, null, 2))\"
  rm -rf '$REMOTE_TMP' /tmp/projecthub-agent-health.json
"

echo "Private preview deployed from ${BRANCH} at commit ${SHORT_SHA}."
echo "It has no public URL. Open it with: bash scripts/open-agent-preview.sh"
