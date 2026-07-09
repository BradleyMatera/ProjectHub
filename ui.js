function setupChatUI(projects, codePens, suggestions, handleQuery, fetchAllGitHubData) {
  let lastQueryTopic = null;
  let lastRequestTime = 0;
  let isRequestInFlight = false;
  let lastSubmittedQuery = "";
  let lastSubmittedAt = 0;
  let lastBotReplyText = "";
  let conversationContext = [];
  let turnCount = 0;

  const requestInterval = 900;
  const avatarUrl = window.__PROJECTHUB_AVATAR__ || (window.location.protocol === "file:" ? "bot-avatar.png" : "https://bradleymatera.github.io/ProjectHub/bot-avatar.png");
  const sessionStorageKey = "projecthub-chat-session-id";
  const nameStorageKey = "projecthub-chat-user-name";
  const settingsStorageKey = "projecthub-chat-settings";
  const defaultSettings = {
    memoryEnabled: true,
    flavorEnabled: true,
    enterToSend: true,
    compactMode: false,
    personalizeReplies: true
  };

  function createSessionId() {
    return `ph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  let sessionId = (() => {
    try {
      const existing = window.sessionStorage.getItem(sessionStorageKey);
      if (existing) return existing;
      const generated = createSessionId();
      window.sessionStorage.setItem(sessionStorageKey, generated);
      return generated;
    } catch (error) {
      return createSessionId();
    }
  })();

  let visitorName = (() => {
    try {
      return window.sessionStorage.getItem(nameStorageKey) || "";
    } catch (error) {
      return "";
    }
  })();

  let chatSettings = (() => {
    try {
      return { ...defaultSettings, ...JSON.parse(window.localStorage.getItem(settingsStorageKey) || "{}") };
    } catch (error) {
      return { ...defaultSettings };
    }
  })();

  function chatApiUrl() {
    return window.__PROJECTHUB_CHAT_API__
      || (/(^|\.)bradleymatera\.dev$/.test(window.location.hostname) ? "/.netlify/functions/chat-router" : "https://projecthub-chat.bradleymatera.dev/api/chat");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
  }

  function linkifyHtml(html) {
    return html.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, (match, prefix, url) => {
      const trailing = /[.),!?]$/.test(url) ? url.slice(-1) : "";
      const cleanUrl = trailing ? url.slice(0, -1) : url;
      return `${prefix}<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trailing}`;
    });
  }

  function normalizeForCompare(value) {
    return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  const existingStyle = document.getElementById("projecthub-chat-styles");
  if (existingStyle) existingStyle.remove();

  const style = document.createElement("style");
  style.id = "projecthub-chat-styles";
  style.textContent = `
    :root {
      --ph-bg: #0d1412;
      --ph-panel: rgba(18, 29, 26, 0.94);
      --ph-panel-strong: #14231f;
      --ph-line: rgba(212, 230, 218, 0.16);
      --ph-text: #edf7ef;
      --ph-muted: #9fb4aa;
      --ph-accent: #39d98a;
      --ph-accent-2: #70b7ff;
      --ph-user: #dceee5;
      --ph-user-text: #10201a;
      --ph-shadow: 0 26px 80px rgba(0, 0, 0, 0.38), 0 8px 22px rgba(0, 0, 0, 0.24);
    }

    #bradley-chat {
      position: fixed;
      right: 22px;
      bottom: 22px;
      width: min(440px, calc(100vw - 28px));
      height: min(680px, calc(100vh - 34px));
      z-index: 2147483000;
      display: grid;
      grid-template-rows: auto 1fr auto;
      overflow: hidden;
      color: var(--ph-text);
      font-family: "Aptos", "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.45;
      background:
        radial-gradient(circle at 20% 0%, rgba(57, 217, 138, 0.18), transparent 34%),
        radial-gradient(circle at 95% 12%, rgba(112, 183, 255, 0.18), transparent 32%),
        linear-gradient(160deg, rgba(13, 20, 18, 0.98), rgba(20, 35, 31, 0.96));
      border: 1px solid var(--ph-line);
      border-radius: 18px;
      box-shadow: var(--ph-shadow);
      backdrop-filter: blur(16px);
      transform-origin: bottom right;
      animation: projecthub-enter 440ms cubic-bezier(.2,.85,.2,1) both;
    }

    #bradley-chat.projecthub-minimized {
      width: min(340px, calc(100vw - 28px));
      height: 84px;
      grid-template-rows: auto;
    }

    #bradley-chat.projecthub-minimized .projecthub-body,
    #bradley-chat.projecthub-minimized .projecthub-composer,
    #bradley-chat.projecthub-minimized .projecthub-settings-panel {
      display: none;
    }

    #bradley-chat.projecthub-compact {
      width: min(390px, calc(100vw - 28px));
      height: min(560px, calc(100vh - 34px));
      font-size: 14px;
    }

    #bradley-chat.projecthub-compact .projecthub-header {
      padding: 11px;
    }

    #bradley-chat.projecthub-compact #chat-output {
      padding: 13px 11px 9px;
    }

    .projecthub-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px;
      background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02));
      border-bottom: 1px solid var(--ph-line);
    }

    .projecthub-avatar-wrap {
      position: relative;
      flex: 0 0 auto;
    }

    .projecthub-avatar {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      object-fit: cover;
      display: block;
      border: 1px solid rgba(255,255,255,0.22);
      box-shadow: 0 10px 26px rgba(0,0,0,0.26);
      background: #20352e;
    }

    .projecthub-status-dot {
      position: absolute;
      right: -2px;
      bottom: -2px;
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: var(--ph-accent);
      border: 2px solid #10201a;
      box-shadow: 0 0 0 4px rgba(57, 217, 138, 0.14);
    }

    .projecthub-title-block {
      min-width: 0;
      flex: 1;
    }

    .projecthub-kicker {
      color: var(--ph-accent);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
      margin-bottom: 2px;
    }

    .projecthub-title {
      font-size: 16px;
      font-weight: 800;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .projecthub-subtitle {
      color: var(--ph-muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .projecthub-icon-button {
      width: 36px;
      height: 36px;
      border: 1px solid var(--ph-line);
      border-radius: 10px;
      color: var(--ph-text);
      background: rgba(255,255,255,0.06);
      cursor: pointer;
      display: grid;
      place-items: center;
      font-size: 20px;
      transition: transform 160ms ease, background 160ms ease, border-color 160ms ease;
    }

    .projecthub-icon-button:hover,
    .projecthub-icon-button:focus {
      transform: translateY(-1px);
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.28);
      outline: none;
    }

    .projecthub-actions {
      display: flex;
      gap: 7px;
      flex: 0 0 auto;
    }

    .projecthub-settings-panel {
      position: absolute;
      top: 74px;
      right: 12px;
      left: 12px;
      z-index: 4;
      display: none;
      padding: 12px;
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 14px;
      background: rgba(13, 20, 18, 0.97);
      box-shadow: 0 18px 48px rgba(0,0,0,0.32);
      backdrop-filter: blur(14px);
      animation: message-in 180ms ease both;
    }

    #bradley-chat.projecthub-settings-open .projecthub-settings-panel {
      display: block;
    }

    .settings-head,
    .settings-actions {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      justify-content: space-between;
    }

    .settings-title {
      color: #fff;
      font-weight: 850;
      font-size: 14px;
    }

    .settings-subtitle {
      color: var(--ph-muted);
      font-size: 12px;
      margin-top: 2px;
    }

    .settings-grid {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }

    .setting-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 9px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      background: rgba(255,255,255,0.05);
    }

    .setting-row strong {
      display: block;
      color: var(--ph-text);
      font-size: 13px;
      line-height: 1.2;
    }

    .setting-row span span {
      display: block;
      color: var(--ph-muted);
      font-size: 11px;
      margin-top: 2px;
    }

    .setting-toggle {
      appearance: none;
      width: 42px;
      height: 24px;
      border-radius: 999px;
      background: rgba(255,255,255,0.16);
      border: 1px solid rgba(255,255,255,0.18);
      cursor: pointer;
      position: relative;
      flex: 0 0 auto;
      transition: background 160ms ease, border-color 160ms ease;
    }

    .setting-toggle::after {
      content: "";
      position: absolute;
      width: 18px;
      height: 18px;
      left: 2px;
      top: 2px;
      border-radius: 999px;
      background: #fff;
      transition: transform 160ms ease;
    }

    .setting-toggle:checked {
      background: rgba(57, 217, 138, 0.45);
      border-color: rgba(57, 217, 138, 0.65);
    }

    .setting-toggle:checked::after {
      transform: translateX(18px);
    }

    .settings-actions {
      margin-top: 10px;
      justify-content: flex-start;
    }

    .settings-action-button {
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 11px;
      color: var(--ph-text);
      background: rgba(255,255,255,0.08);
      padding: 8px 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }

    .settings-action-button.danger {
      color: #ffe7e7;
      border-color: rgba(255, 130, 130, 0.28);
      background: rgba(255, 130, 130, 0.11);
    }

    .projecthub-body {
      overflow: hidden;
      display: grid;
      grid-template-rows: 1fr auto;
      min-height: 0;
    }

    #chat-output {
      overflow-y: auto;
      padding: 18px 14px 12px;
      scroll-behavior: smooth;
    }

    #chat-output::-webkit-scrollbar {
      width: 10px;
    }

    #chat-output::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.16);
      border-radius: 999px;
      border: 3px solid transparent;
      background-clip: padding-box;
    }

    .message-row {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 9px;
      margin-bottom: 13px;
      animation: message-in 260ms cubic-bezier(.2,.8,.2,1) both;
    }

    .message-row.user-row {
      grid-template-columns: minmax(0, 1fr) 34px;
    }

    .message-avatar,
    .user-initial {
      width: 34px;
      height: 34px;
      border-radius: 11px;
      object-fit: cover;
      border: 1px solid rgba(255,255,255,0.16);
      background: #20352e;
    }

    .user-initial {
      display: grid;
      place-items: center;
      color: #10201a;
      background: linear-gradient(135deg, #dceee5, #9fe7c1);
      font-weight: 900;
      font-size: 13px;
      grid-column: 2;
    }

    .user-initial::before {
      content: "You";
    }

    .message {
      min-width: 0;
      padding: 12px 13px;
      border: 1px solid var(--ph-line);
      border-radius: 15px;
      word-wrap: break-word;
      box-shadow: 0 12px 24px rgba(0,0,0,0.14);
    }

    .bot-message {
      background: rgba(255,255,255,0.07);
      border-top-left-radius: 5px;
    }

    .user-message {
      grid-column: 1;
      grid-row: 1;
      color: var(--ph-user-text);
      background: linear-gradient(135deg, #edf8f1, #b5edcb);
      border-color: rgba(255,255,255,0.34);
      border-top-right-radius: 5px;
    }

    .message-label {
      display: block;
      color: var(--ph-muted);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .03em;
      text-transform: uppercase;
      margin-bottom: 5px;
    }

    .user-message .message-label {
      color: rgba(16, 32, 26, 0.62);
    }

    .message a {
      color: #96d9ff;
      text-decoration: none;
      border-bottom: 1px solid rgba(150, 217, 255, 0.42);
    }

    .message a:hover,
    .message a:focus {
      color: #c5ecff;
      border-bottom-color: currentColor;
      outline: none;
    }

    .ai-flavor {
      display: inline-flex;
      width: fit-content;
      margin: 0 0 8px;
      padding: 4px 8px;
      border: 1px solid rgba(112, 183, 255, 0.26);
      border-radius: 999px;
      color: #c5ecff;
      background: rgba(112, 183, 255, 0.11);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .02em;
    }

    .ai-flavor::before {
      content: "AI note";
      color: rgba(237, 247, 239, 0.56);
      margin-right: 6px;
      font-weight: 700;
    }

    .conversation-lead {
      display: block;
      color: #d9f7e6;
      font-weight: 800;
      margin-bottom: 7px;
    }

    .timestamp {
      color: var(--ph-muted);
      font-size: 11px;
      margin-top: 8px;
    }

    .user-message .timestamp {
      color: rgba(16, 32, 26, 0.58);
    }

    .projecthub-suggestions {
      padding: 0 14px 12px;
      display: flex;
      gap: 7px;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .projecthub-suggestions::-webkit-scrollbar {
      display: none;
    }

    .suggestion-chip,
    .followup-chip {
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      color: var(--ph-text);
      padding: 7px 10px;
      font: inherit;
      font-size: 12px;
      line-height: 1.2;
      cursor: pointer;
      white-space: nowrap;
      transition: transform 160ms ease, background 160ms ease, border-color 160ms ease;
    }

    .suggestion-chip:hover,
    .suggestion-chip:focus,
    .followup-chip:hover,
    .followup-chip:focus {
      transform: translateY(-1px);
      background: rgba(57, 217, 138, 0.14);
      border-color: rgba(57, 217, 138, 0.36);
      outline: none;
    }

    .followup-list {
      margin-top: 11px;
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
    }

    .followup-list strong {
      width: 100%;
      color: #d9f7e6;
      font-size: 12px;
      margin-bottom: 1px;
    }

    .followup-chip {
      white-space: normal;
      text-align: left;
      background: rgba(57, 217, 138, 0.12);
      border-color: rgba(57, 217, 138, 0.26);
    }

    .projecthub-composer {
      padding: 12px 14px 14px;
      border-top: 1px solid var(--ph-line);
      background: rgba(7, 12, 10, 0.36);
    }

    .composer-shell {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: end;
      gap: 9px;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 16px;
      padding: 8px;
      background: rgba(255,255,255,0.08);
      transition: border-color 160ms ease, box-shadow 160ms ease;
    }

    .composer-shell:focus-within {
      border-color: rgba(57, 217, 138, 0.46);
      box-shadow: 0 0 0 4px rgba(57, 217, 138, 0.10);
    }

    #chat-input {
      width: 100%;
      min-height: 42px;
      max-height: 130px;
      resize: none;
      overflow-y: auto;
      border: 0;
      outline: 0;
      color: var(--ph-text);
      background: transparent;
      font: inherit;
      line-height: 1.35;
      padding: 10px 4px 8px 6px;
    }

    #chat-input::placeholder {
      color: rgba(237, 247, 239, 0.52);
    }

    .send-button {
      width: 44px;
      height: 44px;
      border: 0;
      border-radius: 13px;
      color: #07100c;
      background: linear-gradient(135deg, var(--ph-accent), #a8f0c7);
      display: grid;
      place-items: center;
      cursor: pointer;
      box-shadow: 0 12px 24px rgba(57, 217, 138, 0.18);
      transition: transform 160ms ease, opacity 160ms ease, filter 160ms ease;
    }

    .send-button:hover,
    .send-button:focus {
      transform: translateY(-1px);
      filter: brightness(1.04);
      outline: none;
    }

    .send-button:disabled {
      cursor: wait;
      opacity: 0.58;
      transform: none;
    }

    .typing-bubble {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .typing-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--ph-accent);
      animation: typing-dot 900ms ease-in-out infinite;
    }

    .typing-dot:nth-child(2) { animation-delay: 120ms; }
    .typing-dot:nth-child(3) { animation-delay: 240ms; }

    @keyframes typing-dot {
      0%, 80%, 100% { transform: translateY(0); opacity: .45; }
      35% { transform: translateY(-4px); opacity: 1; }
    }

    @keyframes projecthub-enter {
      from { opacity: 0; transform: translateY(18px) scale(.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes message-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 560px) {
      #bradley-chat {
        right: 10px;
        left: 10px;
        bottom: 10px;
        width: auto;
        height: min(680px, calc(100vh - 20px));
        border-radius: 16px;
      }

      #bradley-chat.projecthub-minimized {
        width: auto;
      }

      .projecthub-title {
        font-size: 15px;
      }

      .projecthub-subtitle {
        max-width: 210px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #bradley-chat,
      .message-row,
      .typing-dot,
      .suggestion-chip,
      .followup-chip,
      .send-button,
      .projecthub-icon-button {
        animation: none !important;
        transition: none !important;
      }
    }
  `;
  document.head.appendChild(style);

  const chatDiv = document.createElement("section");
  chatDiv.id = "bradley-chat";
  chatDiv.setAttribute("aria-label", "Bradley Matera ProjectHub chat");

  chatDiv.innerHTML = `
    <header class="projecthub-header">
      <div class="projecthub-avatar-wrap">
        <img class="projecthub-avatar" src="${avatarUrl}" alt="Bradley Matera avatar">
        <span class="projecthub-status-dot" aria-hidden="true"></span>
      </div>
      <div class="projecthub-title-block">
        <div class="projecthub-kicker">Recruiter assistant</div>
        <div class="projecthub-title">Bradley Matera ProjectHub</div>
        <div class="projecthub-subtitle">Projects, skills, AWS, fit, and contact links</div>
      </div>
      <div class="projecthub-actions">
        <button class="projecthub-icon-button projecthub-settings-button" type="button" aria-label="Open chat settings" title="Chat settings">⚙</button>
        <button class="projecthub-icon-button projecthub-minimize-button" type="button" aria-label="Minimize chat" title="Minimize chat">−</button>
      </div>
    </header>
    <div class="projecthub-settings-panel" role="dialog" aria-label="ProjectHub chat settings">
      <div class="settings-head">
        <div>
          <div class="settings-title">Chat Settings</div>
          <div class="settings-subtitle">Tune memory, personalization, and input behavior.</div>
        </div>
        <button class="projecthub-icon-button projecthub-settings-close" type="button" aria-label="Close settings" title="Close settings">×</button>
      </div>
      <div class="settings-grid">
        <label class="setting-row"><span><strong>Session memory</strong><span>Use recent turns for coherent follow-ups.</span></span><input class="setting-toggle" type="checkbox" data-setting="memoryEnabled"></label>
        <label class="setting-row"><span><strong>AI flavor labels</strong><span>Add guarded 3-5 word generated notes.</span></span><input class="setting-toggle" type="checkbox" data-setting="flavorEnabled"></label>
        <label class="setting-row"><span><strong>Personal replies</strong><span>Use your name and varied response openings.</span></span><input class="setting-toggle" type="checkbox" data-setting="personalizeReplies"></label>
        <label class="setting-row"><span><strong>Enter to send</strong><span>Shift+Enter still adds a new line.</span></span><input class="setting-toggle" type="checkbox" data-setting="enterToSend"></label>
        <label class="setting-row"><span><strong>Compact mode</strong><span>Fits tighter screens and repeated use.</span></span><input class="setting-toggle" type="checkbox" data-setting="compactMode"></label>
      </div>
      <div class="settings-actions">
        <button class="settings-action-button danger clear-memory-button" type="button">Clear memory</button>
        <button class="settings-action-button rename-button" type="button">Change name</button>
      </div>
    </div>
    <div class="projecthub-body">
      <div id="chat-output" aria-live="polite"></div>
      <div class="projecthub-suggestions" aria-label="Suggested questions"></div>
    </div>
    <form class="projecthub-composer">
      <div class="composer-shell">
        <textarea id="chat-input" rows="1" placeholder="Ask about Bradley's work, projects, skills, or roles..."></textarea>
        <button class="send-button" type="submit" aria-label="Send message" title="Send message">
          <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="m22 2-7 20-4-9-9-4Z"></path>
            <path d="M22 2 11 13"></path>
          </svg>
        </button>
      </div>
    </form>
  `;

  document.body.appendChild(chatDiv);

  const chatOutput = chatDiv.querySelector("#chat-output");
  const suggestionBar = chatDiv.querySelector(".projecthub-suggestions");
  const chatInput = chatDiv.querySelector("#chat-input");
  const sendButton = chatDiv.querySelector(".send-button");
  const settingsBtn = chatDiv.querySelector(".projecthub-settings-button");
  const settingsCloseBtn = chatDiv.querySelector(".projecthub-settings-close");
  const minimizeBtn = chatDiv.querySelector(".projecthub-minimize-button");
  const clearMemoryBtn = chatDiv.querySelector(".clear-memory-button");
  const renameBtn = chatDiv.querySelector(".rename-button");
  const composer = chatDiv.querySelector(".projecthub-composer");

  function saveSettings() {
    try {
      window.localStorage.setItem(settingsStorageKey, JSON.stringify(chatSettings));
    } catch (error) {}
    chatDiv.classList.toggle("projecthub-compact", chatSettings.compactMode);
    chatDiv.querySelectorAll(".setting-toggle").forEach(toggle => {
      toggle.checked = Boolean(chatSettings[toggle.dataset.setting]);
    });
  }

  function saveVisitorName(name) {
    visitorName = name;
    try {
      if (name) window.sessionStorage.setItem(nameStorageKey, name);
      else window.sessionStorage.removeItem(nameStorageKey);
    } catch (error) {}
  }

  function extractVisitorName(value) {
    const cleaned = String(value || "").trim();
    const match = cleaned.match(/(?:my name is|i am|i'm|im|this is|call me)\s+([a-z][a-z .'-]{1,32})/i);
    const rawName = (match ? match[1] : cleaned).split(/[,.!?]/)[0].trim();
    if (!rawName || rawName.length > 32 || /\b(what|why|how|tell|about|project|bradley|aws|contact|github|linkedin)\b/i.test(rawName)) return "";
    return rawName.split(/\s+/).slice(0, 2).map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
  }

  function conversationalLead(userQuery) {
    if (!chatSettings.personalizeReplies || !visitorName) return "";
    const leads = [
      `${visitorName}, here’s the useful read:`,
      `Good question, ${visitorName}.`,
      `${visitorName}, the short version is:`,
      `For your screen, ${visitorName}:`,
      `${visitorName}, I’d frame it this way:`
    ];
    const seed = [...String(userQuery), String(turnCount)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return `<span class="conversation-lead">${escapeHtml(leads[Math.abs(seed) % leads.length])}</span>`;
  }

  function personalizeReply(reply, userQuery) {
    const lead = conversationalLead(userQuery);
    return lead ? `${lead}${reply}` : reply;
  }

  async function clearRemoteMemory() {
    try {
      await fetch(chatApiUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clearMemory", sessionId })
      });
    } catch (error) {
      console.warn("ProjectHub remote memory clear skipped:", error.message);
    }
  }

  async function resetChatMemory() {
    await clearRemoteMemory();
    conversationContext = [];
    saveVisitorName("");
    lastBotReplyText = "";
    lastSubmittedQuery = "";
    lastSubmittedAt = 0;
    turnCount = 0;
    sessionId = createSessionId();
    try {
      window.sessionStorage.setItem(sessionStorageKey, sessionId);
    } catch (error) {}
    chatOutput.innerHTML = "";
    appendMessage("bot", "ProjectHub", "Memory cleared. What should I call you for this new session?");
  }

  function appendMessage(type, label, html, options = {}) {
    const row = document.createElement("div");
    row.className = `message-row ${type}-row`;

    const avatar = type === "bot"
      ? `<img class="message-avatar" src="${avatarUrl}" alt="ProjectHub bot">`
      : `<div class="user-initial" aria-hidden="true"></div>`;

    row.innerHTML = `
      ${avatar}
      <div class="message ${type}-message">
        <span class="message-label">${label}</span>
        <div class="message-content">${linkifyHtml(html)}</div>
        <div class="timestamp">${new Date().toLocaleTimeString()}</div>
      </div>
    `;

    if (options.statusId) row.id = options.statusId;
    chatOutput.appendChild(row);
    chatOutput.scrollTop = chatOutput.scrollHeight;
    return row;
  }

  function appendTypingStatus() {
    return appendMessage("bot", "ProjectHub", `<span class="typing-bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></span>`, { statusId: "thinking-status" });
  }

  function setBusy(isBusy) {
    isRequestInFlight = isBusy;
    sendButton.disabled = isBusy;
    chatInput.disabled = isBusy;
    chatDiv.classList.toggle("projecthub-busy", isBusy);
  }

  function resizeInput() {
    chatInput.style.height = "auto";
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 130)}px`;
  }

  function setInputValue(value) {
    chatInput.value = value;
    resizeInput();
    chatInput.focus();
  }

  function rememberTurn(role, content) {
    conversationContext.push({ role, content: normalizeForCompare(content).slice(0, 420), at: Date.now() });
    conversationContext = conversationContext.slice(-8);
  }

  function renderSuggestions() {
    const prioritySuggestions = [
      "Why is Bradley a good junior candidate?",
      "Tell me about ProjectHub",
      "What AWS experience does Bradley have?",
      "What concerns should a recruiter know?",
      "How can I contact Bradley?"
    ];
    const allSuggestions = [...prioritySuggestions, ...suggestions.filter(item => !prioritySuggestions.includes(item))].slice(0, 12);
    suggestionBar.innerHTML = allSuggestions.map(item => `<button class="suggestion-chip" type="button" data-suggestion="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("");
  }

  minimizeBtn.addEventListener("click", () => {
    const isMinimized = chatDiv.classList.toggle("projecthub-minimized");
    minimizeBtn.innerHTML = isMinimized ? "+" : "−";
    minimizeBtn.setAttribute("aria-label", isMinimized ? "Open chat" : "Minimize chat");
    minimizeBtn.title = isMinimized ? "Open chat" : "Minimize chat";
  });

  settingsBtn.addEventListener("click", () => {
    chatDiv.classList.toggle("projecthub-settings-open");
  });

  settingsCloseBtn.addEventListener("click", () => {
    chatDiv.classList.remove("projecthub-settings-open");
  });

  chatDiv.querySelectorAll(".setting-toggle").forEach(toggle => {
    toggle.addEventListener("change", () => {
      chatSettings = { ...chatSettings, [toggle.dataset.setting]: toggle.checked };
      saveSettings();
    });
  });

  clearMemoryBtn.addEventListener("click", () => {
    resetChatMemory();
    chatDiv.classList.remove("projecthub-settings-open");
  });

  renameBtn.addEventListener("click", () => {
    saveVisitorName("");
    appendMessage("bot", "ProjectHub", "No problem. What should I call you for this session?");
    chatDiv.classList.remove("projecthub-settings-open");
    chatInput.focus();
  });

  chatInput.addEventListener("input", resizeInput);

  suggestionBar.addEventListener("click", event => {
    const suggestionButton = event.target.closest(".suggestion-chip");
    if (!suggestionButton || isRequestInFlight) return;
    setInputValue(suggestionButton.dataset.suggestion || suggestionButton.textContent || "");
    submitChat();
  });

  chatOutput.addEventListener("click", event => {
    const followupButton = event.target.closest(".followup-chip");
    if (!followupButton || isRequestInFlight) return;
    setInputValue(followupButton.dataset.followup || followupButton.textContent || "");
    submitChat();
  });

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
    setBusy(true);

    appendMessage("user", "You", escapeHtml(userQuery));

    if (!visitorName) {
      const possibleName = extractVisitorName(userQuery);
      if (possibleName) {
        saveVisitorName(possibleName);
        appendMessage("bot", "ProjectHub", `Nice to meet you, ${escapeHtml(visitorName)}. I’ll keep this session personal and coherent. Ask me about Bradley’s projects, AWS background, role fit, gaps, or contact details.`);
        rememberTurn("user", userQuery);
        rememberTurn("assistant", `Visitor name captured as ${visitorName}`);
        turnCount += 1;
        chatInput.value = "";
        resizeInput();
        setBusy(false);
        return;
      }
      appendMessage("bot", "ProjectHub", "Before we dig in, what should I call you for this session? A first name is enough.");
      chatInput.value = "";
      resizeInput();
      setBusy(false);
      return;
    }

    const statusRow = appendTypingStatus();

    try {
      const { reply, newTopic } = await handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData, {
        sessionId,
        context: chatSettings.memoryEnabled ? conversationContext : [],
        options: {
          memoryEnabled: chatSettings.memoryEnabled,
          flavorEnabled: chatSettings.flavorEnabled,
          visitorName
        }
      });
      lastQueryTopic = newTopic;
      const finalReply = personalizeReply(reply, userQuery);
      const plainReply = normalizeForCompare(finalReply);

      if (plainReply && plainReply === lastBotReplyText) {
        appendMessage("bot", "ProjectHub", `${escapeHtml(visitorName)}, I’d just repeat myself there. Try a sharper angle like recruiter fit, technical depth, risk, tradeoffs, or one specific project.`);
        chatInput.value = "";
        resizeInput();
        return;
      }

      appendMessage("bot", "ProjectHub", finalReply);
      rememberTurn("user", userQuery);
      rememberTurn("assistant", finalReply);
      lastBotReplyText = plainReply;
      turnCount += 1;
      chatInput.value = "";
      resizeInput();
    } catch (error) {
      console.error("ProjectHub chat error:", error);
      appendMessage("bot", "ProjectHub", "I can still help from Bradley’s verified profile details. Try asking about projects, AWS experience, CIRIS, target roles, skills, or contact links.");
    } finally {
      statusRow.remove();
      setBusy(false);
      chatInput.placeholder = "Ask about Bradley's work, projects, skills, or roles...";
      chatInput.focus();
    }
  };

  composer.addEventListener("submit", event => {
    event.preventDefault();
    submitChat();
  });

  chatInput.addEventListener("keydown", event => {
    if (chatSettings.enterToSend && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitChat();
    }
  });

  saveSettings();
  renderSuggestions();
  appendMessage("bot", "ProjectHub", visitorName
    ? `Welcome back, ${escapeHtml(visitorName)}. Ask about Bradley’s projects, AWS experience, CIRIS work, target roles, risks, or contact details and I’ll keep the thread coherent.`
    : "Hi, I’m Bradley Matera’s recruiter assistant. What should I call you for this session? A first name is enough, and then I’ll keep the conversation personal and coherent.");

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
