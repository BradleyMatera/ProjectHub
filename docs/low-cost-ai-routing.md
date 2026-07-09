# low-cost-ai-routing.md

**Read when:** You need to decide how ProjectHub should use GCP, Netlify, Ollama, or paid AI capacity without exceeding a small monthly budget.

---

## Budget Rule

Keep recurring spend at or below the services already approved by Bradley. If adding Google Cloud spend, set a hard budget alert at `$20/month` and design the system to keep working when paid model capacity is unavailable.

---

## Current Best Architecture

ProjectHub should stay grounded-first:

1. Browser widget calls `https://projecthub-chat.bradleymatera.dev/api/chat`.
2. GCP VM API returns deterministic recruiter-safe answers for factual/profile/project questions.
3. Small local Ollama model is used only for guarded low-risk wording.
4. Response cache avoids repeated work.
5. Optional paid or token-limited AI should polish only selected answers, never become required for basic operation.

This keeps the widget useful even if every paid or token-limited service is exhausted.

---

## Netlify Pro Usage

Netlify can help without extra spend if it is already part of the portfolio stack:

- Use a Netlify Function as a smart router/cache in front of the GCP API only if the recruiter site is already deployed on Netlify.
- Use Netlify's included AI/token allowance only for rare answer-polishing paths, not for every chat message.
- Cache polished answers by normalized question so the same recruiter questions do not burn tokens repeatedly.
- Enforce a monthly token counter in the function or API. When the allowance is near exhausted, fall back to the grounded GCP answer.

Netlify Functions do not replace Ollama compute. They are useful for routing, caching, quota enforcement, and calling a hosted model API within the included allowance.

---

## Google Cloud Spend

A `$20/month` Google Cloud cap can buy modest always-on CPU/RAM, but it will not run large `gpt-oss`-class Ollama models well 24/7. Those models typically need far more memory and often GPU-class hardware.

Safer options:

- Keep the Always Free VM as the default backend.
- Add Google Cloud budget alerts at `$10`, `$15`, and `$20`.
- If testing a larger VM, run it only on demand and stop it automatically.
- Prefer a small hosted API allowance for occasional polishing over trying to run a large local model continuously.

Do not expose `localhost:11434` publicly. Keep all model access behind the recruiter chat API.

---

## Routing Policy

Use paid/token-limited AI only when all are true:

- The question is recruiter-relevant.
- The grounded answer exists first.
- The user asks for a more natural rewrite, interview wording, or a nuanced comparison.
- The normalized question is not already cached.
- Monthly token/spend budget remains available.

Otherwise return the grounded answer directly.