function setupChatUI(projects, codePens, suggestions, handleQuery, fetchAllGitHubData) {
  // Context tracking for follow-up queries
  let lastQueryTopic = null;

  // Create the chat interface
  const chatDiv = document.createElement("div");
  chatDiv.id = "bradley-chat";
  chatDiv.style.position = "fixed";
  chatDiv.style.bottom = "20px";
  chatDiv.style.right = "20px";
  chatDiv.style.width = "800px";
  chatDiv.style.background = "#333";
  chatDiv.style.borderRadius = "10px";
  chatDiv.style.padding = "15px";
  chatDiv.style.color = "#fff";
  chatDiv.style.boxShadow = "0 0 15px rgba(0, 216, 255, 0.5)";
  chatDiv.style.fontFamily = "Arial, sans-serif";
  chatDiv.style.fontSize = "16px";
  chatDiv.style.zIndex = "1000";

  // Chat header
  const chatHeader = document.createElement("div");
  chatHeader.style.marginBottom = "10px";
  chatHeader.style.fontWeight = "bold";
  chatHeader.style.display = "flex";
  chatHeader.style.justifyContent = "space-between";
  chatHeader.style.alignItems = "center";
  chatHeader.innerHTML = "Bradley Matera's Project Chat";
  chatDiv.appendChild(chatHeader);

  // Minimize button
  const minimizeBtn = document.createElement("button");
  minimizeBtn.innerHTML = "−";
  minimizeBtn.style.background = "none";
  minimizeBtn.style.border = "none";
  minimizeBtn.style.color = "#fff";
  minimizeBtn.style.fontSize = "18px";
  minimizeBtn.style.cursor = "pointer";
  chatHeader.appendChild(minimizeBtn);

  // Chat output
  const chatOutput = document.createElement("div");
  chatOutput.id = "chat-output";
  chatOutput.style.maxHeight = "400px";
  chatOutput.style.overflowY = "auto";
  chatOutput.style.marginBottom = "10px";
  chatOutput.innerHTML = `<div class="message bot-message"><strong>Bot:</strong> Hi! I'm Bradley Matera's ProjectHub assistant. Ask about his work as a junior software engineer — projects like ProjectHub, the AWS serverless workflow, or CIRIS Ethical AI; his GitHub or LinkedIn; the roles he's targeting; or his strongest technical skills. What would you like to know?<div class="timestamp">${new Date().toLocaleTimeString()}</div></div>`;
  chatDiv.appendChild(chatOutput);

  // Dropdown for suggestions
  const dropdown = document.createElement("select");
  dropdown.style.width = "100%";
  dropdown.style.padding = "8px";
  dropdown.style.borderRadius = "5px";
  dropdown.style.border = "none";
  dropdown.style.marginBottom = "10px";
  dropdown.style.background = "#444";
  dropdown.style.color = "#fff";
  dropdown.style.fontSize = "16px";
  dropdown.innerHTML = `<option value="">Select a suggestion...</option>` + suggestions.map(s => `<option value="${s}">${s}</option>`).join("");
  chatDiv.appendChild(dropdown);

  // Chat input
  const chatInput = document.createElement("textarea");
  chatInput.id = "chat-input";
  chatInput.placeholder = "Ask about Bradley's work, projects, skills, or roles...";
  chatInput.style.width = "100%";
  chatInput.style.padding = "8px";
  chatInput.style.borderRadius = "5px";
  chatInput.style.border = "none";
  chatInput.style.background = "#444";
  chatInput.style.color = "#fff";
  chatInput.style.fontSize = "16px";
  chatInput.style.resize = "none";
  chatInput.style.height = "40px";
  chatInput.style.overflowY = "hidden";
  chatDiv.appendChild(chatInput);

  // Send button
  const sendButton = document.createElement("button");
  sendButton.innerHTML = "Send";
  sendButton.style.marginTop = "5px";
  sendButton.style.padding = "8px 16px";
  sendButton.style.background = "#3498db";
  sendButton.style.color = "#fff";
  sendButton.style.border = "none";
  sendButton.style.borderRadius = "5px";
  sendButton.style.cursor = "pointer";
  sendButton.style.fontSize = "16px";
  sendButton.style.width = "100%";
  chatDiv.appendChild(sendButton);

  // Loading icon
  const loadingIcon = document.createElement("div");
  loadingIcon.id = "loading-icon";
  loadingIcon.style.display = "none";
  loadingIcon.style.textAlign = "center";
  loadingIcon.style.marginTop = "10px";
  loadingIcon.innerHTML = `<div style="border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; margin: 0 auto;"></div>`;
  chatDiv.appendChild(loadingIcon);

  // Add CSS for loading animation and message styling
  const style = document.createElement("style");
  style.innerHTML = `
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .message {
      margin-bottom: 10px;
      padding: 10px;
      border-radius: 5px;
      word-wrap: break-word;
    }
    .user-message {
      background: #555;
      text-align: right;
    }
    .bot-message {
      background: #444;
    }
    .timestamp {
      font-size: 12px;
      color: #aaa;
      margin-top: 5px;
    }
    .followup-list {
      margin-top: 10px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .followup-list strong {
      width: 100%;
      margin-bottom: 2px;
    }
    .followup-chip {
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 999px;
      background: #2f6f9f;
      color: #fff;
      padding: 6px 9px;
      font: inherit;
      font-size: 13px;
      line-height: 1.2;
      cursor: pointer;
      text-align: left;
    }
    .followup-chip:hover,
    .followup-chip:focus {
      background: #3f87bd;
      outline: none;
    }
  `;
  document.head.appendChild(style);

  document.body.appendChild(chatDiv);

  let lastRequestTime = 0;
  const requestInterval = 1000;
  let isRequestInFlight = false;
  let lastSubmittedQuery = "";
  let lastSubmittedAt = 0;
  let lastBotReplyText = "";

  function linkifyHtml(html) {
    return html.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, (match, prefix, url) => {
      const trailing = /[.),!?]$/.test(url) ? url.slice(-1) : "";
      const cleanUrl = trailing ? url.slice(0, -1) : url;
      return `${prefix}<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trailing}`;
    });
  }

  function appendMessage(type, label, html) {
    const messageDiv = document.createElement("div");
    messageDiv.className = `message ${type}-message`;
    messageDiv.innerHTML = `<strong>${label}:</strong> ${linkifyHtml(html)}<div class="timestamp">${new Date().toLocaleTimeString()}</div>`;
    chatOutput.appendChild(messageDiv);
    chatOutput.scrollTop = chatOutput.scrollHeight;
    return messageDiv;
  }

  minimizeBtn.onclick = () => {
    chatOutput.style.display = chatOutput.style.display === "none" ? "block" : "none";
    chatInput.style.display = chatInput.style.display === "none" ? "block" : "none";
    dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
    minimizeBtn.innerHTML = chatOutput.style.display === "none" ? "+" : "−";
  };

  chatInput.oninput = () => {
    chatInput.style.height = "40px";
    chatInput.style.height = `${chatInput.scrollHeight}px`;
  };

  dropdown.onchange = () => {
    if (dropdown.value) {
      chatInput.value = dropdown.value;
      dropdown.value = "";
      chatInput.focus();
    }
  };

  chatOutput.addEventListener("click", (event) => {
    const followupButton = event.target.closest(".followup-chip");
    if (!followupButton || isRequestInFlight) return;
    chatInput.value = followupButton.dataset.followup || followupButton.textContent || "";
    chatInput.style.height = "40px";
    chatInput.style.height = `${chatInput.scrollHeight}px`;
    submitChat();
  });

  // Event handler for Send button and Enter key
  const submitChat = async () => {
    const now = Date.now();
    if (now - lastRequestTime < requestInterval) {
      chatInput.placeholder = "One moment...";
      return;
    }
    const userQuery = chatInput.value.trim();
    if (!userQuery) return;

    const normalizedQuery = userQuery.toLowerCase().replace(/\s+/g, " ");
    if (isRequestInFlight) {
      chatInput.placeholder = "Still working on that answer...";
      return;
    }

    if (normalizedQuery === lastSubmittedQuery && now - lastSubmittedAt < 20000) {
      chatInput.placeholder = "Try a follow-up detail or rephrase the question...";
      return;
    }

    lastRequestTime = now;
    lastSubmittedQuery = normalizedQuery;
    lastSubmittedAt = now;
    isRequestInFlight = true;
    sendButton.disabled = true;
    sendButton.style.opacity = "0.65";
    chatInput.disabled = true;

    appendMessage("user", "You", userQuery.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c])));

    loadingIcon.style.display = "block";
    const statusDiv = document.createElement("div");
    statusDiv.id = "thinking-status";
    statusDiv.className = "message bot-message";
    statusDiv.style.opacity = "0.8";
    statusDiv.innerHTML = `<strong>Bot:</strong> Thinking...<div class="timestamp">${new Date().toLocaleTimeString()}</div>`;
    chatOutput.appendChild(statusDiv);
    chatOutput.scrollTop = chatOutput.scrollHeight;

    let thinkingDots = 0;
    const thinkingInterval = setInterval(() => {
      thinkingDots = (thinkingDots + 1) % 4;
      const dots = ".".repeat(thinkingDots);
      const messages = ["Checking Bradley’s profile", "Drafting a recruiter-ready answer", "Verifying details"];
      const message = messages[(thinkingDots) % messages.length];
      statusDiv.innerHTML = `<strong>Bot:</strong> ${message}${dots}<div class="timestamp">${new Date().toLocaleTimeString()}</div>`;
      chatOutput.scrollTop = chatOutput.scrollHeight;
    }, 800);

    try {
      const { reply, newTopic } = await handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData);
      lastQueryTopic = newTopic;
      const plainReply = reply.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (plainReply && plainReply === lastBotReplyText) {
        appendMessage("bot", "Bot", "That answer would be the same as the one above. Try one of the other follow-ups or ask for a different angle, like recruiter fit, technical depth, or project tradeoffs.");
        chatInput.value = "";
        chatInput.style.height = "40px";
        return;
      }
      appendMessage("bot", "Bot", reply);
      lastBotReplyText = plainReply;
      chatInput.value = "";
      chatInput.style.height = "40px";
    } catch (error) {
      console.error("ProjectHub chat error:", error);
      appendMessage("bot", "Bot", "I can still help from Bradley’s verified profile details. Try asking about projects, AWS experience, CIRIS, target roles, skills, or contact links.");
    } finally {
      clearInterval(thinkingInterval);
      statusDiv.remove();
      loadingIcon.style.display = "none";
      isRequestInFlight = false;
      sendButton.disabled = false;
      sendButton.style.opacity = "1";
      chatInput.disabled = false;
      chatInput.placeholder = "Ask about Bradley's work, projects, skills, or roles...";
      chatInput.focus();
    }
  };

  sendButton.onclick = submitChat;

  chatInput.addEventListener("keypress", async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitChat();
    }
  });

  console.log("ProjectHub loaded!");
}

// Run the chat widget once the DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  try {
    setupChatUI(projects, codePens, suggestions, handleQuery, fetchAllGitHubData);
  } catch (error) {
    console.error("Error initializing ProjectHub:", error);
  }
});