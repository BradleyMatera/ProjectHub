// cost-insights.js
// Pure functions that turn a cost-ledger snapshot into forecasts, anomaly flags,
// and ranked human-readable insights. No I/O, fully unit-testable.

const EWMA_ALPHA = 0.3;
const ANOMALY_FACTOR = 3;

function ewma(series, alpha = EWMA_ALPHA) {
  if (!series.length) return 0;
  let value = series[0];
  for (let i = 1; i < series.length; i++) {
    value = alpha * series[i] + (1 - alpha) * value;
  }
  return value;
}

// Extract a per-day series of a numeric field for one source from snapshot.days
function dailySeries(days, source, field) {
  return Object.keys(days || {}).sort().map(k => (days[k][source] || {})[field] || 0);
}

// Sum a field across all sources per day
function dailyTotalSeries(days, field) {
  return Object.keys(days || {}).sort().map(k => {
    return Object.values(days[k] || {}).reduce((s, a) => s + (a[field] || 0), 0);
  });
}

function hoursRemainingInMonth(now) {
  const d = new Date(now);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return Math.max(0, (end - d) / 3600000);
}

function hoursElapsedInMonth(now) {
  const d = new Date(now);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  return Math.max(1 / 60, (d - start) / 3600000);
}

// Hybrid month-end projection: used + burnRate * hoursRemaining, where burnRate
// blends linear (month-to-date / elapsed) and EWMA of recent daily values.
function projectMonthEnd(usedThisMonth, recentDailySeries, now) {
  const elapsed = hoursElapsedInMonth(now);
  const linearPerHour = usedThisMonth / elapsed;
  const ewmaPerDay = ewma(recentDailySeries);
  const ewmaPerHour = ewmaPerDay / 24;
  const burnPerHour = recentDailySeries.length >= 3 ? (linearPerHour + ewmaPerHour) / 2 : linearPerHour;
  return usedThisMonth + burnPerHour * hoursRemainingInMonth(now);
}

// Anomaly: latest complete hour > ANOMALY_FACTOR x mean of trailing 24 hours
function detectAnomalies(hours) {
  const keys = Object.keys(hours || {}).sort();
  if (keys.length < 4) return [];
  const latestKey = keys[keys.length - 1];
  const trailing = keys.slice(0, -1).slice(-24);
  const anomalies = [];
  const sources = new Set();
  for (const k of [...trailing, latestKey]) {
    Object.keys(hours[k] || {}).forEach(s => sources.add(s));
  }
  for (const source of sources) {
    const trailingCalls = trailing.map(k => (hours[k][source] || {}).calls || 0);
    const mean = trailingCalls.reduce((a, b) => a + b, 0) / Math.max(1, trailingCalls.length);
    const latest = (hours[latestKey][source] || {}).calls || 0;
    if (mean > 0.5 && latest > ANOMALY_FACTOR * mean) {
      anomalies.push({ source, latest, baseline: Math.round(mean * 10) / 10, factor: Math.round((latest / mean) * 10) / 10 });
    }
  }
  return anomalies;
}

function fmtBytes(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// Severity: 0=ok, 1=watch, 2=alert
function buildInsights(snapshot) {
  const now = snapshot.generatedAt || Date.now();
  const insights = [];

  // 1. Proof-of-free headline
  const monthUsd = snapshot.shadowCost?.monthUsd || '0.000000';
  if (snapshot.free) {
    insights.push({ severity: 0, tag: 'free-status', text: `Total actual cost this month: $0.000000 — if these weren't free, you'd have paid $${monthUsd}. All usage inside free tiers.` });
  } else {
    insights.push({ severity: 2, tag: 'free-status', text: `A free-tier limit has been exceeded this period. If these weren't free, you'd have paid $${monthUsd}. Review headroom below.` });
  }

  // 2. Headroom watches: monthly quotas get projections; daily quotas report exhaustion pace
  for (const h of snapshot.headroom || []) {
    if (h.pct >= 100) {
      insights.push({ severity: 2, tag: h.source, text: `EXCEEDED — ${h.source} ${h.metric}: ${h.used} of ${h.limit} (${h.pct}%).` });
    } else if (h.metric.endsWith('PerMonth') || h.metric === 'egressBytesPerMonth' || h.metric === 'bandwidthBytesPerMonth') {
      const rawSeries = dailySeries(snapshot.days, h.source, h.metric.includes('Bytes') ? 'bytes' : 'seconds');
      // Convert series to same unit as h.used (headroom converts seconds→hours or seconds→minutes)
      let series = rawSeries;
      if (h.metric === 'vmHoursPerMonth') series = rawSeries.map(s => s / 3600);
      else if (h.metric === 'minutesPerMonth') series = rawSeries.map(s => s / 60);
      const projected = projectMonthEnd(h.used, series, now);
      const projPct = Math.round((projected / h.limit) * 100);
      const usedStr = h.metric.includes('Bytes') ? fmtBytes(h.used) : String(h.used);
      const projStr = h.metric.includes('Bytes') ? fmtBytes(Math.round(projected)) : String(Math.round(projected * 10) / 10);
      const limitStr = h.metric.includes('Bytes') ? fmtBytes(h.limit) : String(h.limit);
      const severity = projPct >= 100 ? 2 : projPct >= 60 ? 1 : 0;
      const label = severity === 2 ? 'ALERT' : severity === 1 ? 'WATCH' : 'OK';
      insights.push({ severity, tag: h.source, text: `${label} — ${h.source} ${h.metric}: ${usedStr} used, projected ${projStr} of ${limitStr} by month end (${projPct}%).${h.estimated ? ' (estimate)' : ''}` });
    } else if (h.pct >= 50) {
      // Daily/hourly quota above 50%: estimate exhaustion time at current pace
      const hourOfDay = new Date(now).getUTCHours() + new Date(now).getUTCMinutes() / 60;
      const rate = h.used / Math.max(0.25, hourOfDay);
      const hoursToLimit = rate > 0 ? (h.limit - h.used) / rate : Infinity;
      const eta = isFinite(hoursToLimit) ? `~${Math.round(hoursToLimit * 10) / 10}h to exhaustion at current pace` : 'no exhaustion expected';
      const severity = h.pct >= 80 ? 2 : 1;
      insights.push({ severity, tag: h.source, text: `${severity === 2 ? 'ALERT' : 'WATCH'} — ${h.source} ${h.metric} at ${h.pct}% (${h.used}/${h.limit}); ${eta}.${h.estimated ? ' (estimate)' : ''}` });
    }
  }

  // 3. Trend: last 7 days vs prior 7 days cost-if-paid
  const costSeries = dailyTotalSeries(snapshot.days, 'shadowMicroUsd');
  if (costSeries.length >= 8) {
    const last7 = costSeries.slice(-7).reduce((a, b) => a + b, 0);
    const prior7 = costSeries.slice(-14, -7).reduce((a, b) => a + b, 0);
    if (prior7 > 0) {
      const deltaPct = Math.round(((last7 - prior7) / prior7) * 100);
      const dir = deltaPct > 0 ? 'up' : 'down';
      insights.push({ severity: Math.abs(deltaPct) > 100 ? 1 : 0, tag: 'trend', text: `Cost-if-paid trend: ${dir} ${Math.abs(deltaPct)}% week-over-week ($${(last7 / 1e6).toFixed(6)} vs $${(prior7 / 1e6).toFixed(6)}).` });
    }
  }

  // 4. Anomalies
  for (const a of detectAnomalies(snapshot.hours)) {
    insights.push({ severity: 2, tag: a.source, text: `ALERT — ${a.source} call volume ${a.factor}x hourly baseline (${a.latest} vs ~${a.baseline}). Possible abuse or scraping.` });
  }

  return insights.sort((a, b) => b.severity - a.severity);
}

module.exports = { buildInsights, projectMonthEnd, detectAnomalies, ewma, dailySeries, dailyTotalSeries, fmtBytes };
