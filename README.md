# 💬 ProjectHub 🤖 — Scout  
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=000&style=for-the-badge)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)  
[![AI Powered](https://img.shields.io/badge/AI-Powered-blueviolet?style=for-the-badge)]()  
[![Hosted on GitHub Pages](https://img.shields.io/badge/Hosted-GitHub_Pages-181717?logo=github&logoColor=white&style=for-the-badge)](https://bradleymatera.github.io/ProjectHub/)  
[![Free Tier](https://img.shields.io/badge/Stack-100%25%20Free-34d399?style=for-the-badge)]()  

> **ProjectHub** is an **embeddable AI chat widget** powered by **Scout**, a free multi-provider recruiter assistant.  
> It showcases my **projects, CodePens, skills, and background**, and answers recruiter questions from the real data it has access to — running entirely on free tiers.  

---

## 🚀 Usage

Add the ProjectHub chat bot to your site by including this script in your HTML:

```html
<script src="https://bradleymatera.github.io/ProjectHub/ProjectHub.js"></script>
```

This automatically adds a floating **chat interface** in the bottom-right corner of your page.  
Users can interact with the bot to explore projects, learn about my background, or even ask general questions.

---

## ✨ Features

- 🤖 **Scout — AI Recruiter Assistant** → Answers recruiter-focused queries with real retrieval from a grounded knowledge base, then routes open-ended questions through a free multi-provider LLM network.  
- 🌐 **Free Multi-Provider Router** → Tries Groq, Cloudflare Workers AI, GitHub Models, and Google Gemini in priority order, with local Ollama as the final fallback.  
- 🔍 **Real RAG** → Searches across `recruiter-knowledge.json`, blog posts, resume guardrails, portfolio pages, and project data before generating a response.  
- 🖼️ **Project Showcase** → Ask about projects (e.g., *"Tell me about Interactive Pokedex"*) or CodePens for details, stacks, and links.  
- 👤 **Bio & Skills** → Provides summaries of education, skills, and background from verified data.  
- 🎨 **Natural Tone** → Calm, honest, concise, and never over-hyped.  
- 🛠️ **Custom Queries** → Handles any recruiter, career, project, or fit question it has evidence for, and says when it does not.  
- 🔗 **Direct Links** → Easily fetch GitHub or LinkedIn profiles.  
- 💸 **100% Free Stack** → GitHub Pages frontend, GCP VM free tier backend, free LLM providers, and local Ollama fallback — no paid AI required.  

---

## 🧭 Chat Routing

The widget calls the recruiter chat API at:

```text
https://projecthub-chat.bradleymatera.dev/api/chat
```

The API runs on a GCP VM free tier. It fetches `recruiter-knowledge.json` from GitHub, caches it, and always computes a grounded, deterministic answer first. Open-ended questions are sent through a priority network of free providers — Groq, Cloudflare Workers AI, GitHub Models, Google Gemini — and fall back to local Ollama (`smollm2:135m`) if needed. Every generative reply is validated against the source data. If no provider succeeds, the grounded answer is returned.

---

## � How is this free?

ProjectHub is intentionally built to run on **zero recurring AI spend** and only free-tier infrastructure. Here is the exact breakdown:

### Frontend — free

- **GitHub Pages** hosts `index.html`, `ProjectHub.js`, and all static assets at no cost because this is a public repository.
- No build step, no bundler, no CI/CD service needed.
- The widget is consumed via one `<script>` tag from the GitHub Pages URL.

### Backend — free

- **Google Cloud `e2-micro` VM** in an Always Free region (`us-west1`, `us-central1`, or `us-east1`).
  - 720 free instance hours per month is enough to run one VM continuously.
  - 30 GB standard persistent disk is within the Always Free allowance.
  - Same-region egress is free.
- **Caddy** handles HTTPS with free **Let's Encrypt** certificates.
- **No database** is required; session memory is the last 3 turns per tab, kept in the Node process.
- **No paid Node dependencies**; `package.json` dependencies are empty.

### AI / LLM — free

Scout never relies on a single paid API. It uses a rotating network of free providers, plus a local fallback:

| Provider | Cost | Model used |
|----------|------|------------|
| **Groq** | Free tier | `llama-3.1-8b-instant` |
| **Cloudflare Workers AI** | Free tier | `@cf/meta/llama-3.2-3b-instruct` |
| **GitHub Models** | Free tier with `models:read` token | `openai/gpt-4o-mini` |
| **Google Gemini** | Free tier | `gemini-2.0-flash` |
| **xAI Grok** | Optional free credits | `grok-4.3` |
| **Local Ollama** | Free/open source, runs on the VM | `smollm2:135m` |

The backend (`server-gemini.js`) always computes a deterministic grounded answer first. For open-ended questions it walks the providers in `PROVIDER_ORDER`. Each provider has:

- a daily request cap
- a 60-second cooldown on rate-limit errors
- a 24-hour cooldown on credit-exhaustion errors

If a provider fails or returns invalid output, the router tries the next one. If every provider is exhausted, **local Ollama** on the VM is the final fallback. Every generated reply is validated against the source facts, and if nothing passes, the grounded answer is returned.

### Knowledge base — free

- `data/recruiter-knowledge.json` is stored in this repo and fetched raw from GitHub.
- The backend caches it in memory for 5 minutes, so repeated requests do not hammer GitHub.
- Response caching avoids repeating identical questions within 10 minutes.

### What this avoids

- No OpenAI, Anthropic, or other paid API subscriptions.
- No database hosting (Neon, Firebase, etc.).
- No paid Netlify Functions or AI add-ons.
- No domain transfer or paid DNS changes.

The only optional cost is if the GCP VM somehow leaves Always Free (for example, by choosing a non-qualifying region or machine type). As configured, the monthly bill for the backend should be **$0**.

---

## �💡 Example Queries

Try asking Scout:

- **Project Inquiry** → *"Tell me about Interactive Pokedex"*  
- **CodePen Inquiry** → *"Tell me about React Calculator"*  
- **Bio Request** → *"Summarize Bradley as a web dev"*  
- **Role Fit** → *"Would Bradley be a good fit for data science?"*  
- **Career Advice** → *"What kind of jobs should he apply for?"*  

---

## 🔗 Links

- 🌍 [Live Demo (GitHub Pages)](https://bradleymatera.github.io/ProjectHub/)  
- 📂 [Repository](https://github.com/BradleyMatera/ProjectHub)  
- 💼 [LinkedIn](https://www.linkedin.com/in/championingempatheticwebsolutionsthroughcode/)  
- 🐙 [GitHub Profile](https://github.com/BradleyMatera)  

---

## 🤝 Contributions
Contributions welcome! Fork the repo, open issues, or submit PRs.  

---

## 📄 License
MIT License  

---

<p align="center">
  <img src="https://komarev.com/ghpvc/?username=BradleyMatera&style=flat-square&color=blue" alt="Profile views" />
</p>
