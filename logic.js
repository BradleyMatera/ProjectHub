// Function to handle user queries
// The client is a thin pass-through: all routing, grounded answers, and LLM
// generation happen on the server. This keeps answers consistent, contextual,
// and conversation-aware instead of fragmented across client and server.
async function handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData, chatSession = {}) {
  let newTopic = lastQueryTopic;

  const CHAT_API_URL = window.__PROJECTHUB_CHAT_API__
    || (/^(^|\.)bradleymatera\.dev$/.test(window.location.hostname)
      ? "/.netlify/functions/recruiter-chat"
      : "https://projecthub-chat.bradleymatera.dev/api/chat");
  const AI_TIMEOUT_MS = 18000;
  const AI_RETRIES = 1;

  async function askAIBackend() {
    let lastError = null;

    function escapeHtml(value) {
      return String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
    }

    for (let attempt = 1; attempt <= AI_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
        const history = (Array.isArray(chatSession.context) ? chatSession.context : []).reduce((acc, turn) => {
          if (turn.role === 'user') {
            acc.push({ user: turn.content, assistant: '' });
          } else if (turn.role === 'bot' && acc.length > 0) {
            acc[acc.length - 1].assistant = turn.content;
          }
          return acc;
        }, []).slice(-5);

        const res = await fetch(CHAT_API_URL, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: userQuery,
            sessionId: chatSession.sessionId,
            history,
            options: chatSession.options || {}
          })
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          if (data.reply) {
            const flavor = data.flavor
              ? `<span class="ai-flavor" title="Tiny generated phrase">${escapeHtml(data.flavor)}</span><br>`
              : "";
            const followUps = Array.isArray(data.followUps) && data.followUps.length
              ? `<div class="followup-list"><strong>Good follow-ups:</strong>${data.followUps.slice(0, 3).map(item => `<button type="button" class="followup-chip" data-followup="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div>`
              : "";
            return { reply: `${flavor}${data.reply}${followUps}`, error: null, sessionMemory: data.sessionMemory || null };
          }
        } else {
          lastError = `HTTP ${res.status}`;
          console.warn(`AI backend attempt ${attempt} failed: ${lastError}`);
        }
      } catch (error) {
        lastError = error.name === "AbortError" ? "timeout" : error.message;
        console.warn(`AI backend attempt ${attempt} error: ${lastError}`);
      }
    }

    return { reply: null, error: lastError || "no response" };
  }

  // Every question goes to the server. The server handles:
  // - Safety/injection blocking
  // - False-claim refusal
  // - Grounded deterministic answers (contact, projects, role-fit, etc.)
  // - LLM provider network for conversational questions
  // - Follow-up suggestions
  // - Session memory and conversation context
  const aiResult = await askAIBackend();

  if (aiResult.reply) {
    return { reply: aiResult.reply, newTopic: "ai" };
  }

  // Fallback if the server is unreachable
  const fallbackReply = "I'm here to help with Bradley Matera's work as a junior software engineer. Try asking about ProjectHub, the AWS serverless workflow, CIRIS Ethical AI, his GitHub or LinkedIn, target roles, or strongest technical skills.";
  return { reply: fallbackReply, newTopic: "unrelated" };
}