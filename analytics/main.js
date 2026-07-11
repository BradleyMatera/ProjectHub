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
const API_HEALTH_URL = 'https://projecthub-chat.bradleymatera.dev/health';
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
  tbody.innerHTML = sessions.slice(0, 12).map((s) => {
    const topics = Array.isArray(s.topics) ? s.topics.join(', ') : '—';
    const referrer = sanitizeReferrer(s.referrer);
    return `<tr>
      <td><span class="ph-badge ph-badge--${s.intent || 'visitor'}">${s.intent || 'visitor'}</span></td>
      <td>${formatTime(s.startedAt)}</td>
      <td>${formatNumber(s.turns)}</td>
      <td>${topics}</td>
      <td>${elapsedTime(s.durationSec)}${referrer !== 'unknown' ? ` · ${referrer}` : ''}</td>
    </tr>`;
  }).join('');
}

function renderRecentRequests(container, requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    container.innerHTML = '<p>No requests yet.</p>';
    return;
  }
  const list = document.createElement('div');
  list.className = 'ph-activity-list';
  list.innerHTML = requests.slice(0, 20).map((r) => {
    const providerClass = `ph-provider-${r.provider || 'llm'}`;
    const topicTag = r.topic ? ` <span class="ph-muted">[${r.topic}]</span>` : '';
    const latencyTag = r.latencyMs != null ? ` <span class="ph-muted">${r.latencyMs}ms</span>` : '';
    const referrer = r.referrer && r.referrer !== 'unknown' ? ` <span class="ph-muted">from ${sanitizeReferrer(r.referrer)}</span>` : '';
    return `<div class="ph-activity-item">
      <span class="ph-provider-tag ${providerClass}">${r.provider}</span>
      <span class="ph-muted">${formatTime(r.ts)}</span>${latencyTag}${topicTag}${referrer}
    </div>`;
  }).join('');
  container.innerHTML = '';
  container.appendChild(list);
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
  const otherQuestions = recent.filter(r => r.topic === 'other' || r.topic === 'out-of-scope').slice(0, 8);

  if (otherQuestions.length === 0 && stashedCount === 0) {
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
  if (otherQuestions.length > 0) {
    html += '<p class="ph-muted">Questions with no dedicated handler:</p>';
    html += '<div class="ph-activity-list">' + otherQuestions.map(r => {
      const sanitizedQ = String(r.q || '').replace(/\b\w{2,}@\w+\.\w+\b/g, '[email]').slice(0, 80);
      return `<div class="ph-activity-item">
        <span class="ph-muted">${formatTime(r.ts)}</span>
        <span class="ph-provider-tag ph-provider-out-of-scope">[${r.topic}]</span>
        <span class="ph-muted">${sanitizedQ}${(r.q || '').length > 80 ? '…' : ''}</span>
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
  `;
  container.innerHTML = '';
  container.appendChild(grid);

  const scores = learn.learnedScores || [];
  if (scores.length > 0) {
    const scoresList = document.createElement('div');
    scoresList.className = 'ph-activity-list';
    scoresList.style.marginTop = '1rem';
    scoresList.innerHTML = '<p class="ph-muted">Recent learned answer scores</p>' +
      scores.slice(0, 10).map(s => {
        const delta = (s.score || 0) - (s.groundedScore || 0);
        const deltaClass = delta > 0 ? 'ph-text-success' : delta < 0 ? 'ph-text-error' : 'ph-muted';
        const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
        const sanitizedQ = String(s.q || '').slice(0, 50);
        return `<div class="ph-activity-item">
          <span class="ph-muted">${sanitizedQ}${(s.q || '').length > 50 ? '…' : ''}</span>
          <span class="${deltaClass}">${s.score}/100 vs ${s.groundedScore} (${deltaStr})</span>
          <span class="ph-muted">via ${s.provider}</span>
        </div>`;
      }).join('');
    container.appendChild(scoresList);
  } else {
    const empty = document.createElement('p');
    empty.className = 'ph-muted';
    empty.style.marginTop = '1rem';
    empty.textContent = 'No learned answers yet — think mode will score and compare answers here.';
    container.appendChild(empty);
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function loadData() {
  const [health, repo, contributors] = await Promise.allSettled([
    fetchJson(API_HEALTH_URL, { cache: 'no-store' }),
    fetchJson(GITHUB_REPO_API),
    fetchJson(GITHUB_CONTRIB_API),
  ]);

  return {
    health: health.status === 'fulfilled' ? health.value : null,
    repo: repo.status === 'fulfilled' ? repo.value : null,
    contributors: contributors.status === 'fulfilled' ? contributors.value : null,
    errors: [
      health.status === 'rejected' ? `Health: ${health.reason.message}` : null,
      repo.status === 'rejected' ? `GitHub repo: ${repo.reason.message}` : null,
      contributors.status === 'rejected' ? `Contributors: ${contributors.reason.message}` : null,
    ].filter(Boolean),
  };
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
    renderSessionsTable(sessionsTableBody, health.recentSessions);
  }

  const recentContainer = container.querySelector('.ph-analytics__recent-requests');
  if (recentContainer && health) {
    renderRecentRequests(recentContainer, health.recentRequests);
  }

  const activityContainer = container.querySelector('.ph-analytics__activity-feed');
  if (activityContainer && health) {
    renderActivityFeed(activityContainer, health.recentRequests);
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
    renderBarList(referrerContainer, sanitized, { emptyText: 'No referrer data yet', limit: 10 });
  }

  const topicContainer = container.querySelector('.ph-analytics__topics');
  if (topicContainer && health) {
    const allTopics = Object.values(health.topicBreakdown || {}).reduce((acc, day) => {
      Object.entries(day).forEach(([topic, count]) => {
        acc[topic] = (acc[topic] || 0) + count;
      });
      return acc;
    }, {});
    renderBarList(topicContainer, allTopics, { emptyText: 'No topic data yet', highlight: k => k === 'other' || k === 'out-of-scope' });
  }

  const gapsContainer = container.querySelector('.ph-analytics__gaps');
  if (gapsContainer && health) {
    renderKnowledgeGaps(gapsContainer, health);
  }

  const learningContainer = container.querySelector('.ph-analytics__learning');
  if (learningContainer && health) {
    renderLearningSystem(learningContainer, health);
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

  container.innerHTML = `
    <div class="ph-analytics__status ph-analytics__status--loading" role="status" aria-live="polite">
      Loading live analytics…
    </div>
    <div class="ph-analytics__header">
      <div>
        <h2 class="ph-analytics__title">ProjectHub live analytics</h2>
        <p class="ph-analytics__subtitle">Real-time numbers from the running backend, refreshed every 5 seconds</p>
      </div>
      <div class="ph-analytics__controls">
        <button class="cds--btn cds--btn--primary" id="ph-analytics-refresh" type="button">Refresh now</button>
        <button class="cds--btn cds--btn--ghost" id="ph-analytics-theme" type="button">Toggle theme</button>
        <span class="ph-analytics__updated" id="ph-analytics-updated"></span>
      </div>
    </div>

    <div class="ph-analytics__grid"></div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Provider status</h3>
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
      <div class="ph-analytics__charts"></div>
    </div>

    <div class="ph-analytics__two-col">
      <div class="ph-analytics__section">
        <h3 class="ph-analytics__section-title">Live activity feed</h3>
        <div class="ph-analytics__activity-feed"></div>
      </div>
      <div class="ph-analytics__section">
        <h3 class="ph-analytics__section-title">Last request pipeline</h3>
        <div class="ph-analytics__last-pipeline"></div>
      </div>
    </div>

    <div class="ph-analytics__two-col">
      <div class="ph-analytics__section">
        <h3 class="ph-analytics__section-title">Where visitors come from</h3>
        <div class="ph-analytics__referrers"></div>
      </div>
      <div class="ph-analytics__section">
        <h3 class="ph-analytics__section-title">What recruiters ask about</h3>
        <div class="ph-analytics__topics"></div>
      </div>
    </div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Knowledge coverage gaps</h3>
      <div class="ph-analytics__gaps"></div>
    </div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Provider health history</h3>
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
      <p class="ph-muted">Original questions are hidden on the public dashboard; only provider, time, topic, and referrer domain are shown.</p>
      <div class="ph-analytics__recent-requests"></div>
    </div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Learning system (Scout think mode)</h3>
      <div class="ph-analytics__learning"></div>
    </div>

    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Service metadata</h3>
      <div class="ph-analytics__meta"></div>
    </div>
  `;

  const refreshBtn = container.querySelector('#ph-analytics-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => refresh(container));

  const themeBtn = container.querySelector('#ph-analytics-theme');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      container.classList.toggle('ph-dark');
      refresh(container);
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
