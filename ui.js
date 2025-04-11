function setupChatUI(projects, codePens, suggestions, handleQuery) {
  // Context tracking for follow-up queries
  let lastQueryTopic = null;

  // Create the chat interface
  const chatDiv = document.createElement("div");
  chatDiv.id = "bradley-chat";
  chatDiv.style.position = "fixed";
  chatDiv.style.bottom = "20px";
  chatDiv.style.right = "20px";
  chatDiv.style.width = "400px";
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
  chatOutput.innerHTML = `<div class="message bot-message"><strong>Bot:</strong> Welcome! I’m here to help you explore Bradley Matera’s web development work. Ask about his projects (e.g., Pokedex, Pong_Deluxe), CodePens (e.g., React Calculator, Data Visualization), platforms (e.g., GitHub, Netlify), tech (e.g., React, Docker), live data (e.g., 'What project has the most stars?'), or about Bradley as a web developer (e.g., 'Summarize Bradley as a web dev'). What would you like to know?<div class="timestamp">${new Date().toLocaleTimeString()}</div></div>`;
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
  chatInput.placeholder = "Ask about Bradley's projects!";
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
  `;
  document.head.appendChild(style);

  document.body.appendChild(chatDiv);

  // Event handlers
  let lastRequestTime = 0;
  const requestInterval = 1000; // 1 second between requests

  minimizeBtn.onclick = () => {
    chatOutput.style.display = chatOutput.style.display === "none" ? "block" : "none";
    chatInput.style.display = chatInput.style.display === "none" ? "block" : "none";
    dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
    minimizeBtn.innerHTML = chatOutput.style.display === "none" ? "+" : "−";
  };

  chatInput.oninput = () => {
    chatInput.style.height = "40px"; // Reset height
    chatInput.style.height = `${chatInput.scrollHeight}px`; // Adjust height based on content
  };

  dropdown.onchange = () => {
    if (dropdown.value) {
      chatInput.value = dropdown.value;
      dropdown.value = ""; // Reset dropdown
    }
  };

  chatInput.addEventListener("keypress", async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault(); // Prevent newline on Enter
      const now = Date.now();
      if (now - lastRequestTime < requestInterval) {
        chatOutput.innerHTML += `<div class="message bot-message"><strong>Bot:</strong> Please wait a moment before sending another message.<div class="timestamp">${new Date().toLocaleTimeString()}</div></div>`;
        chatOutput.scrollTop = chatOutput.scrollHeight;
        return;
      }
      lastRequestTime = now;
      const userQuery = chatInput.value.trim();
      if (!userQuery) return;

      // Display the user's input in the chat
      chatOutput.innerHTML += `<div class="message user-message"><strong>You:</strong> ${userQuery}<div class="timestamp">${new Date().toLocaleTimeString()}</div></div>`;

      // Show loading icon
      loadingIcon.style.display = "block";
      chatOutput.scrollTop = chatOutput.scrollHeight;

      const { reply, newTopic } = await handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData);
      lastQueryTopic = newTopic;

      // Hide loading icon and display the bot's response
      loadingIcon.style.display = "none";
      chatOutput.innerHTML += `<div class="message bot-message"><strong>Bot:</strong> ${reply}<div class="timestamp">${new Date().toLocaleTimeString()}</div></div>`;
      chatOutput.scrollTop = chatOutput.scrollHeight;
      chatInput.value = "";
      chatInput.style.height = "40px"; // Reset input height
    }
  });

  console.log("ProjectHub loaded!");
}