#!/bin/bash
set -e

VM_NAME="projecthub-dev-vm"
ZONE="us-central1-a"
PROJECT="ollamaapi-501903"
LOCAL_PORT="${AGENT_PREVIEW_LOCAL_PORT:-3200}"
URL="http://127.0.0.1:${LOCAL_PORT}/preview/"

echo "Opening private Scout agent preview at ${URL}"
echo "Keep this terminal open. Press Ctrl-C to close the private tunnel."

(sleep 2; open "${URL}" >/dev/null 2>&1 || true) &
exec gcloud compute ssh "${VM_NAME}" \
  --zone="${ZONE}" \
  --project="${PROJECT}" \
  -- -N -L "${LOCAL_PORT}:127.0.0.1:3200"
