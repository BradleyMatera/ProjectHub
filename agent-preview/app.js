'use strict';

const state = {
  sessionId: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `preview_${Date.now()}`,
  history: [],
  mode: 'server', // 'server' (FULL/LITE) or 'client' (CLIENT LOCAL)
  clientEngine: null,
  clientStatus: 'uninitialized' // uninitializing, loading, ready, error
};

const elements = {
  form: document.querySelector('#chat-form'),
  input: document.querySelector('#message'),
  send: document.querySelector('#send'),
  messages: document.querySelector('#messages'),
  dot: document.querySelector('#connection-dot'),
  connection: document.querySelector('#connection-label'),
  agentMode: document.querySelector('#agent-mode'),
  ollamaModel: document.querySelector('#ollama-model'),
  ollamaStatus: document.querySelector('#ollama-status'),
  ollamaStructured: document.querySelector('#ollama-structured'),
  sessionState: document.querySelector('#session-state'),
  providers: document.querySelector('#providers'),
  lastRoute: document.querySelector('#last-route'),
  probeBtn: document.querySelector('#probe-btn'),
  probeResult: document.querySelector('#probe-result'),
  modeSelect: document.querySelector('#mode-select'),
  clientStatus: document.querySelector('#client-status'),
  clientBackend: document.querySelector('#client-backend'),
  clientLoadPct: document.querySelector('#client-load-pct'),
  clientInitBtn: document.querySelector('#client-init-btn')
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
    const details = document.createElement('details');
    details.className = 'trace';
    const summary = document.createElement('summary');
    summary.textContent = 'Agent trace';
    const traceDiv = document.createElement('div');
    traceDiv.className = 'trace-detail';

    // Route line
    const routeLine = document.createElement('div');
    routeLine.className = 'trace-route';
    routeLine.innerHTML = `<strong>Route</strong>: ${trace.route} · <strong>Latency</strong>: ${trace.latencyMs}ms · <strong>Context</strong>: ${trace.contextTokens || 'n/a'} tokens`;
    traceDiv.append(routeLine);

    // Pipeline
    if (trace.pipeline && trace.pipeline.length) {
      const pipeLine = document.createElement('div');
      pipeLine.innerHTML = `<strong>Pipeline</strong>: ${trace.pipeline.join(' → ')}`;
      traceDiv.append(pipeLine);
    }

    // Agent meta
    if (trace.agent) {
      const agentLine = document.createElement('div');
      const outcome = trace.agent.outcome ? ` · outcome=${trace.agent.outcome}` : '';
      agentLine.innerHTML = `<strong>Agent</strong>: engine=${trace.agent.engine || 'legacy'} · tools=[${(trace.agent.tools || []).join(',')}] · steps=${trace.agent.steps || 0} · validation=${trace.agent.validation || 'n/a'}${outcome}`;
      traceDiv.append(agentLine);
    }

    // Agent events timeline
    if (trace.events && trace.events.length) {
      const eventsTitle = document.createElement('div');
      eventsTitle.className = 'trace-events-title';
      eventsTitle.textContent = 'Agent events (real backend events):';
      traceDiv.append(eventsTitle);

      const eventList = document.createElement('div');
      eventList.className = 'trace-events';
      for (const evt of trace.events) {
        const evtLine = document.createElement('div');
        evtLine.className = `trace-event ${evt.type}`;
        let text = `[${evt.ts}ms] ${evt.type}`;
        if (evt.tool) text += `:${evt.tool}`;
        if (evt.model) text += ` model=${evt.model}`;
        if (evt.contextTokens) text += ` ctx=${evt.contextTokens}tok`;
        if (evt.latencyMs) text += ` ${evt.latencyMs}ms`;
        if (evt.error) text += ` ERROR:${evt.error}`;
        if (evt.decision) text += ` → ${evt.decision.action}`;
        if (evt.verdict) text += ` verdict=${evt.verdict}`;
        if (evt.reason) text += ` reason=${evt.reason}`;
        if (evt.outcome) text += ` outcome=${evt.outcome}`;
        if (evt.rejectionDetails) text += ` rejection=[${evt.rejectionDetails.map(r=>r.reason).join(',')}]`;
        evtLine.textContent = text;
        eventList.append(evtLine);
      }
      traceDiv.append(eventList);
    }

    details.append(summary, traceDiv);
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
    elements.ollamaModel.textContent = data.agent?.ollamaModel || data.genModel || 'Unknown';
    elements.sessionState.textContent = data.memory?.sessionStateStore || 0;

    // Load agent probe for Ollama reachability + structured JSON
    try {
      const probeResp = await fetch('/api/agent-probe', { cache: 'no-store' });
      if (probeResp.ok) {
        const probe = await probeResp.json();
        elements.ollamaStatus.textContent = probe.reachable ? `Yes (${probe.latencyMs}ms)` : 'No';
        elements.ollamaStatus.className = probe.reachable ? 'ok' : 'off';
        elements.ollamaStructured.textContent = probe.structuredOk ? 'Yes' : 'No';
        elements.ollamaStructured.className = probe.structuredOk ? 'ok' : 'off';

        // Render pinned models
        elements.providers.replaceChildren();
        if (probe.pinnedModels && probe.pinnedModels.length) {
          for (const model of probe.pinnedModels) {
            const row = document.createElement('div');
            row.className = 'provider';
            const name = document.createElement('span');
            name.textContent = `${model.name} (${model.parameterSize}, ${model.quantization})`;
            const status = document.createElement('em');
            const isCurrent = model.name === (data.agent?.ollamaModel || data.genModel);
            status.textContent = isCurrent ? 'active' : 'available';
            if (isCurrent) status.className = 'ok';
            row.append(name, status);
            elements.providers.append(row);
          }
        }
      }
    } catch {}

  } catch (error) {
    elements.dot.className = 'dot offline';
    elements.connection.textContent = `Service unavailable: ${error.message}`;
  }
}

async function runProbe() {
  if (elements.probeResult) elements.probeResult.textContent = 'Probing...';
  try {
    const resp = await fetch('/api/agent-probe', { cache: 'no-store' });
    const data = await resp.json();
    elements.probeResult.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    elements.probeResult.textContent = `Probe failed: ${error.message}`;
  }
}

async function runWorkflow(message) {
  addMessage('user', message);
  elements.send.disabled = true;
  elements.send.textContent = 'Thinking…';
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId: state.sessionId, history: state.history.slice(-5) })
    });
    const data = await response.json();
    if (!response.ok || !data.reply) throw new Error(data.error || `HTTP ${response.status}`);

    const route = `${data.provider || 'unknown'} / ${data.model || 'unknown'}`;
    const trace = {
      route,
      latencyMs: data.pipeline ? null : null,
      pipeline: data.pipeline || [],
      agent: data.agent,
      events: data.agentEvents,
      contextTokens: data.agent?.contextTokens
    };
    addMessage('scout', data.reply, trace);
    elements.lastRoute.textContent = route;
    state.history.push({ user: message, assistant: data.reply });
    state.history = state.history.slice(-5);
    // Refresh session state count
    loadHealth();
  } catch (error) {
    addMessage('scout', `Workflow failed: ${error.message}`);
  } finally {
    elements.send.disabled = false;
    elements.send.textContent = 'Send';
    elements.input.focus();
  }
}

// --- CLIENT LOCAL mode ---

function updateClientStatus() {
  if (!elements.clientStatus) return;
  const status = state.clientStatus;
  elements.clientStatus.textContent = status;
  elements.clientStatus.className = `client-status ${status}`;
  if (status === 'ready' && state.clientEngine) {
    elements.clientBackend.textContent = state.clientEngine.device || 'cpu';
    if (elements.clientLoadPct) elements.clientLoadPct.textContent = '100%';
  } else if (status === 'loading') {
    if (elements.clientLoadPct) elements.clientLoadPct.textContent = 'loading...';
  } else if (status === 'error') {
    if (elements.clientLoadPct) elements.clientLoadPct.textContent = 'failed';
  }
}

async function initClientEngine() {
  if (state.clientStatus === 'loading' || state.clientStatus === 'ready') return;
  state.clientStatus = 'loading';
  updateClientStatus();
  if (elements.clientInitBtn) {
    elements.clientInitBtn.disabled = true;
    elements.clientInitBtn.textContent = 'Loading model...';
  }
  try {
    // Load the generation engine
    if (!state.clientEngine) {
      state.clientEngine = new ScoutGenerationEngine();
    }
    await state.clientEngine.initialize({
      onProgress: (pct) => {
        if (elements.clientLoadPct) elements.clientLoadPct.textContent = `${Math.round(pct)}%`;
      }
    });
    state.clientStatus = 'ready';
    updateClientStatus();
    if (elements.clientInitBtn) {
      elements.clientInitBtn.textContent = 'Model ready';
      elements.clientInitBtn.className = 'ok';
    }
  } catch (err) {
    state.clientStatus = 'error';
    updateClientStatus();
    if (elements.clientInitBtn) {
      elements.clientInitBtn.disabled = false;
      elements.clientInitBtn.textContent = 'Retry';
    }
    addMessage('scout', `Client AI init failed: ${err.message}. Using server mode.`);
  }
}

async function runClientWorkflow(message) {
  addMessage('user', message);
  elements.send.disabled = true;
  elements.send.textContent = 'Generating…';
  try {
    if (!state.clientEngine || !state.clientEngine.initialized) {
      await initClientEngine();
      if (state.clientStatus !== 'ready') {
        throw new Error('Client engine not ready');
      }
    }
    const result = await state.clientEngine.ask(message, state.sessionId, '', state.history.slice(-5));
    const trace = {
      route: `client-local / ${result.source}`,
      latencyMs: result.genMs || 0,
      pipeline: ['client-packet', 'browser-generate', 'client-validate'],
      agent: {
        engine: 'client-local',
        validation: result.validated ? 'valid' : 'invalid',
        outcome: result.source
      },
      contextTokens: result.packetTokens
    };
    addMessage('scout', result.answer, trace);
    elements.lastRoute.textContent = `client-local / ${result.source}`;
    state.history.push({ user: message, assistant: result.answer });
    state.history = state.history.slice(-5);
  } catch (error) {
    addMessage('scout', `Client workflow failed: ${error.message}`);
  } finally {
    elements.send.disabled = false;
    elements.send.textContent = 'Send';
    elements.input.focus();
  }
}

// Mode selector
if (elements.modeSelect) {
  elements.modeSelect.addEventListener('change', (e) => {
    state.mode = e.target.value;
    if (state.mode === 'client' && state.clientStatus === 'uninitialized') {
      // Don't auto-init; let user click the init button
      if (elements.clientInitBtn) elements.clientInitBtn.style.display = '';
    }
  });
}

if (elements.clientInitBtn) {
  elements.clientInitBtn.addEventListener('click', initClientEngine);
}

elements.form.addEventListener('submit', event => {
  event.preventDefault();
  const message = elements.input.value.trim();
  if (!message) return;
  elements.input.value = '';
  if (state.mode === 'client') {
    runClientWorkflow(message);
  } else {
    runWorkflow(message);
  }
});

for (const button of document.querySelectorAll('[data-prompt]')) {
  button.addEventListener('click', () => {
    elements.input.value = button.dataset.prompt;
    elements.input.focus();
  });
}

if (elements.probeBtn) {
  elements.probeBtn.addEventListener('click', runProbe);
}

loadHealth();
