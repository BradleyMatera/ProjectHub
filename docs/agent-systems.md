# Agent Systems Network

**Read when:** You are changing Scout's bounded tool workflows, Ollama agent support, or the private feature-branch preview.

## Architecture

Scout's agent path is deliberately provider-independent:

1. `shouldUseAgent()` limits agent execution to comparison, role-fit, recruiter-brief, evidence, and interview-question workflows.
2. `lib/agent-tools.js` exposes five read-only tools over the verified recruiter knowledge cache. The tools cannot browse arbitrary URLs, modify data, send messages, or access identity/contact fields.
3. Groq may plan tool calls only when both `GROQ_ENABLED=true` and `AGENT_GROQ_ENABLED=true`, with an explicit non-retired model. It is disabled by default.
4. `lib/agent-fallback.js` selects and executes the same tools deterministically if Groq is disabled, exhausted, deprecated, or invalid.
5. Local Ollama formats a compact deterministic evidence packet when `OLLAMA_AGENT_ENABLED=true`. Its output must pass the existing grounded validator; otherwise the deterministic answer is returned unchanged.
6. Normal open-ended conversation still uses the configured Cloudflare, GitHub Models, Gemini, Grok, and grounded fallback network.

This separates reasoning quality from availability: no single hosted model is required for a valid recruiter workflow.

## Resource boundary

An 8B local model is not appropriate for the current GCP `e2-micro` machines. The enhanced local path instead combines deterministic retrieval/tools with a quantized small Ollama model. The dev preview uses `gemma3:270m` because its 291 MB download and roughly 322 MB loaded footprint fit the VM. Measured on the dev e2-micro, a simple evidence-formatting request completed in 8.2 seconds cold and 0.93 seconds warm; `qwen2.5:0.5b` took 26-65 seconds and was rejected for this deployment.

To keep memory bounded, ProjectHub sends at most 2,000 characters of evidence, uses a 1,024-token context, limits output to 120 tokens, processes one generation at a time, and retains the model for only 60 seconds to make follow-ups fast. A 12-second request deadline fails safely to the deterministic answer. This makes Ollama the language layer while ProjectHub remains the factual reasoning and validation layer.

Before enabling Ollama on a host, confirm available RAM, swap, disk, installed model capabilities, and latency. Do not enable it merely because an Ollama daemon exists.

## Private feature preview

`deploy-agent-preview.sh` deploys a committed `feat/*` branch to a separate directory and service on the staging VM:

- directory: `/opt/recruiter-chat-api-feature`
- service: `projecthub-agent-preview`
- listener: `127.0.0.1:3200`
- public Caddy route: none
- Think Mode pushes: disabled
- Groq agent planning: disabled, to prove the independent fallback
- Ollama formatter: enabled with `gemma3:270m` on the prepared dev host
- state files: isolated from staging and production

Deploy and open it with:

```bash
bash scripts/setup-ollama-preview.sh
bash deploy-agent-preview.sh
bash scripts/open-agent-preview.sh
```

The second command creates an authenticated SSH port forward and opens `http://127.0.0.1:3200/preview/`. Anyone without GCP SSH access cannot reach the service. No shared password, browser-stored secret, or macOS Keychain command is involved.

To stop access, press `Ctrl-C` in the tunnel terminal. The remote service remains loopback-only.

## Promotion boundary

The private preview is not a production release. Validate its workflows, automated tests, provider status, and grounded output before merging to `develop`. After staging validation, follow `PROJECTHUB-DEVELOPMENT-AND-RELEASE-SPEC.md` for promotion to `master`.
