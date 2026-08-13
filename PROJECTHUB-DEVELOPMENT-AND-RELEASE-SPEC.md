# ProjectHub Development and Release Specification

This is the canonical release process for ProjectHub. Feature validation and production publication are separate decisions. Passing local tests or the private preview does not authorize a production deployment.

> **Architecture:** ProjectHub/Scout is being developed as the cloud-hosted
> replacement for the existing generative AI chatbot. The production deployment
> target is a Docker-containerized backend with generative inference. The
> current `deploy-gcp.sh` SCP-based deployment is a legacy path that will be
> replaced by Docker image deployment after qualification. Do NOT use
> `deploy-gcp.sh` for the new containerized path.
>
> **Model:** Current development/evaluation model is `qwen2.5:1.5b`.
> The earlier `qwen2.5:0.5b` is historical only.

## Environments

| Stage | Source | Frontend | Backend |
|---|---|---|---|
| Feature preview | Clean `feat/*` branch | SSH-tunneled `agent-preview/` | Loopback-only `127.0.0.1:3200` on the development VM |
| Development staging | `ProjectHub:develop`, mirrored to `ProjectHub-dev:main` | `https://bradleymatera.github.io/ProjectHub-dev/` | `https://dev.projecthub-chat.bradleymatera.dev/` |
| Production | `ProjectHub:master` | `https://bradleymatera.github.io/ProjectHub/` | `https://projecthub-chat.bradleymatera.dev/` |

The public `ProjectHub-dev` repository is only a deployment target. `BradleyMatera/ProjectHub` remains the source of truth.

## Required branch sequence

1. Start from an up-to-date `develop` branch and create a focused `feat/*` branch.
2. Preserve unrelated and untracked work. Commit only intended files.
3. Run the repository acceptance checks appropriate to the change.
4. For agent/backend work, deploy the clean feature commit with `deploy-agent-preview.sh` and validate it only through the SSH tunnel.
5. Open a pull request from the feature branch to `develop`; required CI must pass.
6. Merge to `develop`. Allow the staging mirror workflow to publish `ProjectHub-dev:main`, and deploy the development backend when applicable.
7. Validate the real staging frontend and development API. Record the commit and evidence.
8. Open a release pull request from `develop` to `master`; do not bypass the PR or protected environment.
9. After the release PR is merged, run `bash deploy-gcp.sh`, verify production health and behavior, then manually trigger the Pages workflow.
10. Verify the final public URLs and record the released commit.

## Minimum acceptance

For all changes:

```bash
npm test
npm run build
node --check server-gemini.js
git diff --check
```

For retrieval or conversational changes, also run:

```bash
npm run eval-retrieval
PROJECTHUB_API_URL=http://127.0.0.1:<port> npm run eval:local-api
python3 test-production-conversations.py \
  --url http://127.0.0.1:<port>/api/chat \
  --delay 2.5
```

Use the private preview first, then repeat relevant checks against development staging. Confirm that `/health` reports local-only inference and the intended model, that no request exceeds the 15-second contract, and that grounded/local fallback output is classified separately from a validated Ollama generation.

## Production authorization boundary

- Never deploy a feature branch with `deploy-gcp.sh`.
- Never push a feature branch directly to `master` or directly to the staging deploy repository.
- Knowledge, prompt, safety, retrieval, memory, and answer-shaping changes require development staging before production.
- Do not expose secrets in commands, logs, commits, documentation, or chat output.
- A production log audit is read-only unless the user explicitly authorizes a production mutation.
- Production and private-preview rate limits are separate. A replay-only limit increase must not alter the public limit.

## Rollback

1. Identify the last known-good commit already present in the affected environment.
2. Revert the release through a new pull request; do not rewrite protected branch history.
3. Redeploy the reverted `master` backend with `deploy-gcp.sh` if the backend changed.
4. Re-run health, retrieval, conversation, and live-widget checks.
5. If only the frontend is affected, redeploy the last known-good Pages artifact through the workflow rather than editing production manually.
6. Preserve logs and test evidence needed to diagnose the failed release; redact private visitor data.

## Active feature exception-free handoff

For `feat/agent-systems-network`, read `docs/current-feature-handoff.md`. It records the exact code baseline, production-derived corpus provenance, completed tests, and the live private-preview acceptance that remains. None of those notes waive the sequence above.
