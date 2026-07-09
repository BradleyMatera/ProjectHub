# 💬 ProjectHub 🤖  
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=000&style=for-the-badge)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)  
[![AI Powered](https://img.shields.io/badge/AI-Powered-blueviolet?style=for-the-badge)]()  
[![Hosted on GitHub Pages](https://img.shields.io/badge/Hosted-GitHub_Pages-181717?logo=github&logoColor=white&style=for-the-badge)](https://bradleymatera.github.io/ProjectHub/)  

> **ProjectHub** is an **AI-powered chatbot widget** that can be embedded into any website.  
> It showcases my **web development projects, CodePens, and skills** while engaging users with natural, conversational AI.  

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

- 🤖 **AI-Powered Chat** → Handles recruiter-focused queries with grounded profile data, Gemini Flash backend, and anti-slop validation.  
- 🧠 **Smart Routing** → Uses the Netlify Function `recruiter-chat` on `bradleymatera.dev` with session memory in Neon DB.  
- 🖼️ **Project Showcase** → Ask about projects (e.g., *"Tell me about Interactive Pokedex"*) or CodePens for details, stacks, and links.  
- 👤 **Bio & Skills** → Provides summaries of my education, skills, and background as a Web Development student at Full Sail University.  
- 🎨 **Natural Tone** → Responses feel conversational and approachable.  
- 🛠️ **Custom Queries** → Can handle general questions, then steer back toward portfolio content.  
- 🔗 **Direct Links** → Easily fetch my GitHub or LinkedIn profiles.  

---

## 🧭 Chat Routing

When hosted on `bradleymatera.dev`, the widget calls:

```text
/.netlify/functions/recruiter-chat
```

This Netlify Function uses Gemini Flash with a grounded knowledge base, conversation context, and anti-slop validation. Session memory is persisted in Neon PostgreSQL.

On GitHub Pages or local files, the widget falls back to the legacy GCP API at `https://projecthub-chat.bradleymatera.dev/api/chat`.

---

## 💡 Example Queries

Try asking the bot:

- **Project Inquiry** → *"Tell me about Interactive Pokedex"*  
- **CodePen Inquiry** → *"Tell me about React Calculator"*  
- **Bio Request** → *"Summarize Bradley as a web dev"*  
- **Full Summary** → *"Full summary"*  
- **General Chat** → *"What’s the weather like?"*  

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
