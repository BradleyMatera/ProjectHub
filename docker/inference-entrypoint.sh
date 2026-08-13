#!/bin/sh
set -e

# Start Ollama server in background
ollama serve &
OLLAMA_PID=$!

# Wait for Ollama to be ready
echo "Waiting for Ollama to start..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "Ollama is ready"
    break
  fi
  sleep 1
done

# Pull the model if not already present
MODEL="${OLLAMA_MODEL:-qwen2.5:1.5b}"
echo "Checking for model: $MODEL"
if ! ollama list 2>/dev/null | grep -q "$MODEL"; then
  echo "Pulling $MODEL..."
  ollama pull "$MODEL"
  echo "Model $MODEL pulled successfully"
else
  echo "Model $MODEL already present"
fi

# Pre-warm the model with a minimal request
echo "Pre-warming $MODEL..."
curl -sf http://127.0.0.1:11434/api/chat -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false,\"options\":{\"num_predict\":1}}" >/dev/null 2>&1 || true
echo "Model pre-warmed"

# Record model digest for reproducibility verification
echo "=== Model Identity ==="
ollama show "$MODEL" --modelfile 2>/dev/null | grep -E "^FROM " || true
DIGEST=$(ollama show "$MODEL" --modelfile 2>/dev/null | grep "^FROM " | awk '{print $2}')
echo "MODEL_DIGEST: ${DIGEST:-unknown}"
ollama list 2>/dev/null || true
echo "=== End Model Identity ==="

echo "Inference service ready"

# Wait for the Ollama process
wait $OLLAMA_PID
