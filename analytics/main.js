import '@carbon/styles/css/styles.css';
import '@carbon/charts/styles.css';
import './style.css';

import {
  LineChart,
  SimpleBarChart,
  DonutChart,
} from '@carbon/charts';

const ANALYTICS_CONTAINER_ID = 'projecthub-analytics';
const API_HEALTH_URL = 'https://projecthub-chat.bradleymatera.dev/health';
const GITHUB_REPO_API = 'https://api.github.com/repos/BradleyMatera/ProjectHub';
const GITHUB_CONTRIB_API = 'https://api.github.com/repos/BradleyMatera/ProjectHub/contributors';

const SELECTORS = {
  status: '.ph-analytics__status',
  grid: '.ph-analytics__grid',
  charts: '.ph-analytics__charts',
  sessionsTable: '.ph-analytics__sessions-table tbody',
  providersTable: '.ph-analytics__providers-table tbody',
  meta: '.ph-analytics__meta',
};

function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US').format(Number(n));
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function sanitizeReferrer(url) {
  if (!url) return 'Direct / unknown';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') || 'Direct / unknown';
  } catch {
    return 'Direct / unknown';
  }
}

function elapsedTime(seconds) {
  if (!seconds) return '—';
  const mins = Math.round(seconds / 60);
  if (mins < 1) return '< 1 min';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs} hr ${rem} min` : `${hrs} hr`;
}

function setStatus(container, message, type = 'info') {
  const el = container.querySelector(SELECTORS.status);
  if (!el) return;
  el.className = `ph-analytics__status ph-analytics__status--${type}`;
  el.textContent = message;
  el.hidden = false;
}

function hideStatus(container) {
  const el = container.querySelector(SELECTORS.status);
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

function getTheme(container) {
  return container && container.classList.contains('ph-dark') ? 'g100' : 'white';
}

function renderLineChart(holder, data, container) {
  try {
    const chartData = data.map(([hour, counts]) => ({
      group: 'Total',
      date: `${hour}:00`,
      value: counts.total || 0,
    }));

    new LineChart(holder, {
      data: chartData,
      options: {
        title: 'Requests per hour',
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

function renderBarChart(holder, data, title, container) {
  try {
    const chartData = Object.entries(data)
      .map(([group, value]) => ({ group, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

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
      { group: 'Grounded / learned', value: data.groundedCount || 0 },
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

function renderSessionsTable(tbody, sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4">No recent sessions available</td></tr>';
    return;
  }
  tbody.innerHTML = sessions
    .slice(0, 10)
    .map((s) => {
      const topics = Array.isArray(s.topics) ? s.topics.join(', ') : '—';
      return `
        <tr>
          <td>${formatDate(s.startedAt)}</td>
          <td>${formatNumber(s.turns)}</td>
          <td>${topics}</td>
          <td>${elapsedTime(s.durationSec)}</td>
        </tr>
      `;
    })
    .join('');
}

function renderProvidersTable(tbody, providerHealth, providerOrder) {
  if (!providerHealth || Object.keys(providerHealth).length === 0) {
    tbody.innerHTML = '<tr><td colspan="4">No provider health data</td></tr>';
    return;
  }
  const rows = (providerOrder || Object.keys(providerHealth))
    .map((slug) => {
      const p = providerHealth[slug] || { successes: 0, failures: 0, avgMs: 0 };
      const total = (p.successes || 0) + (p.failures || 0);
      const rate = total > 0 ? Math.round(((p.successes || 0) / total) * 100) : 0;
      return `
        <tr>
          <td>${slug}</td>
          <td>${formatNumber(p.successes)}</td>
          <td>${formatNumber(p.failures)}</td>
          <td>${rate}% (${formatNumber(Math.round(p.avgMs || 0))} ms)</td>
        </tr>
      `;
    })
    .join('');
  tbody.innerHTML = rows;
}

function renderReferrerList(container, referrerBreakdown) {
  if (!referrerBreakdown || Object.keys(referrerBreakdown).length === 0) {
    container.innerHTML = '<p>No referrer data available.</p>';
    return;
  }
  const sanitized = Object.entries(referrerBreakdown)
    .map(([url, count]) => [sanitizeReferrer(url), count])
    .reduce((acc, [domain, count]) => {
      acc[domain] = (acc[domain] || 0) + count;
      return acc;
    }, {});

  const list = document.createElement('ul');
  Object.entries(sanitized)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .forEach(([domain, count]) => {
      const item = document.createElement('li');
      item.textContent = `${domain}: ${formatNumber(count)}`;
      list.appendChild(item);
    });
  container.innerHTML = '';
  container.appendChild(list);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function loadData() {
  const [health, repo, contributors] = await Promise.allSettled([
    fetchJson(API_HEALTH_URL),
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

function render(container) {
  const grid = container.querySelector(SELECTORS.grid);
  const charts = container.querySelector(SELECTORS.charts);
  const sessionsTbody = container.querySelector(SELECTORS.sessionsTable);
  const providersTbody = container.querySelector(SELECTORS.providersTable);
  const meta = container.querySelector(SELECTORS.meta);

  setStatus(container, 'Loading live data…', 'loading');

  loadData()
    .then(({ health, repo, contributors, errors }) => {
      hideStatus(container);

      if (errors.length > 0) {
        setStatus(container, `Some data sources failed: ${errors.join('; ')}`, 'error');
      }

      if (!health && !repo) {
        setStatus(container, 'Unable to load analytics data.', 'error');
        return;
      }

      // KPI tiles
      if (health) {
        renderTile(grid, 'Total requests (all time)', formatNumber(health.allTimeRequests));
        renderTile(grid, 'Requests since restart', formatNumber(health.totalRequestsServed));
        renderTile(grid, 'Deploy count', formatNumber(health.deployCount));
        renderTile(
          grid,
          'Reply source mix',
          `LLM ${formatNumber(health.llmCount)} / Grounded ${formatNumber(
            health.groundedCount
          )} / Cached ${formatNumber(health.cachedCount)}`
        );
        renderTile(grid, 'Active providers', formatNumber((health.providerOrder || []).length));
        renderTile(grid, 'Recent sessions', formatNumber((health.recentSessions || []).length));
      }

      if (repo) {
        renderTile(grid, 'GitHub stars', formatNumber(repo.stargazers_count));
        renderTile(grid, 'GitHub forks', formatNumber(repo.forks_count));
        renderTile(grid, 'Open issues', formatNumber(repo.open_issues_count));
        renderTile(grid, 'Watchers', formatNumber(repo.watchers_count));
      }

      if (contributors) {
        renderTile(grid, 'Contributors', formatNumber(contributors.length));
      }

      // Meta
      if (meta && health) {
        meta.innerHTML = `
          <p>Service: ${health.service || 'ProjectHub Chat API'}</p>
          <p>Status: ${health.status || 'unknown'}</p>
          <p>Deployed: ${formatDate(health.deployedAt)}</p>
          <p>Uptime: ${elapsedTime(health.uptimeSeconds)}</p>
          <p>Mode: ${health.mode || '—'}</p>
        `;
      }

      // Charts
      if (health) {
        if (health.hourlyRequests && Object.keys(health.hourlyRequests).length > 0) {
          const holder = document.createElement('div');
          holder.className = 'ph-analytics__chart';
          charts.appendChild(holder);
          renderLineChart(holder, Object.entries(health.hourlyRequests), container);
        }

        if (health.providerBreakdown && Object.keys(health.providerBreakdown).length > 0) {
          const holder = document.createElement('div');
          holder.className = 'ph-analytics__chart';
          charts.appendChild(holder);
          renderBarChart(holder, health.providerBreakdown, 'Requests by provider', container);
        }

        if (health.topicBreakdown && Object.keys(health.topicBreakdown).length > 0) {
          const holder = document.createElement('div');
          holder.className = 'ph-analytics__chart';
          charts.appendChild(holder);
          const allTopics = Object.values(health.topicBreakdown).reduce((acc, day) => {
            Object.entries(day).forEach(([topic, count]) => {
              acc[topic] = (acc[topic] || 0) + count;
            });
            return acc;
          }, {});
          renderBarChart(holder, allTopics, 'Questions by topic', container);
        }

        const holder = document.createElement('div');
        holder.className = 'ph-analytics__chart';
        charts.appendChild(holder);
        renderDonutChart(holder, health, container);
      }

      // Tables
      if (sessionsTbody && health) {
        renderSessionsTable(sessionsTbody, health.recentSessions);
      }
      if (providersTbody && health) {
        renderProvidersTable(providersTbody, health.providerHealth, health.providerOrder);
      }

      // Referrer list
      const referrerContainer = container.querySelector('.ph-analytics__referrers');
      if (referrerContainer && health) {
        renderReferrerList(referrerContainer, health.referrerBreakdown);
      }
    })
    .catch((err) => {
      console.error(err);
      setStatus(container, `Analytics failed to load: ${err.message}`, 'error');
    });
}

export function mount(selector) {
  const container = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (!container) {
    console.error('Analytics container not found:', selector);
    return;
  }

  container.innerHTML = `
    <div class="ph-analytics__status ph-analytics__status--loading" role="status" aria-live="polite">
      Loading analytics…
    </div>
    <div class="ph-analytics__header">
      <div>
        <h2 class="ph-analytics__title">ProjectHub live analytics</h2>
        <p class="ph-analytics__subtitle">Usage, health, and repository signals</p>
      </div>
      <div class="ph-analytics__controls">
        <button class="cds--btn cds--btn--primary" id="ph-analytics-refresh" type="button">Refresh</button>
        <button class="cds--btn cds--btn--ghost" id="ph-analytics-theme" type="button">Toggle theme</button>
      </div>
    </div>
    <div class="ph-analytics__grid"></div>
    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Trends & breakdowns</h3>
      <div class="ph-analytics__charts"></div>
    </div>
    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Service metadata</h3>
      <div class="ph-analytics__meta"></div>
    </div>
    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Recent sessions</h3>
      <div class="ph-analytics__table-wrap">
        <table class="ph-analytics__table ph-analytics__sessions-table" aria-label="Recent sessions">
          <thead>
            <tr><th>Started</th><th>Turns</th><th>Topics</th><th>Duration</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Provider health</h3>
      <div class="ph-analytics__table-wrap">
        <table class="ph-analytics__table ph-analytics__providers-table" aria-label="Provider health">
          <thead>
            <tr><th>Provider</th><th>Successes</th><th>Failures</th><th>Success rate</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
    <div class="ph-analytics__section">
      <h3 class="ph-analytics__section-title">Referrers (domain-level)</h3>
      <div class="ph-analytics__referrers"></div>
    </div>
  `;

  const refreshBtn = container.querySelector('#ph-analytics-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => render(container));

  const themeBtn = container.querySelector('#ph-analytics-theme');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      container.classList.toggle('ph-dark');
      render(container);
    });
  }

  render(container);
}

// Auto-mount if the container exists on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mount(`#${ANALYTICS_CONTAINER_ID}`));
} else {
  mount(`#${ANALYTICS_CONTAINER_ID}`);
}
