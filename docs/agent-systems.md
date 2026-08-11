# Agent Systems Network

**Read when:** You are changing Scout's bounded tool workflows, Ollama agent support, or the private feature-branch preview.

## Architecture

Scout's agent path is deliberately provider-independent:

1. `shouldUseAgent()` limits agent execution to comparison, role-fit, recruiter-brief, evidence, and interview-question workflows.
2. `lib/agent-tools.js` exposes five read-only tools over the verified recruiter knowledge cache. The tools cannot browse arbitrary URLs, modify data, send messages, or access identity/contact fields.
3. Groq may plan tool calls when `AGENT_GROQ_ENABLED=true`, but it is optional.
4. `lib/agent-fallback.js` selects and executes the same tools deterministically if Groq is disabled, exhausted, deprecated, or invalid.
5. Local Ollama may format deterministic evidence when `OLLAMA_AGENT_ENABLED=true`. Its output must pass the existing grounded validator; otherwise the deterministic answer is returned unchanged.
6. Normal open-ended conversation still uses the configured Cloudflare, GitHub Models, Gemini, Grok, and grounded fallback network.

This separates reasoning quality from availability: no single hosted model is required for a valid recruiter workflow.

## Resource boundary

An 8B local model is not appropriate for the current GCP `e2-micro` machines. The private preview therefore proves the Groq-independent deterministic tool path without loading an 8B model. The optional Ollama adapter targets a small locally installed model and is a formatter, not the source of truth.

Before enabling Ollama on a host, confirm available RAM, swap, disk, installed model capabilities, and latency. Do not enable it merely because an Ollama daemon exists.

## Private feature preview

`deploy-agent-preview.sh` deploys a committed `feat/*` branch to a separate directory and service on the staging VM:

- directory: `/opt/recruiter-chat-api-feature`
- service: `projecthub-agent-preview`
- listener: `127.0.0.1:3200`
- public Caddy route: none
- Think Mode pushes: disabled
- Groq agent planning: disabled, to prove the independent fallback
- state files: isolated from staging and production

Deploy and open it with:

```bash
bash deploy-agent-preview.sh
bash scripts/open-agent-preview.sh
```

The second command creates an authenticated SSH port forward and opens `http://127.0.0.1:3200/preview/`. Anyone without GCP SSH access cannot reach the service. No shared password, browser-stored secret, or macOS Keychain command is involved.

To stop access, press `Ctrl-C` in the tunnel terminal. The remote service remains loopback-only.

## Promotion boundary

The private preview is not a production release. Validate its workflows, automated tests, provider status, and grounded output before merging to `develop`. After staging validation, follow `PROJECTHUB-DEVELOPMENT-AND-RELEASE-SPEC.md` for promotion to `master`.
