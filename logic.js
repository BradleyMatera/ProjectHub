function buildServerHistory(context) {
  return (Array.isArray(context) ? context : []).reduce((turns, turn) => {
    if (turn.role === 'user') {
      turns.push({ user: turn.content, assistant: '' });
    } else if ((turn.role === 'bot' || turn.role === 'assistant') && turns.length > 0) {
      turns[turns.length - 1].assistant = turn.content;
    }
    return turns;
  }, []).slice(-5);
}

const SCOUT_PUBLIC_PHONE = '(608) 313-5373';
const SCOUT_PUBLIC_PHONE_DIGITS = '6083135373';
const CLOUDFLARE_FREE_NEURONS_PER_DAY = 10000;
const CLOUDFLARE_INPUT_NEURONS_PER_MILLION = 4119;
const CLOUDFLARE_OUTPUT_NEURONS_PER_MILLION = 34868;
const CLOUDFLARE_USD_PER_1000_NEURONS = 0.011;

function escapeScoutHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>\"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '\"': '&quot;'
  }[c]));
}

function scrubPublicPhoneNumbers(value) {
  const phonePattern = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}/g;
  return String(value == null ? '' : value).replace(phonePattern, match => {
    const digits = match.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    return digits === SCOUT_PUBLIC_PHONE_DIGITS ? SCOUT_PUBLIC_PHONE : '[phone withheld]';
  });
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatScoutNumber(value, maximumFractionDigits = 1) {
  return finiteNumber(value).toLocaleString(undefined, { maximumFractionDigits });
}

function estimateCloudflareNeurons(inputTokens, outputTokens) {
  return (finiteNumber(inputTokens) / 1e6) * CLOUDFLARE_INPUT_NEURONS_PER_MILLION
    + (finiteNumber(outputTokens) / 1e6) * CLOUDFLARE_OUTPUT_NEURONS_PER_MILLION;
}

function estimatedCloudflareMeteredUsd(neurons) {
  return (finiteNumber(neurons) / 1000) * CLOUDFLARE_USD_PER_1000_NEURONS;
}

function getScoutUsageState() {
  if (!window.__PROJECTHUB_USAGE__) {
    window.__PROJECTHUB_USAGE__ = {
      questions: 0,
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      actualNeurons: 0,
      estimatedNeurons: 0,
      inferenceLatencyMs: 0,
      repairs: 0,
      generatedAnswers: 0,
      directKbAnswers: 0,
      technicalErrors: 0
    };
  }
  return window.__PROJECTHUB_USAGE__;
}

function summarizeGenerationCalls(data) {
  const calls = Array.isArray(data?.agent?.generationCalls) ? data.agent.generationCalls : [];
  const totals = calls.reduce((acc, call) => {
    acc.inputTokens += finiteNumber(call.inputTokens);
    acc.outputTokens += finiteNumber(call.outputTokens);
    acc.actualNeurons += finiteNumber(call.actualNeurons);
    acc.estimatedNeurons += finiteNumber(call.estimatedNeurons);
    acc.latencyMs += finiteNumber(call.latencyMs);
    if (String(call.attemptType || '').toUpperCase() === 'FACTUAL_REPAIR') acc.repairs += 1;
    return acc;
  }, { inputTokens: 0, outputTokens: 0, actualNeurons: 0, estimatedNeurons: 0, latencyMs: 0, repairs: 0 });

  if (!totals.estimatedNeurons && (totals.inputTokens || totals.outputTokens)) {
    totals.estimatedNeurons = estimateCloudflareNeurons(totals.inputTokens, totals.outputTokens);
  }

  totals.calls = calls.length || finiteNumber(data?.agent?.actualProviderCalls);
  totals.provider = data?.provider || calls[0]?.provider || 'none';
  totals.model = data?.model || calls[0]?.model || 'none';
  totals.callsDetail = calls;
  return totals;
}

function recordScoutUsage(data, requestMetrics) {
  const session = getScoutUsageState();
  session.questions += 1;
  session.providerCalls += requestMetrics.calls;
  session.inputTokens += requestMetrics.inputTokens;
  session.outputTokens += requestMetrics.outputTokens;
  session.actualNeurons += requestMetrics.actualNeurons;
  session.estimatedNeurons += requestMetrics.estimatedNeurons;
  session.inferenceLatencyMs += requestMetrics.latencyMs;
  session.repairs += requestMetrics.repairs;

  const source = String(data?.proseSource || data?.agent?.proseSource || '').toUpperCase();
  if (source === 'MODEL_GENERATION') session.generatedAnswers += 1;
  else if (source === 'DIRECT_KB') session.directKbAnswers += 1;
  else if (source === 'TECHNICAL_ERROR') session.technicalErrors += 1;

  return session;
}

function getCostsApiUrl(chatApiUrl) {
  const url = String(chatApiUrl || '');
  if (/\/api\/chat(?:\?.*)?$/i.test(url)) return url.replace(/\/api\/chat(?:\?.*)?$/i, '/api/costs');
  if (/\.netlify\/functions\/recruiter-chat(?:\?.*)?$/i.test(url)) return url.replace(/\.netlify\/functions\/recruiter-chat(?:\?.*)?$/i, '.netlify/functions/costs');
  return null;
}

function resolveScoutChatApiUrl() {
  if (typeof window === 'undefined') return '';
  if (window.__PROJECTHUB_CHAT_API__) return window.__PROJECTHUB_CHAT_API__;
  if (window.location.pathname?.startsWith('/ProjectHub-dev/')) {
    return 'https://dev.projecthub-chat.bradleymatera.dev/api/chat';
  }
  if (/(^|\.)bradleymatera\.dev$/.test(window.location.hostname)) {
    return '/.netlify/functions/recruiter-chat';
  }
  return 'https://projecthub-chat.bradleymatera.dev/api/chat';
}

async function fetchScoutCosts(chatApiUrl) {
  const costsUrl = getCostsApiUrl(chatApiUrl);
  if (!costsUrl) return null;
  try {
    const res = await fetch(costsUrl, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function cloudflareDayFromCosts(costs) {
  const day = costs?.bySourceDay?.cloudflare || null;
  if (!day) return null;
  const inputTokens = finiteNumber(day.tokensIn);
  const outputTokens = finiteNumber(day.tokensOut);
  const neurons = estimateCloudflareNeurons(inputTokens, outputTokens);
  return {
    calls: finiteNumber(day.calls),
    inputTokens,
    outputTokens,
    neurons,
    pct: Math.min(100, (neurons / CLOUDFLARE_FREE_NEURONS_PER_DAY) * 100),
    remaining: Math.max(0, CLOUDFLARE_FREE_NEURONS_PER_DAY - neurons)
  };
}

function isProjectHubGithubPage() {
  if (typeof window === 'undefined' || !window.location) return false;
  return /(?:^|\.)github\.io$/i.test(window.location.hostname)
    && /\/ProjectHub(?:-dev)?(?:\/|$)/i.test(window.location.pathname);
}

function ensureScoutRuntimeDashboardStyles() {
  if (document.getElementById('scout-runtime-dashboard-styles')) return;
  const style = document.createElement('style');
  style.id = 'scout-runtime-dashboard-styles';
  style.textContent = `
    .scout-runtime-dashboard { margin-top: 1.5rem; padding: 1.25rem; border: 1px solid #525252; background: #161616; color: #f4f4f4; }
    .scout-runtime-dashboard h2 { margin: 0 0 .4rem; font-size: 1.2rem; font-weight: 500; }
    .scout-runtime-dashboard p { margin: .35rem 0; color: #c6c6c6; font-size: .86rem; line-height: 1.5; }
    .scout-runtime-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: .65rem; margin-top: .9rem; }
    .scout-runtime-metric { border: 1px solid #393939; padding: .75rem; min-height: 86px; background: #262626; }
    .scout-runtime-metric span { display:block; color:#a8a8a8; font-size:.68rem; text-transform:uppercase; letter-spacing:.04em; }
    .scout-runtime-metric strong { display:block; margin-top:.25rem; font-size:1rem; overflow-wrap:anywhere; }
    .scout-runtime-detail { margin-top:.8rem; padding-top:.7rem; border-top:1px solid #393939; font-size:.78rem; color:#c6c6c6; }
    @media (max-width:860px){.scout-runtime-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}
    @media (max-width:540px){.scout-runtime-grid{grid-template-columns:1fr;}}
  `;
  document.head.appendChild(style);
}

function getOrCreateScoutRuntimeDashboard() {
  if (!isProjectHubGithubPage()) return null;
  let panel = document.getElementById('scout-runtime-dashboard');
  if (panel) return panel;
  const host = document.querySelector('main.card') || document.querySelector('.card') || document.body;
  if (!host) return null;
  ensureScoutRuntimeDashboardStyles();
  panel = document.createElement('section');
  panel.id = 'scout-runtime-dashboard';
  panel.className = 'scout-runtime-dashboard';
  panel.setAttribute('aria-label', 'Scout runtime and usage dashboard');
  const firstSection = host.querySelector('.card-section');
  if (firstSection) host.insertBefore(panel, firstSection);
  else host.appendChild(panel);
  return panel;
}

async function refreshScoutRuntimeDashboard() {
  if (!isProjectHubGithubPage()) return;
  const panel = getOrCreateScoutRuntimeDashboard();
  if (!panel) return;
  const chatApiUrl = resolveScoutChatApiUrl();
  const costs = await fetchScoutCosts(chatApiUrl);
  const day = cloudflareDayFromCosts(costs);
  const session = typeof window !== 'undefined' && window.__PROJECTHUB_USAGE__ ? window.__PROJECTHUB_USAGE__ : null;
  const sessionNeurons = session ? (session.actualNeurons || session.estimatedNeurons || 0) : 0;
  const dayUsage = day ? `${formatScoutNumber(day.neurons, 2)} / 10,000` : 'waiting for /api/costs';
  const dayPercent = day ? `${formatScoutNumber(day.pct, 2)}% used` : 'daily total unavailable';
  const callsToday = day ? formatScoutNumber(day.calls, 0) : '—';
  const sessionTokens = session ? `${formatScoutNumber(session.inputTokens, 0)} in / ${formatScoutNumber(session.outputTokens, 0)} out` : '0 in / 0 out';
  panel.innerHTML = `
    <h2>Live Scout runtime & usage</h2>
    <p>This is the operational proof behind the free-tier claim. Local ProjectHub code performs conversation handling, BM25/RRF retrieval, evidence selection and factual validation; Cloudflare Workers AI performs normal generative inference.</p>
    <div class="scout-runtime-grid">
      <div class="scout-runtime-metric"><span>Generation</span><strong>Cloudflare Workers AI</strong><p>@cf/meta/llama-3.1-8b-instruct-fast</p></div>
      <div class="scout-runtime-metric"><span>Daily AI budget</span><strong>${escapeScoutHtml(dayUsage)} neurons</strong><p>${escapeScoutHtml(dayPercent)} · resets 00:00 UTC</p></div>
      <div class="scout-runtime-metric"><span>Model calls today</span><strong>${escapeScoutHtml(callsToday)}</strong><p>Backend ledger, when available</p></div>
      <div class="scout-runtime-metric"><span>App request control</span><strong>20 / minute / IP</strong><p>Server default unless overridden</p></div>
      <div class="scout-runtime-metric"><span>This browser session</span><strong>${escapeScoutHtml(sessionTokens)}</strong><p>${formatScoutNumber(session?.providerCalls || 0, 0)} model calls</p></div>
      <div class="scout-runtime-metric"><span>Session neurons</span><strong>${formatScoutNumber(sessionNeurons, 3)}</strong><p>${formatScoutNumber(session?.repairs || 0, 0)} factual repair calls</p></div>
      <div class="scout-runtime-metric"><span>Local RAG work</span><strong>BM25 + RRF</strong><p>Query/context → retrieval → evidence → validation</p></div>
      <div class="scout-runtime-metric"><span>Paid-rate reference</span><strong>$0.011 / 1k neurons</strong><p>Only a pricing reference; this panel does not infer billing charges</p></div>
    </div>
    <div class="scout-runtime-detail"><strong>How to read it:</strong> each Scout reply also shows its own provider calls, input/output tokens, neurons, model latency, RAG candidate/evidence counts, answer source and repair attempts. Free allocation is shared Cloudflare account usage, not a separate allowance for each visitor.</div>
  `;
}

function mountScoutRuntimeDashboard() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !isProjectHubGithubPage()) return;
  const start = () => {
    getOrCreateScoutRuntimeDashboard();
    refreshScoutRuntimeDashboard();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

function buildScoutTelemetryHtml(data, costs) {
  const request = summarizeGenerationCalls(data);
  const session = recordScoutUsage(data, request);
  const source = String(data?.proseSource || data?.agent?.proseSource || 'UNKNOWN').toUpperCase();
  const retrievalCandidates = Array.isArray(data?.agent?.retrievalCandidates) ? data.agent.retrievalCandidates : [];
  const selectedEvidence = Array.isArray(data?.agent?.selectedEvidence) ? data.agent.selectedEvidence : [];
  const selectedNames = selectedEvidence.slice(0, 8).map(item => {
    if (typeof item === 'string') return item.slice(0, 90);
    return item?.id || item?.chunkId || item?.tag || item?.name || item?.title || 'evidence';
  }).filter(Boolean);
  const day = cloudflareDayFromCosts(costs);
  const neuronsForValue = request.actualNeurons || request.estimatedNeurons;
  const meteredValue = estimatedCloudflareMeteredUsd(neuronsForValue);
  const sessionNeurons = session.actualNeurons || session.estimatedNeurons;
  const localWork = 'query/session context → BM25 + RRF retrieval → evidence selection → factual validation';
  const cloudWork = request.calls > 0
    ? `${request.calls} Cloudflare Workers AI inference call${request.calls === 1 ? '' : 's'}`
    : 'no model inference call';
  const answerPath = source === 'MODEL_GENERATION'
    ? 'RAG evidence → Cloudflare model → factual validator'
    : source === 'DIRECT_KB'
      ? 'verified knowledge answer; no generative model call'
      : source === 'TECHNICAL_ERROR'
        ? 'generation/validation failed closed'
        : 'server-selected response path';

  const dailyHtml = day
    ? `<div><strong>Daily Workers AI:</strong> ${formatScoutNumber(day.neurons, 2)} / ${formatScoutNumber(CLOUDFLARE_FREE_NEURONS_PER_DAY, 0)} neurons (${formatScoutNumber(day.pct, 2)}%); ${formatScoutNumber(day.remaining, 2)} remaining; ${formatScoutNumber(day.calls, 0)} model calls today. Resets 00:00 UTC.</div>`
    : `<div><strong>Daily Workers AI:</strong> live /api/costs total unavailable on this frontend route. Cloudflare free allocation: ${formatScoutNumber(CLOUDFLARE_FREE_NEURONS_PER_DAY, 0)} neurons/day, reset 00:00 UTC.</div>`;

  const callsHtml = request.callsDetail.length
    ? `<div style="margin-top:6px"><strong>Provider calls:</strong>${request.callsDetail.map((call, i) => {
        const callNeurons = finiteNumber(call.actualNeurons) || finiteNumber(call.estimatedNeurons)
          || estimateCloudflareNeurons(call.inputTokens, call.outputTokens);
        const number = call.attemptIndex != null ? call.attemptIndex + 1 : i + 1;
        return `<div style="margin-left:10px">#${escapeScoutHtml(number)} ${escapeScoutHtml(call.attemptType || 'PRIMARY')}: ${formatScoutNumber(call.inputTokens, 0)} in / ${formatScoutNumber(call.outputTokens, 0)} out · ${formatScoutNumber(callNeurons, 3)} neurons · ${formatScoutNumber(call.latencyMs, 0)} ms · ${call.accepted ? 'accepted' : 'not accepted'}</div>`;
      }).join('')}</div>`
    : '<div style="margin-top:6px"><strong>Provider calls:</strong> none</div>';

  return `
<div class="scout-telemetry" style="margin-top:10px;padding:9px 10px;border:1px solid rgba(127,127,127,.28);border-radius:7px;font-size:11px;line-height:1.45;opacity:.92;background:rgba(127,127,127,.07)">
  <div style="font-weight:700;margin-bottom:4px">⚙ Scout usage · ${escapeScoutHtml(source)}</div>
  <div><strong>This reply:</strong> ${escapeScoutHtml(request.provider)} · ${escapeScoutHtml(request.model)} · ${formatScoutNumber(request.calls, 0)} call${request.calls === 1 ? '' : 's'} · ${formatScoutNumber(request.inputTokens, 0)} input + ${formatScoutNumber(request.outputTokens, 0)} output tokens · ${formatScoutNumber(neuronsForValue, 3)} neurons · ${formatScoutNumber(request.latencyMs, 0)} ms model time</div>
  <div><strong>RAG:</strong> ${formatScoutNumber(retrievalCandidates.length, 0)} candidates → ${formatScoutNumber(selectedEvidence.length, 0)} evidence blocks sent to generation · tool enrichment ${data?.agent?.toolEnrichment ? 'used' : 'not used'}</div>
  <details style="margin-top:5px">
    <summary style="cursor:pointer;font-weight:600">How this answer was made + full usage details</summary>
    <div style="margin-top:6px"><strong>Answer path:</strong> ${escapeScoutHtml(answerPath)}</div>
    <div><strong>Local deterministic work:</strong> ${escapeScoutHtml(localWork)}</div>
    <div><strong>Cloud work:</strong> ${escapeScoutHtml(cloudWork)}</div>
    <div><strong>Repair attempts:</strong> ${formatScoutNumber(request.repairs, 0)}</div>
    <div><strong>Approx. metered value of this model usage:</strong> $${meteredValue.toFixed(6)}. This is a usage-equivalent value, not a claim that this request was billed.</div>
    ${callsHtml}
    <div style="margin-top:6px"><strong>Selected evidence IDs:</strong> ${selectedNames.length ? selectedNames.map(escapeScoutHtml).join(', ') : 'none exposed by backend'}</div>
    <div style="margin-top:6px"><strong>This browser session:</strong> ${formatScoutNumber(session.questions, 0)} questions · ${formatScoutNumber(session.providerCalls, 0)} provider calls · ${formatScoutNumber(session.inputTokens, 0)} input + ${formatScoutNumber(session.outputTokens, 0)} output tokens · ${formatScoutNumber(sessionNeurons, 3)} neurons · ${formatScoutNumber(session.repairs, 0)} repairs · ${formatScoutNumber(session.inferenceLatencyMs, 0)} ms model time</div>
    ${dailyHtml}
    <div><strong>App rate controls:</strong> server defaults to 20 chat requests/minute/IP unless configured otherwise. That is ProjectHub protection, separate from Cloudflare's daily AI allocation.</div>
    <div><strong>Spend:</strong> this dashboard shows the request's Cloudflare metered-value equivalent and free-allocation consumption. It does not infer an actual credit-card charge from token/neuron telemetry. Billing-plan charges, if any, must come from provider billing data rather than this estimate.</div>
  </details>
</div>`;
}

mountScoutRuntimeDashboard();

// Function to handle user queries
// The client is a thin pass-through: all routing, grounded answers, and LLM
// generation happen on the server. This keeps answers consistent, contextual,
// and conversation-aware instead of fragmented across client and server.
async function handleQuery(userQuery, projects, codePens, lastQueryTopic, fetchAllGitHubData, chatSession = {}) {
  let newTopic = lastQueryTopic;

  const CHAT_API_URL = resolveScoutChatApiUrl();
  const AI_TIMEOUT_MS = 18000;
  const AI_RETRIES = 1;

  async function askAIBackend() {
    let lastError = null;

    for (let attempt = 1; attempt <= AI_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
        const history = buildServerHistory(chatSession.context);

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
              ? `<span class="ai-flavor" title="Tiny generated phrase">${escapeScoutHtml(data.flavor)}</span><br>`
              : "";
            const followUps = Array.isArray(data.followUps) && data.followUps.length
              ? `<div class="followup-list"><strong>Good follow-ups:</strong>${data.followUps.slice(0, 3).map(item => `<button type="button" class="followup-chip" data-followup="${escapeScoutHtml(item)}">${escapeScoutHtml(item)}</button>`).join("")}</div>`
              : "";
            const costs = await fetchScoutCosts(CHAT_API_URL);
            const safeReply = scrubPublicPhoneNumbers(data.reply);
            const telemetry = buildScoutTelemetryHtml(data, costs);
            refreshScoutRuntimeDashboard();
            return {
              reply: `${flavor}${safeReply}${followUps}${telemetry}`,
              error: null,
              sessionMemory: data.sessionMemory || null,
              telemetry: data.agent || null
            };
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
  // - Verified knowledge and RAG evidence retrieval
  // - Generative RAG for conversational questions
  // - Follow-up suggestions
  // - Session memory and conversation context
  const aiResult = await askAIBackend();

  if (aiResult.reply) {
    return { reply: aiResult.reply, newTopic: "ai", telemetry: aiResult.telemetry || null };
  }

  // Fallback if the server is unreachable
  const fallbackReply = "I'm here to help with Bradley Matera's work as a junior software engineer. Try asking about ProjectHub, the AWS serverless workflow, CIRIS Ethical AI, his GitHub or LinkedIn, target roles, or strongest technical skills.";
  return { reply: fallbackReply, newTopic: "unrelated" };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildServerHistory,
    scrubPublicPhoneNumbers,
    estimateCloudflareNeurons,
    summarizeGenerationCalls
  };
}
