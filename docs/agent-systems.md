# Agent Systems Network

**Read when:** You are changing Scout's bounded tool workflows, Ollama agent support, or the private feature-branch preview.

## Architecture

Scout's production agent path is local-only and grounded:

1. `shouldUseAgent()` limits agent execution to comparison, role-fit, recruiter-brief, evidence, and interview-question workflows.
2. `lib/agent-tools.js` exposes five read-only tools over the verified recruiter knowledge cache. The tools cannot browse arbitrary URLs, modify data, send messages, or access identity/contact fields.
3. `lib/agent-fallback.js` selects and executes the tools deterministically, so tool choice never depends on a remote provider.
4. Pre-warmed local Ollama may choose an allowlisted style for tool answers, but it never rewrites their facts.
5. Open-ended recruiter conversation uses local Ollama RAG with up to five recent turns and the session's prior topic stances.
6. `LOCAL_ONLY_MODE=true` empties the cloud provider order, disables cloud-provider health eligibility, reads the bundled local knowledge JSON, and forces Think Mode pushes off.
7. Every local free-text reply must pass strict source overlap, entity, number, length, safety, and overclaim checks. Any failure returns the deterministic grounded answer.

This separates factual reasoning from language generation: Ollama makes open-ended answers more conversational, while ProjectHub owns memory, retrieval, tools, facts, and validation.

## Resource boundary

An 8B local model is not appropriate for the current GCP `e2-micro` machines. `gemma3:1b` was still generating after roughly 90 seconds and pushed almost 1 GB into swap. The selected middle ground is `qwen2.5:0.5b`: its first cold load measured 77.5 seconds, but a fixed-context warm multi-turn request completed in 3.71 seconds. The deployment therefore pre-warms it before starting the preview and retains it indefinitely.

To keep memory bounded, ProjectHub uses a 1,536-token context, at most five sanitized recent turns, up to 32 generated tokens, two CPU threads, one generation at a time, and a 15-second request ceiling. Stance memory retains up to 12 topic positions for 60 minutes. The model stays loaded (`keep_alive=-1`); after a VM/Ollama restart, the prewarm step absorbs the slow load before the preview starts. Timeouts and invalid replies fail safely to the deterministic answer.

Before enabling Ollama on a host, confirm available RAM, swap, disk, installed model capabilities, and latency. Do not enable it merely because an Ollama daemon exists.

## Private feature preview

`deploy-agent-preview.sh` deploys a committed `feat/*` branch to a separate directory and service on the staging VM:

- directory: `/opt/recruiter-chat-api-feature`
- service: `projecthub-agent-preview`
- listener: `127.0.0.1:3200`
- public Caddy route: none
- Think Mode pushes: disabled
- cloud inference: disabled by `LOCAL_ONLY_MODE=true`
- Ollama conversation and style control: enabled with pre-warmed `qwen2.5:0.5b`
- knowledge: bundled local `data/recruiter-knowledge.json`
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
