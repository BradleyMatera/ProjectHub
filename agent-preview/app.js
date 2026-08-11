'use strict';

const state = {
  sessionId: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `preview_${Date.now()}`,
  history: []
};

const elements = {
  form: document.querySelector('#chat-form'),
  input: document.querySelector('#message'),
  send: document.querySelector('#send'),
  messages: document.querySelector('#messages'),
  dot: document.querySelector('#connection-dot'),
  connection: document.querySelector('#connection-label'),
  providers: document.querySelector('#providers'),
  agentMode: document.querySelector('#agent-mode'),
  cloudAi: document.querySelector('#cloud-ai'),
  ollamaModel: document.querySelector('#ollama-model'),
  lastRoute: document.querySelector('#last-route')
};

function addMessage(role, text, trace) {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const label = document.createElement('span');
  label.textContent = role === 'user' ? 'You' : 'Scout';
  const body = document.createElement('p');
  body.textContent = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  article.append(label, body);
  if (trace) {
    const details = document.createElement('div');
    details.className = 'trace';
    const route = document.createElement('strong');
    route.textContent = trace.route;
    details.append('Route: ', route, ` · ${trace.details}`);
    article.append(details);
  }
  elements.messages.append(article);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

async function loadHealth() {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    elements.dot.className = 'dot online';
    elements.connection.textContent = 'Private service online';
    elements.agentMode.textContent = data.agent?.mode || 'Unavailable';
    elements.cloudAi.textContent = data.localOnly && !(data.providerOrder || []).length ? 'Disabled' : 'Configured';
    elements.ollamaModel.textContent = data.agent?.ollamaControllerEnabled ? data.agent.ollamaModel : 'Deterministic fallback';
    elements.providers.replaceChildren();
    const activeProviders = new Set(data.providerOrder || []);
    if (data.localOnly) {
      const row = document.createElement('div');
      row.className = 'provider';
      row.innerHTML = '<span>Qwen + BM25</span><em>local only</em>';
      elements.providers.append(row);
    }
    for (const provider of (data.providers || []).filter(item => activeProviders.has(item.slug))) {
      const row = document.createElement('div');
      row.className = 'provider';
      const name = document.createElement('span');
      name.textContent = provider.slug;
      const status = document.createElement('em');
      const ready = provider.enabled && provider.available;
      status.textContent = !provider.enabled ? 'not configured' : provider.available ? 'quota ready' : 'cooldown';
      if (!ready) status.className = 'off';
      row.append(name, status);
      elements.providers.append(row);
    }
  } catch (error) {
    elements.dot.className = 'dot offline';
    elements.connection.textContent = `Service unavailable: ${error.message}`;
  }
}

async function runWorkflow(message) {
  addMessage('user', message);
  elements.send.disabled = true;
  elements.send.textContent = 'Running…';
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId: state.sessionId, history: state.history.slice(-5) })
    });
    const data = await response.json();
    if (!response.ok || !data.reply) throw new Error(data.error || `HTTP ${response.status}`);
    const tools = data.agent?.tools?.length ? `tools: ${data.agent.tools.join(', ')}` : 'no tools';
    const route = `${data.provider || 'unknown'} / ${data.model || 'unknown'}`;
    addMessage('scout', data.reply, { route, details: `${tools} · ${(data.pipeline || []).join(' → ')}` });
    elements.lastRoute.textContent = route;
    state.history.push({ user: message, assistant: data.reply });
    state.history = state.history.slice(-5);
  } catch (error) {
    addMessage('scout', `Workflow failed: ${error.message}`);
  } finally {
    elements.send.disabled = false;
    elements.send.textContent = 'Run workflow';
    elements.input.focus();
  }
}

elements.form.addEventListener('submit', event => {
  event.preventDefault();
  const message = elements.input.value.trim();
  if (!message) return;
  elements.input.value = '';
  runWorkflow(message);
});

for (const button of document.querySelectorAll('[data-prompt]')) {
  button.addEventListener('click', () => {
    elements.input.value = button.dataset.prompt;
    elements.input.focus();
  });
}

loadHealth();
