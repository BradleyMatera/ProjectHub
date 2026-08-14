# Base image pinned by digest for reproducibility.
# node:22.14.0-alpine3.20 @ sha256:d3bec89af3388e8a0842860fc2a6de688e3841d06a69453b552ce0b9e6be589e
FROM node:22.14.0-alpine3.20@sha256:d3bec89af3388e8a0842860fc2a6de688e3841d06a69453b552ce0b9e6be589e

WORKDIR /app

# Copy lockfile and install dependencies first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application source
COPY server-gemini.js ./
COPY lib/ ./lib/
COPY data/ ./data/
COPY scripts/ ./scripts/
COPY test/ ./test/
COPY logic.js data.js utils.js ui.js ./
COPY analytics/dist/ ./analytics/dist/

# Production environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV OLLAMA_URL=http://inference:11434
ENV GEN_MODEL=qwen2.5:1.5b
ENV GEN_ENABLED=true
ENV GEN_TIMEOUT_MS=12500
ENV OLLAMA_AGENT_ENABLED=true
ENV OLLAMA_AGENT_MODEL=qwen2.5:1.5b
ENV OLLAMA_AGENT_TIMEOUT_MS=2500
ENV OLLAMA_AGENT_CONTEXT=2048
ENV OLLAMA_AGENT_KEEP_ALIVE=-1
ENV AGENT_ENABLED=true
ENV SCOUT_AGENT_ENGINE_ENABLED=true
ENV SCOUT_AGENT_MODE=lite
ENV USE_BM25_RETRIEVAL=true
ENV RATE_LIMIT_MAX=20
ENV KNOWLEDGE_FILE=data/recruiter-knowledge.json
ENV ALLOWED_ORIGINS=https://bradleymatera.dev,https://www.bradleymatera.dev,https://bradleymatera.github.io

EXPOSE 3000

# Health check — API responds on /health
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server-gemini.js"]
