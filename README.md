# 💬 ProjectHub 🤖 — Scout  
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=000&style=for-the-badge)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)  
[![AI Powered](https://img.shields.io/badge/AI-Powered-blueviolet?style=for-the-badge)]()  
[![Hosted on GitHub Pages](https://img.shields.io/badge/Hosted-GitHub_Pages-181717?logo=github&logoColor=white&style=for-the-badge)](https://bradleymatera.github.io/ProjectHub/)  

> **ProjectHub** is an **embeddable AI chat widget** powered by **Scout**, a local RAG recruiter assistant.  
> It showcases my **projects, CodePens, skills, and background**, and answers recruiter questions from the real data it has access to.  

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

- 🤖 **Scout — AI Recruiter Assistant** → Answers recruiter-focused queries with real retrieval from a grounded knowledge base, then a local generative RAG layer on Ollama.  
- 🔍 **Real RAG** → Searches across `recruiter-knowledge.json`, blog posts, resume guardrails, portfolio pages, and project data before generating a response.  
- 🖼️ **Project Showcase** → Ask about projects (e.g., *"Tell me about Interactive Pokedex"*) or CodePens for details, stacks, and links.  
- 👤 **Bio & Skills** → Provides summaries of education, skills, and background from verified data.  
- 🎨 **Natural Tone** → Calm, honest, concise, and never over-hyped.  
- 🛠️ **Custom Queries** → Handles any recruiter, career, project, or fit question it has evidence for, and says when it does not.  
- 🔗 **Direct Links** → Easily fetch GitHub or LinkedIn profiles.  

---

## 🧭 Chat Routing

The widget calls the recruiter chat API at:

```text
https://projecthub-chat.bradleymatera.dev/api/chat
```

The API runs on a GCP VM with local Ollama (`gemma3:1b` for fallback, `smollm2:135m` for generative RAG). It fetches `recruiter-knowledge.json` from GitHub, retrieves the most relevant chunks, streams a constrained rewrite, and validates it against the source data. If generation fails or the data is not available, it falls back to a grounded, deterministic answer.

---

## 💡 Example Queries

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
