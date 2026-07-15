import '@carbon/styles/css/styles.css';
import '@carbon/charts/styles.css';
import './style.css';

import {
  LineChart,
  SimpleBarChart,
  DonutChart,
  StackedBarChart,
} from '@carbon/charts';

const ANALYTICS_CONTAINER_ID = 'projecthub-analytics';
const isDevHost = typeof window !== 'undefined' && /projecthub-dev/i.test(window.location.hostname + window.location.pathname);
const API_BASE_URL = isDevHost ? 'https://dev.projecthub-chat.bradleymatera.dev' : 'https://projecthub-chat.bradleymatera.dev';
const API_HEALTH_URL = `${API_BASE_URL}/health`;
const API_THINK_URL = `${API_BASE_URL}/api/think`;
const PROD_API_BASE = 'https://projecthub-chat.bradleymatera.dev';
const DEV_API_BASE = 'https://dev.projecthub-chat.bradleymatera.dev';
const API_COSTS_PROD_URL = `${PROD_API_BASE}/api/costs`;
const API_COSTS_DEV_URL = `${DEV_API_BASE}/api/costs`;
const GITHUB_REPO_API = 'https://api.github.com/repos/BradleyMatera/ProjectHub';
const GITHUB_CONTRIB_API = 'https://api.github.com/repos/BradleyMatera/ProjectHub/contributors';
const REFRESH_INTERVAL_MS = 5000;

function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US').format(Number(n));
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
}

function fmtUptime(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function sanitizeReferrer(url) {
  if (!url || url === 'unknown') return 'unknown';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') || 'unknown';
  } catch {
    return 'unknown';
  }
}

function elapsedTime(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const mins = Math.round(seconds / 60);
  if (mins < 1) return '< 1 min';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs} hr ${rem} min` : `${hrs} hr`;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getTheme(container) {
  return container && container.classList.contains('ph-dark') ? 'g100' : 'white';
}

function setStatus(container, message, type = 'info') {
  const el = container.querySelector('.ph-analytics__status');
  if (!el) return;
  el.className = `ph-analytics__status ph-analytics__status--${type}`;
  el.textContent = message;
  el.hidden = false;
}

function wrapScrollBox(element, maxHeightClass = 'ph-scroll-box') {
  if (!element || !element.firstElementChild) return element;
  const wrapper = document.createElement('div');
  wrapper.className = `ph-scroll-box ${maxHeightClass}`;
  wrapper.appendChild(element.firstElementChild);
  element.appendChild(wrapper);

  const toggle = document.createElement('button');
  toggle.className = 'ph-show-all';
  toggle.type = 'button';
  toggle.textContent = 'Show all';
  toggle.addEventListener('click', () => {
    const isExpanded = wrapper.classList.contains('ph-scroll-box--expanded');
    if (isExpanded) {
      wrapper.classList.remove('ph-scroll-box--expanded');
      wrapper.style.maxHeight = '';
      toggle.textContent = 'Show all';
    } else {
      wrapper.classList.add('ph-scroll-box--expanded');
      wrapper.style.maxHeight = 'none';
      toggle.textContent = 'Show less';
    }
  });
  element.appendChild(toggle);
  return element;
}

function getOpenDetailIndices(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll('details')).map((d, i) => d.open ? i : -1).filter(i => i >= 0);
}

function setOpenDetailIndices(container, indices) {
  if (!container || !indices || indices.length === 0) return;
  const details = container.querySelectorAll('details');
  for (const i of indices) {
    if (details[i]) details[i].open = true;
  }
}

function pauseRefresh(container) {
  const interval = Number(container.dataset.phAnalyticsInterval || '0');
  if (interval) {
    clearInterval(interval);
    container.dataset.phAnalyticsInterval = '';
  }
}

function resumeRefresh(container) {
  pauseRefresh(container);
  const interval = setInterval(() => refresh(container), REFRESH_INTERVAL_MS);
  container.dataset.phAnalyticsInterval = String(interval);
}

function hideStatus(container) {
  const el = container.querySelector('.ph-analytics__status');
  if (el) el.hidden = true;
}

function renderTile(grid, label, value, comparison = '') {
  const tile = document.createElement('div');
  tile.className = 'ph-analytics__tile';
  tile.innerHTML = `
    <div class="ph-analytics__tile-label">${label}</div>
    <div class="ph-analytics__tile-value">${value}</div>
    ${comparison ? `<div class="ph-analytics__tile-comparison">${comparison}</div>` : ''}
  `;
  grid.appendChild(tile);
}

function renderLineChart(holder, data, title, container) {
  try {
    const chartData = data.map(([hour, counts]) => ({
      group: 'Total',
      date: `${hour}:00`,
      value: counts.total || 0,
    }));

    new LineChart(holder, {
      data: chartData,
      options: {
        title,
        axes: {
          bottom: { title: 'Hour', mapsTo: 'date', scaleType: 'labels' },
          left: { title: 'Requests', mapsTo: 'value', scaleType: 'linear' },
        },
        height: '300px',
        width: '100%',
        theme: getTheme(container),
      },
    });
  } catch (e) {
    console.error('Failed to render line chart:', e);
    holder.textContent = 'Chart unavailable';
  }
}

function renderStackedBarChart(holder, data, title, container) {
  try {
    const chartData = data.flatMap(([hour, counts]) => [
      { group: 'Grounded', date: `${hour}:00`, value: counts.grounded || 0 },
      { group: 'LLM', date: `${hour}:00`, value: counts.llm || 0 },
      { group: 'Cached', date: `${hour}:00`, value: counts.cached || 0 },
    ]);

    new StackedBarChart(holder, {
      data: chartData,
      options: {
        title,
        axes: {
          bottom: { title: 'Hour', mapsTo: 'date', scaleType: 'labels' },
          left: { title: 'Requests', mapsTo: 'value', scaleType: 'linear' },
        },
        height: '300px',
        width: '100%',
        theme: getTheme(container),
      },
    });
  } catch (e) {
    console.error('Failed to render stacked bar chart:', e);
    holder.textContent = 'Chart unavailable';
  }
}

function renderBarChart(holder, data, title, container) {
  try {
    const chartData = Object.entries(data)
      .map(([group, value]) => ({ group, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12);

    new SimpleBarChart(holder, {
      data: chartData,
      options: {
        title,
        axes: {
          bottom: { title: 'Count', mapsTo: 'value', scaleType: 'linear' },
          left: { title: 'Category', mapsTo: 'group', scaleType: 'labels' },
        },
        height: '300px',
        width: '100%',
        theme: getTheme(container),
      },
    });
  } catch (e) {
    console.error('Failed to render bar chart:', e);
    holder.textContent = 'Chart unavailable';
  }
}

function renderDonutChart(holder, data, container) {
  try {
    const chartData = [
      { group: 'Grounded / learned', value: (data.groundedCount || 0) + (data.learnedCount || 0) },
      { group: 'LLM', value: data.llmCount || 0 },
      { group: 'Cached', value: data.cachedCount || 0 },
    ];

    new DonutChart(holder, {
      data: chartData,
      options: {
        title: 'Reply source mix',
        resizable: true,
        donut: { center: { label: 'Replies' } },
        height: '300px',
        width: '100%',
        theme: getTheme(container),
      },
    });
  } catch (e) {
    console.error('Failed to render donut chart:', e);
    holder.textContent = 'Chart unavailable';
  }
}

function renderDonutBreakdown(holder, breakdown, title, container) {
  try {
    const chartData = Object.entries(breakdown || {})
      .map(([group, value]) => ({ group, value: Number(value) || 0 }))
      .filter(d => d.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    if (chartData.length === 0) {
      holder.textContent = 'No data';
      return;
    }
    const total = chartData.reduce((s, d) => s + d.value, 0);
    new DonutChart(holder, {
      data: chartData,
      options: {
        title,
        resizable: true,
        donut: { center: { label: String(total) } },
        height: '300px',
        width: '100%',
        theme: getTheme(container),
      },
    });
  } catch (e) {
    console.error('Failed to render donut breakdown chart:', e);
    holder.textContent = 'Chart unavailable';
  }
}

function renderProviderTable(tbody, providers, providerBreakdown) {
  if (!Array.isArray(providers) || providers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6">No provider data</td></tr>';
    return;
  }
  const rows = providers.map((p) => {
    const used = typeof p.usedToday === 'number' ? p.usedToday : '--';
    const limit = p.limit ? formatNumber(p.limit) : '∞';
    const allTime = formatNumber(providerBreakdown?.[p.slug] || 0);
    let statusClass = 'status-online';
    let statusText = 'Active';
    if (!p.enabled) { statusClass = 'status-disabled'; statusText = 'Disabled'; }
    else if (p.exhausted) { statusClass = 'status-cooldown'; statusText = 'Cooldown'; }
    else if (!p.available) { statusClass = 'status-offline'; statusText = 'Unavailable'; }
    return `<tr>
      <td><strong>${p.slug}</strong></td>
      <td>${p.model || '--'}</td>
      <td><span class="ph-status ${statusClass}">${statusText}</span></td>
      <td>${formatNumber(used)}</td>
      <td>${allTime}</td>
      <td>${limit}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = rows;
}

function renderProviderHealth(tbody, providerHealth) {
  if (!providerHealth || Object.keys(providerHealth).length === 0) {
    tbody.innerHTML = '<tr><td colspan="4">No provider health data</td></tr>';
    return;
  }
  const rows = Object.entries(providerHealth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, h]) => {
      const total = (h.successes || 0) + (h.failures || 0);
      const rate = total > 0 ? Math.round((h.successes / total) * 100) : 0;
      let rateClass = 'status-offline';
      if (rate >= 80) rateClass = 'status-online';
      else if (rate >= 50) rateClass = 'status-cooldown';
      return `<tr>
        <td>${slug}</td>
        <td><span class="ph-status ${rateClass}">${rate}%</span></td>
        <td>${formatNumber(h.successes || 0)} ✓ / ${formatNumber(h.failures || 0)} ✗</td>
        <td>${formatNumber(Math.round(h.avgMs || 0))} ms</td>
      </tr>`;
    }).join('');
  tbody.innerHTML = rows;
}

function renderSessionsTable(tbody, sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5">No recent sessions</td></tr>';
    return;
  }
  tbody.innerHTML = sessions.slice(0, 15).map((s) => {
    const topics = Array.isArray(s.topics) ? s.topics.join(', ') : '—';
    const referrer = sanitizeReferrer(s.referrer);
    const providerMix = Object.entries(s.providerMix || {})
      .map(([p, c]) => `${p}:${c}`).join(' ') || '—';
    const fullJson = JSON.stringify({
      id: s.id,
      startedAt: s.startedAt,
      lastActiveAt: s.lastActiveAt,
      durationSec: s.durationSec,
      turns: s.turns,
      intent: s.intent,
      topics: s.topics,
      referrer: s.referrer,
      providerMix: s.providerMix,
      lastQuestion: s.lastQuestion,
      lastReply: s.lastReply,
      lastGroundedReply: s.lastGroundedReply
    }, null, 2);
    return `<tr class="ph-expandable-row">
      <td colspan="5">
        <details>
          <summary>
            <span class="ph-badge ph-badge--${s.intent || 'visitor'}">${s.intent || 'visitor'}</span>
            <span class="ph-muted">${formatTime(s.startedAt)}</span>
            <span class="ph-muted">${formatNumber(s.turns)} turns</span>
            <span class="ph-muted">${topics}</span>
            <span class="ph-muted">${elapsedTime(s.durationSec)}${referrer !== 'unknown' ? ` · ${referrer}` : ''}</span>
          </summary>
          <div class="ph-expandable-content">
            <div class="ph-field-label">Provider mix</div>
            <div class="ph-field-value">${providerMix}</div>
            <div class="ph-field-label">Last question</div>
            <div class="ph-field-value">${s.lastQuestion || '—'}</div>
            <div class="ph-field-label">Full session record</div>
            <pre>${escapeHtml(fullJson)}</pre>
          </div>
        </details>
      </td>
    </tr>`;
  }).join('');
}

function renderRecentRequests(container, requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    container.innerHTML = '<p>No requests yet.</p>';
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'ph-activity-list';
  wrapper.innerHTML = requests.slice(0, 20).map((r) => {
    const providerClass = `ph-provider-${r.provider || 'llm'}`;
    const topicTag = r.topic ? ` <span class="ph-muted">[${r.topic}]</span>` : '';
    const latencyTag = r.latencyMs != null ? ` <span class="ph-muted">${r.latencyMs}ms</span>` : '';
    const referrer = r.referrer && r.referrer !== 'unknown' ? ` <span class="ph-muted">from ${sanitizeReferrer(r.referrer)}</span>` : '';
    const fullJson = JSON.stringify({
      q: r.q,
      provider: r.provider,
      ts: r.ts,
      referrer: r.referrer,
      topic: r.topic,
      latencyMs: r.latencyMs,
      pipeline: r.pipeline,
      reply: r.reply,
      groundedReply: r.groundedReply
    }, null, 2);
    const sanitizedQ = String(r.q || '').replace(/\b\w{2,}@\w+\.\w+\b/g, '[email]').slice(0, 120);
    return `<details class="ph-expandable-row">
      <summary>
        <span class="ph-provider-tag ${providerClass}">${r.provider}</span>
        <span class="ph-muted">${formatTime(r.ts)}</span>${latencyTag}${topicTag}${referrer}
      </summary>
      <div class="ph-expandable-content">
        <div class="ph-field-label">Question</div>
        <div class="ph-field-value">${escapeHtml(sanitizedQ)}${(r.q || '').length > 120 ? '…' : ''}</div>
        <div class="ph-field-label">Reply</div>
        <div class="ph-field-value">${escapeHtml(r.reply || '—').slice(0, 300)}${(r.reply || '').length > 300 ? '…' : ''}</div>
        <div class="ph-field-label">Full request record</div>
        <pre>${escapeHtml(fullJson)}</pre>
      </div>
    </details>`;
  }).join('');
  container.innerHTML = '';
  container.appendChild(wrapper);
}

function renderActivityFeed(container, requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    container.innerHTML = '<p>No activity yet.</p>';
    return;
  }
  const list = document.createElement('div');
  list.className = 'ph-activity-list';
  list.innerHTML = requests.slice(0, 15).map((r) => {
    const providerClass = `ph-provider-${r.provider || 'llm'}`;
    const pipe = Array.isArray(r.pipeline) && r.pipeline.length > 0
      ? `<div class="ph-pipeline">${r.pipeline.join(' → ')}</div>`
      : '';
    return `<div class="ph-activity-item">
      <span class="ph-provider-tag ${providerClass}">${r.provider}</span>
      <span class="ph-muted">${formatTime(r.ts)}</span>
      ${pipe}
    </div>`;
  }).join('');
  container.innerHTML = '';
  container.appendChild(list);
}

function renderPipeline(container, pipeline) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    container.innerHTML = '<p>No requests yet.</p>';
    return;
  }
  container.innerHTML = pipeline.map((step, i) => {
    const isSuccess = /success|hit|shaped/.test(step);
    const isFail = /fail|error|unavailable/.test(step);
    const stepClass = isSuccess ? 'ph-pipeline-step--success' : isFail ? 'ph-pipeline-step--fail' : 'ph-pipeline-step--info';
    const arrow = i < pipeline.length - 1 ? '<span class="ph-pipeline-arrow">→</span>' : '';
    return `<span class="ph-pipeline-step ${stepClass}">${step}</span>${arrow}`;
  }).join('');
}

function renderBarList(container, data, options = {}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    container.innerHTML = `<p>${options.emptyText || 'No data'}</p>`;
    return;
  }
  const maxCount = entries[0][1];
  const highlight = options.highlight || (() => false);
  const list = document.createElement('div');
  list.className = 'ph-bar-list';
  list.innerHTML = entries.slice(0, options.limit || 12).map(([key, count]) => {
    const pct = Math.round((count / maxCount) * 100);
    const isHighlighted = highlight(key);
    return `<div class="ph-bar-row ${isHighlighted ? 'ph-bar-row--highlight' : ''}">
      <div class="ph-bar-label">
        <span class="ph-bar-key">${key}</span>
        <span class="ph-bar-count">${formatNumber(count)}</span>
      </div>
      <div class="ph-bar-track"><div class="ph-bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
  container.innerHTML = '';
  container.appendChild(list);
}

function renderKnowledgeGaps(container, data) {
  const recent = data.recentRequests || [];
  const learn = data.learning || {};
  const stashedCount = learn.stashedCount || 0;
  const uncategorized = recent.filter(r => r.topic === 'uncategorized' || r.topic === 'other').slice(0, 8);

  // Cluster uncategorized question stems to show which new topics might be needed.
  const stemCounts = {};
  for (const r of recent.filter(r => r.topic === 'uncategorized' || r.topic === 'other')) {
    const q = String(r.q || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    const words = q.split(/\s+/).filter(w => w.length > 3 && !/brad|matera|about|what|does|know|tell|please|would|could|should|does|is|are|can|will|have|has|had|do|did/.test(w));
    const stem = words.slice(0, 2).sort().join(' ');
    if (stem) stemCounts[stem] = (stemCounts[stem] || 0) + 1;
  }
  const topStems = Object.entries(stemCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  if (uncategorized.length === 0 && stashedCount === 0 && topStems.length === 0) {
    container.innerHTML = '<p>No gaps detected yet.</p>';
    return;
  }

  let html = '';
  if (stashedCount > 0) {
    html += `<div class="ph-alert ph-alert--warning">
      <strong>${formatNumber(stashedCount)} stashed question(s)</strong>
      <span class="ph-muted">— think mode will process these</span>
    </div>`;
  }
  if (topStems.length > 0) {
    html += '<p class="ph-muted">Top uncategorized question stems — add a topic regex if any become frequent:</p>';
    html += '<div class="ph-bar-list">' + topStems.map(([stem, count]) => `
      <div class="ph-bar-row">
        <div class="ph-bar-label">
          <span class="ph-bar-key">${escapeHtml(stem)}</span>
          <span class="ph-bar-count">${formatNumber(count)}</span>
        </div>
        <div class="ph-bar-track"><div class="ph-bar-fill" style="width:${Math.min(100, Math.round((count / topStems[0][1]) * 100))}%"></div></div>
      </div>
    `).join('') + '</div>';
  }
  if (uncategorized.length > 0) {
    html += '<p class="ph-muted">Recent uncategorized questions:</p>';
    html += '<div class="ph-activity-list">' + uncategorized.map(r => {
      const sanitizedQ = String(r.q || '').replace(/\b\w{2,}@\w+\.\w+\b/g, '[email]').slice(0, 80);
      return `<div class="ph-activity-item">
        <span class="ph-muted">${formatTime(r.ts)}</span>
        <span class="ph-provider-tag ph-provider-out-of-scope">[${r.topic === 'other' ? 'uncategorized' : r.topic}]</span>
        <span class="ph-muted">${escapeHtml(sanitizedQ)}${(r.q || '').length > 80 ? '…' : ''}</span>
      </div>`;
    }).join('') + '</div>';
  }
  container.innerHTML = html;
}

function renderLearningSystem(container, data) {
  const learn = data.learning || {};
  const avgScore = learn.avgLearnedScore || 0;
  const avgGrounded = learn.avgGroundedScore || 0;
  const improvement = avgGrounded > 0 ? Math.round(((avgScore - avgGrounded) / avgGrounded) * 100) : 0;
  const nextThinkIn = learn.nextThinkIn || 0;
  const pipeline = learn.learningPipeline || {};
  const judgments = learn.judgmentHistory || [];

  const grid = document.createElement('div');
  grid.className = 'ph-learning-grid';
  grid.innerHTML = `
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">Stashed questions</div>
      <div class="ph-analytics__tile-value">${formatNumber(learn.stashedCount)}</div>
      <div class="ph-muted">Unanswered, pending think mode</div>
    </div>
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">Learned answers</div>
      <div class="ph-analytics__tile-value">${formatNumber(learn.learnedCount)}</div>
      <div class="ph-muted">${formatNumber(learn.pendingLearned || 0)} pending push to GitHub</div>
    </div>
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">Think mode status</div>
      <div class="ph-analytics__tile-value" style="font-size:1.5rem">${learn.thinkRunning ? 'Running…' : 'Idle'}</div>
      <div class="ph-muted">${learn.lastThinkAt ? 'Last run: ' + formatTime(learn.lastThinkAt) : 'Last run: never'}</div>
    </div>
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">GitHub sync</div>
      <div class="ph-analytics__tile-value" style="font-size:1.5rem">${learn.hasGitHubToken ? 'Connected' : 'No token'}</div>
      <div class="ph-muted">Pushes learned answers to knowledge JSON</div>
    </div>
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">Avg learned score</div>
      <div class="ph-analytics__tile-value" style="font-size:1.5rem">${avgScore > 0 ? avgScore + '/100' : '--'}</div>
      <div class="ph-muted">Quality of LLM-learned answers</div>
    </div>
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">Avg grounded score</div>
      <div class="ph-analytics__tile-value" style="font-size:1.5rem">${avgGrounded > 0 ? avgGrounded + '/100' : '--'}</div>
      <div class="ph-muted">Quality of deterministic answers</div>
    </div>
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">Improvement</div>
      <div class="ph-analytics__tile-value ${improvement > 0 ? 'ph-text-success' : improvement < 0 ? 'ph-text-error' : ''}" style="font-size:1.5rem">${avgScore > 0 && avgGrounded > 0 ? (improvement >= 0 ? '+' : '') + improvement + '%' : '--'}</div>
      <div class="ph-muted">${avgScore > 0 && avgGrounded > 0 ? (improvement > 0 ? 'Learned answers are better' : improvement < 0 ? 'Learned answers are worse — tuning needed' : 'No improvement yet') : 'No learned answers to compare yet'}</div>
    </div>
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">Next think run</div>
      <div class="ph-analytics__tile-value" style="font-size:1.5rem">${nextThinkIn > 0 ? Math.ceil(nextThinkIn / 1000) + 's' : 'Due now'}</div>
      <div class="ph-muted">Auto-triggers when providers recover</div>
    </div>
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">Semantic cache</div>
      <div class="ph-analytics__tile-value">${formatNumber(learn.semanticCacheSize)}</div>
      <div class="ph-muted">Paraphrase dedup (≥0.92 similarity)</div>
    </div>
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">Stance tracking</div>
      <div class="ph-analytics__tile-value">${formatNumber(learn.stanceStoreSize)}</div>
      <div class="ph-muted">Sessions with consistency context</div>
    </div>
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">Retrieval mode</div>
      <div class="ph-analytics__tile-value" style="font-size:1.5rem">${learn.retrievalMode || 'bm25'}</div>
      <div class="ph-muted">${formatNumber(learn.bm25Chunks || 0)} chunks · ${learn.vectorIndexLoaded ? 'vectors loaded' : 'no vectors'}</div>
    </div>
    <div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">Providers recovered</div>
      <div class="ph-analytics__tile-value">${formatNumber((learn.providersRecentlyRecovered || []).length)}</div>
      <div class="ph-muted">Recently back online</div>
    </div>
  `;
  container.innerHTML = '';
  container.appendChild(grid);

  const pipelineDiv = document.createElement('div');
  pipelineDiv.className = 'ph-pipeline-counts';
  pipelineDiv.style.marginTop = '1rem';
  pipelineDiv.innerHTML = `
    <div class="ph-pipeline-count">
      <span class="ph-pipeline-count-value">${formatNumber(pipeline.stashed || learn.stashedCount || 0)}</span>
      <span class="ph-pipeline-count-label">Stashed</span>
    </div>
    <div class="ph-pipeline-count">
      <span class="ph-pipeline-count-value">${formatNumber(pipeline.scored || 0)}</span>
      <span class="ph-pipeline-count-label">Scored</span>
    </div>
    <div class="ph-pipeline-count">
      <span class="ph-pipeline-count-value">${formatNumber(pipeline.promoted || learn.pendingLearned || 0)}</span>
      <span class="ph-pipeline-count-label">Promoted</span>
    </div>
    <div class="ph-pipeline-count">
      <span class="ph-pipeline-count-value">${formatNumber(pipeline.pushed || 0)}</span>
      <span class="ph-pipeline-count-label">Pushed to GitHub</span>
    </div>
  `;
  container.appendChild(pipelineDiv);

  if (judgments.length > 0) {
    const verdictClass = v => v === 'learned_wins' ? 'ph-text-success' : v === 'grounded_wins' ? 'ph-text-error' : 'ph-muted';
    const table = document.createElement('div');
    table.className = 'ph-analytics__table-wrap';
    table.innerHTML = `
      <p class="ph-muted" style="padding:0.75rem 1rem 0">Recent evaluations (LLM-as-judge)</p>
      <table class="ph-analytics__table">
        <thead>
          <tr><th>Question</th><th>Verdict</th><th>F / R / H / S</th><th>Reason</th></tr>
        </thead>
        <tbody>
          ${judgments.slice(0, 10).map(j => {
            const q = escapeHtml(String(j.q || '').slice(0, 40));
            const verdict = j.verdict || 'pending';
            const scores = [j.faithfulness, j.relevance, j.helpfulness, j.safety].map(n => n == null ? '—' : n).join(' / ');
            return `<tr>
              <td>${q}${(j.q || '').length > 40 ? '…' : ''}</td>
              <td class="${verdictClass(verdict)}">${verdict}</td>
              <td>${scores}</td>
              <td>${escapeHtml(j.reason || '—').slice(0, 80)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
    container.appendChild(table);
  } else {
    const empty = document.createElement('p');
    empty.className = 'ph-muted';
    empty.style.marginTop = '1rem';
    empty.textContent = 'No judge evaluations yet — think mode will record verdicts here.';
    container.appendChild(empty);
  }
}

function renderRetrievalDebugger(container) {
  container.hidden = false;
  container.innerHTML = `
    <h3 class="ph-analytics__section-title">Retrieval debugger</h3>
    <p class="ph-muted">Test the retrieval pipeline: query understanding, BM25, dense, and hybrid fusion results.</p>
    <div style="display:flex;gap:0.5rem;margin:0.75rem 0">
      <input class="cds--text-input" id="ph-retrieve-input" type="text" placeholder="e.g. what is his tech stack" style="flex:1" />
      <button class="cds--btn cds--btn--primary" id="ph-retrieve-btn" type="button">Retrieve</button>
    </div>
    <div class="ph-retrieve-results" style="margin-top:0.75rem"></div>
  `;

  const input = container.querySelector('#ph-retrieve-input');
  const btn = container.querySelector('#ph-retrieve-btn');
  const results = container.querySelector('.ph-retrieve-results');

  async function runRetrieve() {
    const q = (input.value || '').trim();
    if (!q) return;
    btn.disabled = true;
    results.innerHTML = '<p class="ph-muted">Loading…</p>';
    try {
      const url = `${API_BASE_URL}/api/retrieve?q=${encodeURIComponent(q)}`;
      const data = await fetchJson(url);
      results.innerHTML = renderRetrieveResults(data);
    } catch (e) {
      results.innerHTML = `<p class="ph-text-error">Error: ${escapeHtml(e.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', runRetrieve);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') runRetrieve(); });
}

function renderRetrieveResults(data) {
  const renderChunkList = (label, chunks, color) => {
    if (!chunks || chunks.length === 0) return `<p class="ph-muted" style="padding-left:1rem">${label}: <em>none</em></p>`;
    return `<p class="ph-muted" style="padding-left:1rem">${label}:</p>` + chunks.slice(0, 4).map(c => {
      const tag = escapeHtml(c.tag || '');
      const score = c.score != null ? c.score.toFixed(2) : '';
      const text = escapeHtml(String(c.text || '').slice(0, 120));
      return `<div style="padding:0.25rem 0 0.25rem 2rem;border-left:3px solid ${color};margin-left:1rem">
        <span class="ph-muted" style="font-size:0.75rem">${tag} · ${score}</span><br>${text}${(c.text || '').length > 120 ? '…' : ''}
      </div>`;
    }).join('');
  };

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.75rem">
      <div><span class="ph-muted">Rewritten:</span> ${escapeHtml(data.rewritten || data.query || '—')}</div>
      <div><span class="ph-muted">Intent:</span> ${escapeHtml(data.intent || '—')}</div>
      <div><span class="ph-muted">Normalized:</span> ${escapeHtml(data.normalized || '—')}</div>
      <div><span class="ph-muted">Query:</span> ${escapeHtml(data.query || '—')}</div>
    </div>
    ${renderChunkList('BM25', data.bm25, '#697077')}
    ${renderChunkList('Dense', data.dense, '#78a9ff')}
    ${renderChunkList('Fused (RRF+MMR)', data.fused, '#42be65')}
    ${renderChunkList('Legacy', data.legacy, '#a8a8a8')}
  `;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function loadData() {
  // Full mode (dev site): pull everything from every source — both backends'
  // health and cost ledgers plus GitHub. Showcase mode (prod site): only the
  // local backend's health, GitHub, and the production cost tracker.
  const requests = [
    fetchJson(API_HEALTH_URL, { cache: 'no-store' }),
    fetchJson(GITHUB_REPO_API),
    fetchJson(GITHUB_CONTRIB_API),
    fetchJson(API_COSTS_PROD_URL, { cache: 'no-store' }),
    isDevHost ? fetchJson(API_COSTS_DEV_URL, { cache: 'no-store' }) : Promise.reject(new Error('showcase mode')),
    isDevHost ? fetchJson(`${PROD_API_BASE}/health`, { cache: 'no-store' }) : Promise.reject(new Error('showcase mode')),
  ];
  const [health, repo, contributors, costsProd, costsDev, healthProd] = await Promise.allSettled(requests);

  return {
    health: health.status === 'fulfilled' ? health.value : null,
    repo: repo.status === 'fulfilled' ? repo.value : null,
    contributors: contributors.status === 'fulfilled' ? contributors.value : null,
    // Cost trackers for BOTH environments. Each endpoint only exists when
    // COST_TRACKER=true on that backend; an offline backend hides its card.
    costsProd: costsProd.status === 'fulfilled' && costsProd.value?.ok ? costsProd.value : null,
    costsDev: costsDev.status === 'fulfilled' && costsDev.value?.ok ? costsDev.value : null,
    // Production backend health, fetched separately on the dev site so the
    // Environments section can compare both stacks side by side.
    healthProd: healthProd.status === 'fulfilled' ? healthProd.value : null,
    errors: [
      health.status === 'rejected' ? `Health: ${health.reason.message}` : null,
      repo.status === 'rejected' ? `GitHub repo: ${repo.reason.message}` : null,
      contributors.status === 'rejected' ? `Contributors: ${contributors.reason.message}` : null,
    ].filter(Boolean),
  };
}

function renderEnvironmentsSection(section, devHealth, prodHealth) {
  const envTile = (label, base, h) => {
    if (!h) {
      return `<div class="ph-learning-tile">
        <div class="ph-analytics__tile-label">${label}</div>
        <div class="ph-analytics__tile-value"><span class="ph-status ph-status--error">OFFLINE</span></div>
        <div class="ph-muted">${base}</div>
      </div>`;
    }
    return `<div class="ph-learning-tile">
      <div class="ph-analytics__tile-label">${label}</div>
      <div class="ph-analytics__tile-value"><span class="ph-status ph-status--ok">${(h.status || 'online').toUpperCase()}</span></div>
      <div class="ph-muted">${base}</div>
      <div class="ph-muted">Uptime: ${fmtUptime(h.uptimeSeconds)} · All-time requests: ${formatNumber(h.allTimeRequests)}</div>
      <div class="ph-muted">Today: grounded ${formatNumber(h.groundedCount)} · LLM ${formatNumber(h.llmCount)} · cached ${formatNumber(h.cachedCount)}</div>
      <div class="ph-muted">Last provider: ${h.lastReplyProvider || '—'} · Deploys: ${formatNumber(h.deployCount)}</div>
    </div>`;
  };
  section.innerHTML = `
    <h3 class="ph-analytics__section-title">Environments — all stacks at a glance</h3>
    <p class="ph-muted">ProjectHub runs two isolated stacks: <strong>Production</strong> (master branch, main GitHub Pages, prod GCP VM) serves real visitors; <strong>Dev / Staging</strong> (develop branch, this site, dev GCP VM) is where every change is validated first. Each stack has its own knowledge state, stats, learned answers, and cost ledger.</p>
    <div class="ph-learning-grid">
      ${envTile('Production backend', PROD_API_BASE, prodHealth)}
      ${envTile('Dev / Staging backend', DEV_API_BASE, devHealth)}
    </div>`;
}

function costFmtBytes(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n || 0) + ' B';
}

function renderCostSection(section, costs, label, apiBase) {
  if (!costs) {
    section.hidden = false;
    section.innerHTML = `
      <h3 class="ph-analytics__section-title">Cost &amp; free-tier tracker — ${label}</h3>
      <p class="ph-muted">Tracker offline or unreachable at <code>${apiBase}/api/costs</code>. If the backend is up, ensure COST_TRACKER=true in its .env.</p>`;
    return;
  }
  section.hidden = false;
  const freeBadge = costs.free
    ? '<span class="ph-status ph-status--ok">100% FREE — all usage inside free tiers</span>'
    : '<span class="ph-status ph-status--error">FREE-TIER LIMIT EXCEEDED</span>';

  const hero = `
    <div class="ph-learning-grid">
      <div class="ph-learning-tile">
        <div class="ph-analytics__tile-label">Actual cost this month</div>
        <div class="ph-analytics__tile-value">${costs.shadowCost?.actualUsd === null ? 'REVIEW' : '$' + (costs.shadowCost?.actualUsd || '0.000000')}</div>
        <div class="ph-muted">${freeBadge}</div>
      </div>
      <div class="ph-learning-tile">
        <div class="ph-analytics__tile-label">Shadow cost if paid (month)</div>
        <div class="ph-analytics__tile-value">$${costs.shadowCost?.monthUsd || '0.000000'}</div>
        <div class="ph-muted">micro-USD precision: ${formatNumber(costs.shadowCost?.monthMicroUsd || 0)} µ$</div>
      </div>
      <div class="ph-learning-tile">
        <div class="ph-analytics__tile-label">Shadow cost today</div>
        <div class="ph-analytics__tile-value">$${((costs.shadowCost?.dayMicroUsd || 0) / 1e6).toFixed(6)}</div>
        <div class="ph-muted">Registry v${costs.registryVersion} · verified ${costs.registryLastVerified}</div>
      </div>
    </div>`;

  const gauges = (costs.headroom || []).map(h => {
    const pct = Math.min(100, h.pct);
    const barClass = h.pct >= 80 ? 'ph-bar-fill--error' : h.pct >= 50 ? 'ph-bar-fill--warn' : '';
    const usedStr = h.metric.includes('Bytes') ? costFmtBytes(h.used) : formatNumber(h.used);
    const limitStr = h.metric.includes('Bytes') ? costFmtBytes(h.limit) : formatNumber(h.limit);
    return `<div class="ph-bar-row">
      <div class="ph-bar-label" title="${h.source} ${h.metric}">${h.source} · ${h.metric}${h.estimated ? ' (est)' : ''}</div>
      <div class="ph-bar-count">${usedStr} / ${limitStr} (${h.pct}%)</div>
      <div class="ph-bar-track"><div class="ph-bar-fill ${barClass}" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');

  const insights = (costs.insights || []).map(i => {
    const cls = i.severity === 2 ? 'ph-text-error' : i.severity === 1 ? 'ph-text-warn' : 'ph-text-success';
    return `<li class="${cls}">${i.text}</li>`;
  }).join('');

  const sources = Object.entries(costs.bySourceMonth || {}).map(([source, a]) => `
    <tr>
      <td><strong>${source}</strong></td>
      <td>${formatNumber(a.calls)}</td>
      <td>${formatNumber(a.tokensIn)} / ${formatNumber(a.tokensOut)}</td>
      <td>${formatNumber(a.neurons)}</td>
      <td>${costFmtBytes(a.bytes)}</td>
      <td>$${(a.shadowMicroUsd / 1e6).toFixed(6)}${a.estimated ? ' (est)' : ''}</td>
    </tr>`).join('');

  const caveats = (costs.caveats || []).map(c => `<li>${c}</li>`).join('');

  section.innerHTML = `
    <h3 class="ph-analytics__section-title">Cost &amp; free-tier tracker — ${label}</h3>
    <p class="ph-muted">Every metered event down to integer micro-USD, live from <code>${apiBase}</code>. Proof the stack is actually free.</p>
    ${hero}
    <h4 class="ph-analytics__section-title" style="margin-top:1rem">Free-tier headroom</h4>
    <div class="ph-bar-list">${gauges || '<p class="ph-muted">No metered usage yet.</p>'}</div>
    <h4 class="ph-analytics__section-title" style="margin-top:1rem">Insights &amp; forecasts</h4>
    <ul class="ph-cost-insights">${insights || '<li class="ph-muted">Collecting data…</li>'}</ul>
    <div class="ph-analytics__table-wrap" style="margin-top:1rem">
      <table class="ph-analytics__table">
        <thead><tr><th>Source</th><th>Calls</th><th>Tokens in/out</th><th>Neurons</th><th>Bytes</th><th>Shadow $ (month)</th></tr></thead>
        <tbody>${sources || '<tr><td colspan="6">No usage this month yet</td></tr>'}</tbody>
      </table>
    </div>
    <details style="margin-top:0.75rem"><summary class="ph-muted">Measurement caveats</summary><ul class="ph-muted">${caveats}</ul></details>
  `;
}

function render(container, data) {
  const grid = container.querySelector('.ph-analytics__grid');
  const charts = container.querySelector('.ph-analytics__charts');
  const meta = container.querySelector('.ph-analytics__meta');
  const providerTableBody = container.querySelector('.ph-analytics__provider-table tbody');
  const providerHealthBody = container.querySelector('.ph-analytics__provider-health-table tbody');
  const sessionsTableBody = container.querySelector('.ph-analytics__sessions-table tbody');

  if (grid) grid.innerHTML = '';
  if (charts) charts.innerHTML = '';
  if (meta) meta.innerHTML = '';
  if (providerTableBody) providerTableBody.innerHTML = '';
  if (providerHealthBody) providerHealthBody.innerHTML = '';
  if (sessionsTableBody) sessionsTableBody.innerHTML = '';

  const { health, repo, contributors, errors } = data;

  hideStatus(container);
  if (errors.length > 0) {
    setStatus(container, `Some data sources failed: ${errors.join('; ')}`, 'error');
  }

  if (!health && !repo) {
    setStatus(container, 'Unable to load analytics data.', 'error');
    return;
  }

  if (health) {
    const status = health.ok ? 'Online' : 'Issue';
    renderTile(grid, 'API status', status, `Uptime: ${fmtUptime(health.uptimeSeconds)}`);
    renderTile(grid, 'Requests this restart', formatNumber(health.totalRequestsServed), `All-time: ${formatNumber(health.allTimeRequests)}`);
    const g = health.groundedCount || 0;
    const l = health.llmCount || 0;
    const c = health.cachedCount || 0;
    renderTile(grid, 'Answer breakdown', `Grounded ${formatNumber(g)} · LLM ${formatNumber(l)} · Cached ${formatNumber(c)}`);
    renderTile(grid, 'Deploys', formatNumber(health.deployCount), health.firstDeployAt ? `since ${formatDate(health.firstDeployAt).split(',')[0]}` : '');
    renderTile(grid, 'Last provider', health.lastReplyProvider || 'None yet', 'Most recent reply source');
  }

  if (repo) {
    renderTile(grid, 'GitHub stars', formatNumber(repo.stargazers_count));
    renderTile(grid, 'GitHub forks', formatNumber(repo.forks_count));
    renderTile(grid, 'Open issues', formatNumber(repo.open_issues_count));
  }

  if (contributors) {
    renderTile(grid, 'Watchers', formatNumber(repo.watchers_count));
    renderTile(grid, 'Contributors', formatNumber(contributors.length));
  }

  if (providerTableBody && health) {
    renderProviderTable(providerTableBody, health.providers, health.providerBreakdown);
  }

  if (providerHealthBody && health) {
    renderProviderHealth(providerHealthBody, health.providerHealth);
  }

  if (sessionsTableBody && health) {
    const openSessionRows = getOpenDetailIndices(sessionsTableBody);
    renderSessionsTable(sessionsTableBody, health.recentSessions);
    setOpenDetailIndices(sessionsTableBody, openSessionRows);
  }

  const recentContainer = container.querySelector('.ph-analytics__recent-requests');
  if (recentContainer && health) {
    const openRequestRows = getOpenDetailIndices(recentContainer);
    renderRecentRequests(recentContainer, health.recentRequests);
    wrapScrollBox(recentContainer, 'ph-scroll-box--lg');
    setOpenDetailIndices(recentContainer, openRequestRows);
  }

  const activityContainer = container.querySelector('.ph-analytics__activity-feed');
  if (activityContainer && health) {
    renderActivityFeed(activityContainer, health.recentRequests);
    wrapScrollBox(activityContainer, 'ph-scroll-box--sm');
  }
  const pipelineContainer = container.querySelector('.ph-analytics__last-pipeline');
  if (pipelineContainer && health) {
    renderPipeline(pipelineContainer, health.lastPipeline);
  }

  const referrerContainer = container.querySelector('.ph-analytics__referrers');
  if (referrerContainer && health) {
    const sanitized = Object.entries(health.referrerBreakdown || {}).reduce((acc, [url, count]) => {
      const domain = sanitizeReferrer(url);
      acc[domain] = (acc[domain] || 0) + count;
      return acc;
    }, {});
    referrerContainer.innerHTML = '<div class="ph-analytics__referrers-bar"></div><div class="ph-analytics__referrers-chart"></div>';
    const barHolder = referrerContainer.querySelector('.ph-analytics__referrers-bar');
    const chartHolder = referrerContainer.querySelector('.ph-analytics__referrers-chart');
    renderBarList(barHolder, sanitized, { emptyText: 'No referrer data yet', limit: 10 });
    if (Object.keys(sanitized).length > 0) {
      renderDonutBreakdown(chartHolder, sanitized, 'Visitors by referrer', container);
    }
  }

  const topicContainer = container.querySelector('.ph-analytics__topics');
  if (topicContainer && health) {
    const allTopics = Object.values(health.topicBreakdown || {}).reduce((acc, day) => {
      Object.entries(day).forEach(([topic, count]) => {
        acc[topic] = (acc[topic] || 0) + count;
      });
      return acc;
    }, {});
    renderBarList(topicContainer, allTopics, { emptyText: 'No topic data yet', highlight: k => k === 'uncategorized' || k === 'out-of-scope' });
  }

  const gapsContainer = container.querySelector('.ph-analytics__gaps');
  if (gapsContainer && health) {
    renderKnowledgeGaps(gapsContainer, health);
  }

  const learningContainer = container.querySelector('.ph-analytics__learning');
  if (learningContainer && health) {
    renderLearningSystem(learningContainer, health);
  }

  const retrievalDebug = container.querySelector('.ph-analytics__retrieval-debug');
  if (retrievalDebug && isDevHost) {
    renderRetrievalDebugger(retrievalDebug);
  }

  const costProdSection = container.querySelector('.ph-analytics__costs-prod');
  if (costProdSection) {
    renderCostSection(costProdSection, data.costsProd, 'Production', PROD_API_BASE);
  }
  const costDevSection = container.querySelector('.ph-analytics__costs-dev');
  if (costDevSection) {
    renderCostSection(costDevSection, data.costsDev, 'Dev / Staging', DEV_API_BASE);
  }
  const envSection = container.querySelector('.ph-analytics__environments');
  if (envSection) {
    renderEnvironmentsSection(envSection, isDevHost ? health : null, data.healthProd);
  }

  if (meta && health) {
    meta.innerHTML = `
      <p><strong>Service:</strong> ${health.service || 'ProjectHub Chat API'}</p>
      <p><strong>Status:</strong> ${health.status || 'unknown'}</p>
      <p><strong>Deployed:</strong> ${formatDate(health.deployedAt)}</p>
      <p><strong>Uptime:</strong> ${fmtUptime(health.uptimeSeconds)}</p>
      <p><strong>Mode:</strong> ${health.mode || '—'}</p>
      <p><strong>Updated:</strong> ${new Date().toLocaleTimeString()}</p>
    `;
  }

  if (charts && health) {
    if (health.hourlyRequests && Object.keys(health.hourlyRequests).length > 0) {
      const holder = document.createElement('div');
      holder.className = 'ph-analytics__chart';
      charts.appendChild(holder);
      renderStackedBarChart(holder, Object.entries(health.hourlyRequests), 'Request trend (last available hours)', container);
    }

    if (health.providerBreakdown && Object.keys(health.providerBreakdown).length > 0) {
      const holder = document.createElement('div');
      holder.className = 'ph-analytics__chart';
      charts.appendChild(holder);
      renderBarChart(holder, health.providerBreakdown, 'Requests by provider', container);
    }

    const allTopics = Object.values(health.topicBreakdown || {}).reduce((acc, day) => {
      Object.entries(day).forEach(([topic, count]) => {
        acc[topic] = (acc[topic] || 0) + count;
      });
      return acc;
    }, {});
    if (Object.keys(allTopics).length > 0) {
      const holder = document.createElement('div');
      holder.className = 'ph-analytics__chart';
      charts.appendChild(holder);
      renderBarChart(holder, allTopics, 'Questions by topic', container);
    }

    const holder = document.createElement('div');
    holder.className = 'ph-analytics__chart';
    charts.appendChild(holder);
    renderDonutChart(holder, health, container);
  }
}

async function refresh(container) {
  try {
    const data = await loadData();
    render(container, data);
  } catch (err) {
    console.error(err);
    setStatus(container, `Analytics failed to load: ${err.message}`, 'error');
  }
}

export function mount(selector) {
  const container = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (!container) {
    console.error('Analytics container not found:', selector);
    return;
  }

  const headerHtml = `
    <div class="ph-analytics__status ph-analytics__status--loading" role="status" aria-live="polite">
      Loading live analytics…
    </div>
    <div class="ph-analytics__header">
      <div>
        <h2 class="ph-analytics__title">${isDevHost ? 'ProjectHub full analytics (dev)' : 'ProjectHub live analytics'}</h2>
        <p class="ph-analytics__subtitle">${isDevHost
          ? 'Complete operational view: every metric from every source — both backends, both cost ledgers, GitHub — refreshed every 5 seconds'
          : 'Live highlights from the production backend, refreshed every 5 seconds'}</p>
      </div>
      <div class="ph-analytics__controls">
        <button class="cds--btn cds--btn--secondary" id="ph-analytics-pause" type="button">Pause updates</button>
        <button class="cds--btn cds--btn--primary" id="ph-analytics-refresh" type="button">Refresh now</button>
        <button class="cds--btn cds--btn--ghost" id="ph-analytics-theme" type="button">Toggle theme</button>
        <span class="ph-analytics__updated" id="ph-analytics-updated"></span>
      </div>
    </div>

    <div class="ph-analytics__grid"></div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Provider status</h3>
      ${isDevHost ? '<p class="ph-muted">Scout routes each open-ended question through this free-tier LLM network in priority order. "Used today" counts against each provider\'s self-imposed daily budget; when one is exhausted the router falls through to the next.</p>' : ''}
      <div class="ph-analytics__table-wrap">
        <table class="ph-analytics__table ph-analytics__provider-table" aria-label="Provider status">
          <thead>
            <tr><th>Provider</th><th>Model</th><th>Status</th><th>Used today</th><th>All-time</th><th>Daily limit</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Trends & breakdowns</h3>
      ${isDevHost ? '<p class="ph-muted">Hourly request volume and provider mix. Grounded answers come straight from the knowledge base; LLM answers passed validation; cached answers were served from the semantic cache.</p>' : ''}
      <div class="ph-analytics__charts"></div>
    </div>`;

  const fullOnlyHtml = `
    <div class="ph-analytics__section ph-analytics__environments"></div>

    <div class="ph-analytics__two-col">
      <div class="ph-analytics__section">
        <h3 class="ph-analytics__section-title">Live activity feed</h3>
        <p class="ph-muted">Rolling stream of the latest chat requests handled by this backend.</p>
        <div class="ph-analytics__activity-feed"></div>
      </div>
      <div class="ph-analytics__section">
        <h3 class="ph-analytics__section-title">Last request pipeline</h3>
        <p class="ph-muted">How the most recent question moved through the answer pipeline: grounding, provider routing, validation, and final source.</p>
        <div class="ph-analytics__last-pipeline"></div>
      </div>
    </div>

    <div class="ph-analytics__two-col">
      <div class="ph-analytics__section">
        <h3 class="ph-analytics__section-title">Where visitors come from</h3>
        <p class="ph-muted">Referrer breakdown across all embeds of the widget (GitHub Pages, bradleymatera.dev, CodePen).</p>
        <div class="ph-analytics__referrers"></div>
      </div>
      <div class="ph-analytics__section">
        <h3 class="ph-analytics__section-title">What recruiters ask about</h3>
        <p class="ph-muted">Question topics classified by the intent engine. "Out-of-scope" and "uncategorized" are highlighted because they feed the knowledge-gap list below.</p>
        <div class="ph-analytics__topics"></div>
      </div>
    </div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Knowledge coverage gaps</h3>
      <p class="ph-muted">Questions Scout could not answer well from verified facts. These are the raw inputs to Think Mode's self-improvement loop.</p>
      <div class="ph-analytics__gaps"></div>
    </div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Provider health history</h3>
      <p class="ph-muted">Success rate and latency per provider since the last deploy. A failing provider is skipped automatically by the router.</p>
      <div class="ph-analytics__table-wrap">
        <table class="ph-analytics__table ph-analytics__provider-health-table" aria-label="Provider health history">
          <thead>
            <tr><th>Provider</th><th>Success rate</th><th>Success / Fail</th><th>Avg latency</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Recent sessions</h3>
      <p class="ph-muted">Conversation-level view: each row is one visitor session with its inferred intent, turn count, and topics discussed.</p>
      <div class="ph-analytics__table-wrap">
        <table class="ph-analytics__table ph-analytics__sessions-table" aria-label="Recent sessions">
          <thead>
            <tr><th>Intent</th><th>Started</th><th>Turns</th><th>Topics</th><th>Duration / Referrer</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Recent requests</h3>
      <p class="ph-muted">Each row shows provider, time, topic, and referrer. Click a row to expand the full request record, including the sanitized question and reply preview.</p>
      <div class="ph-analytics__recent-requests"></div>
    </div>

    <div class="ph-analytics__section">
      <div class="ph-analytics__header" style="margin-bottom:0.5rem">
        <h3 class="ph-analytics__section-title">Learning system (Scout think mode)</h3>
        <button class="cds--btn cds--btn--secondary" id="ph-analytics-think" type="button">Run Think Mode now</button>
      </div>
      <p class="ph-muted">Uses LLM-as-judge: every promoted answer must beat the grounded baseline on faithfulness, relevance, helpfulness, and safety.</p>
      <div class="ph-analytics__learning"></div>
    </div>

    <div class="ph-analytics__section ph-analytics__retrieval-debug" hidden></div>

    <div class="ph-analytics__section ph-analytics__costs-prod" hidden></div>

    <div class="ph-analytics__section ph-analytics__costs-dev" hidden></div>`;

  const showcaseOnlyHtml = `
    <div class="ph-analytics__section ph-analytics__costs-prod" hidden></div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Want the full picture?</h3>
      <p class="ph-muted">The <a href="https://bradleymatera.github.io/ProjectHub-dev/" target="_blank" rel="noopener noreferrer">development site</a> shows the complete operational dashboard: both environments, live activity, session analytics, knowledge gaps, the Think Mode learning system, and per-event cost ledgers for every stack.</p>
    </div>`;

  const footerHtml = `
    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Service metadata</h3>
      <div class="ph-analytics__meta"></div>
    </div>
  `;

  container.innerHTML = headerHtml + (isDevHost ? fullOnlyHtml : showcaseOnlyHtml) + footerHtml;

  const refreshBtn = container.querySelector('#ph-analytics-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => refresh(container));

  const themeBtn = container.querySelector('#ph-analytics-theme');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      container.classList.toggle('ph-dark');
      refresh(container);
    });
  }

  const pauseBtn = container.querySelector('#ph-analytics-pause');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      const isPaused = container.classList.contains('ph-analytics--paused');
      if (isPaused) {
        container.classList.remove('ph-analytics--paused');
        resumeRefresh(container);
        pauseBtn.textContent = 'Pause updates';
      } else {
        container.classList.add('ph-analytics--paused');
        pauseRefresh(container);
        pauseBtn.textContent = 'Resume updates';
      }
    });
  }

  const thinkBtn = container.querySelector('#ph-analytics-think');
  if (thinkBtn) {
    thinkBtn.addEventListener('click', async () => {
      thinkBtn.disabled = true;
      thinkBtn.textContent = 'Running…';
      try {
        const res = await fetch(API_THINK_URL, { method: 'POST' });
        const data = await res.json();
        setStatus(container, data.ok ? 'Think Mode finished — refreshing…' : `Think Mode failed: ${data.error || 'unknown'}`, data.ok ? 'info' : 'error');
      } catch (e) {
        setStatus(container, `Think Mode request failed: ${e.message}`, 'error');
      } finally {
        setTimeout(() => { thinkBtn.disabled = false; thinkBtn.textContent = 'Run Think Mode now'; }, 2000);
      }
      await refresh(container);
    });
  }

  refresh(container);
  const interval = setInterval(() => refresh(container), REFRESH_INTERVAL_MS);
  container.dataset.phAnalyticsInterval = String(interval);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mount(`#${ANALYTICS_CONTAINER_ID}`));
} else {
  mount(`#${ANALYTICS_CONTAINER_ID}`);
}
