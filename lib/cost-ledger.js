// cost-ledger.js
// Metering-grade cost ledger for Scout. Records every billable-adjacent event
// (LLM tokens, neurons, egress bytes, compute seconds, API calls, disk writes)
// against the free-tier registry and computes an integer micro-USD shadow price.
// Zero external dependencies. All math is integer micro-USD to avoid float drift.
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'free-tier-limits.json');

function loadRegistry(registryPath) {
  const raw = fs.readFileSync(registryPath || REGISTRY_PATH, 'utf8');
  return JSON.parse(raw);
}

// UTC window keys
function hourKey(ts) { return new Date(ts).toISOString().slice(0, 13); }   // 2026-07-15T04
function dayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }    // 2026-07-15
function monthKey(ts) { return new Date(ts).toISOString().slice(0, 7); }   // 2026-07

function emptyAgg() {
  return { calls: 0, tokensIn: 0, tokensOut: 0, neurons: 0, bytes: 0, seconds: 0, shadowMicroUsd: 0, estimated: false };
}

// Integer micro-USD pricing. Rounds up (ceil) so shadow price never undercounts.
function priceEventMicroUsd(source, event, registry) {
  const def = registry.sources[source];
  if (!def || !def.shadowRates) return 0;
  const r = def.shadowRates;
  let micro = 0;
  if (event.tokensIn && r.inputPerMillionTokensMicroUsd) {
    micro += Math.ceil((event.tokensIn * r.inputPerMillionTokensMicroUsd) / 1e6);
  }
  if (event.tokensOut && r.outputPerMillionTokensMicroUsd) {
    micro += Math.ceil((event.tokensOut * r.outputPerMillionTokensMicroUsd) / 1e6);
  }
  if (event.neurons && r.perThousandNeuronsMicroUsd) {
    micro += Math.ceil((event.neurons * r.perThousandNeuronsMicroUsd) / 1000);
  }
  if (event.bytes && r.perGbMicroUsd) {
    const factor = registry.egressOverheadFactor || 1;
    micro += Math.ceil((event.bytes * factor * r.perGbMicroUsd) / 1073741824);
  }
  if (event.seconds && r.perVmHourMicroUsd) {
    micro += Math.ceil((event.seconds * r.perVmHourMicroUsd) / 3600);
  }
  if (event.minutes && r.perMinuteMicroUsd) {
    micro += Math.ceil(event.minutes * r.perMinuteMicroUsd);
  }
  return micro;
}

class CostLedger {
  constructor(options = {}) {
    this.registry = options.registry || loadRegistry(options.registryPath);
    this.stateFile = options.stateFile || null; // null = in-memory only (tests)
    this.flushMs = options.flushMs === undefined ? 5000 : options.flushMs;
    this.now = options.now || (() => Date.now());
    this.dirty = false;
    this.lastFlush = 0;
    this.state = {
      startedAt: this.now(),
      allTime: {},                 // source -> agg
      hours: {},                   // hourKey -> source -> agg
      days: {},                    // dayKey -> source -> agg
      months: {},                  // monthKey -> source -> agg
      recentEvents: []             // ring buffer of last 100 events
    };
    if (this.stateFile) this._loadState();
  }

  _loadState() {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const loaded = JSON.parse(raw);
      this.state = { ...this.state, ...loaded };
    } catch { /* first run */ }
  }

  // record({source, kind, tokensIn, tokensOut, neurons, bytes, seconds, minutes, estimated, meta})
  record(event) {
    const ts = this.now();
    const source = String(event.source || 'unknown');
    const micro = priceEventMicroUsd(source, event, this.registry);

    const buckets = [
      this.state.allTime,
      (this.state.hours[hourKey(ts)] ||= {}),
      (this.state.days[dayKey(ts)] ||= {}),
      (this.state.months[monthKey(ts)] ||= {})
    ];
    for (const bucket of buckets) {
      const agg = (bucket[source] ||= emptyAgg());
      agg.calls += 1;
      agg.tokensIn += event.tokensIn || 0;
      agg.tokensOut += event.tokensOut || 0;
      agg.neurons += event.neurons || 0;
      agg.bytes += event.bytes || 0;
      agg.seconds += event.seconds || 0;
      agg.shadowMicroUsd += micro;
      if (event.estimated) agg.estimated = true;
    }

    this.state.recentEvents.push({
      ts, source, kind: event.kind || null,
      tokensIn: event.tokensIn || 0, tokensOut: event.tokensOut || 0,
      neurons: event.neurons || 0, bytes: event.bytes || 0,
      shadowMicroUsd: micro, estimated: Boolean(event.estimated),
      meta: event.meta || null
    });
    if (this.state.recentEvents.length > 100) {
      this.state.recentEvents = this.state.recentEvents.slice(-100);
    }

    this._trimWindows();
    this.dirty = true;
    this._maybeFlush();
    return micro;
  }

  _trimWindows() {
    // Keep 48 hours, 60 days, 12 months of windows
    const hourKeys = Object.keys(this.state.hours).sort();
    while (hourKeys.length > 48) delete this.state.hours[hourKeys.shift()];
    const dayKeys = Object.keys(this.state.days).sort();
    while (dayKeys.length > 60) delete this.state.days[dayKeys.shift()];
    const monthKeys = Object.keys(this.state.months).sort();
    while (monthKeys.length > 12) delete this.state.months[monthKeys.shift()];
  }

  _maybeFlush() {
    if (!this.stateFile) return;
    const nowMs = this.now();
    if (nowMs - this.lastFlush < this.flushMs) return;
    this.flush();
  }

  flush() {
    if (!this.stateFile || !this.dirty) return;
    try {
      const json = JSON.stringify(this.state);
      fs.writeFileSync(this.stateFile, json);
      this.lastFlush = this.now();
      this.dirty = false;
      // Self-metering: the ledger's own disk write is a metered event.
      // Recorded without triggering another flush cycle.
      const bytes = Buffer.byteLength(json);
      const agg = (this.state.allTime['disk-state'] ||= emptyAgg());
      agg.calls += 1;
      agg.bytes += bytes;
    } catch (e) {
      console.error('[cost-ledger] flush failed:', e.message);
    }
  }

  // ---- Read model ----

  totalsFor(windowObj) {
    const out = emptyAgg();
    for (const source of Object.keys(windowObj || {})) {
      const a = windowObj[source];
      out.calls += a.calls; out.tokensIn += a.tokensIn; out.tokensOut += a.tokensOut;
      out.neurons += a.neurons; out.bytes += a.bytes; out.seconds += a.seconds;
      out.shadowMicroUsd += a.shadowMicroUsd;
      if (a.estimated) out.estimated = true;
    }
    return out;
  }

  headroom() {
    const ts = this.now();
    const day = this.state.days[dayKey(ts)] || {};
    const month = this.state.months[monthKey(ts)] || {};
    const result = [];
    for (const [source, def] of Object.entries(this.registry.sources)) {
      const limits = def.freeLimits || {};
      const dayAgg = day[source] || emptyAgg();
      const monthAgg = month[source] || emptyAgg();
      if (limits.requestsPerDay) {
        result.push({ source, metric: 'requestsPerDay', used: dayAgg.calls, limit: limits.requestsPerDay, pct: Math.round((dayAgg.calls / limits.requestsPerDay) * 100) });
      }
      if (limits.neuronsPerDay) {
        result.push({ source, metric: 'neuronsPerDay', used: dayAgg.neurons, limit: limits.neuronsPerDay, pct: Math.round((dayAgg.neurons / limits.neuronsPerDay) * 100), estimated: dayAgg.estimated });
      }
      if (limits.egressBytesPerMonth) {
        const factor = this.registry.egressOverheadFactor || 1;
        const adj = Math.ceil(monthAgg.bytes * factor);
        result.push({ source, metric: 'egressBytesPerMonth', used: adj, limit: limits.egressBytesPerMonth, pct: Math.round((adj / limits.egressBytesPerMonth) * 100) });
      }
      if (limits.vmHoursPerMonth) {
        const hours = monthAgg.seconds / 3600;
        result.push({ source, metric: 'vmHoursPerMonth', used: Math.round(hours * 100) / 100, limit: limits.vmHoursPerMonth, pct: Math.round((hours / limits.vmHoursPerMonth) * 100) });
      }
      if (limits.requestsPerHour) {
        const hourAgg = (this.state.hours[hourKey(ts)] || {})[source] || emptyAgg();
        result.push({ source, metric: 'requestsPerHour', used: hourAgg.calls, limit: limits.requestsPerHour, pct: Math.round((hourAgg.calls / limits.requestsPerHour) * 100) });
      }
      if (limits.bandwidthBytesPerMonth) {
        result.push({ source, metric: 'bandwidthBytesPerMonth', used: monthAgg.bytes, limit: limits.bandwidthBytesPerMonth, pct: Math.round((monthAgg.bytes / limits.bandwidthBytesPerMonth) * 100), estimated: true });
      }
      if (limits.minutesPerMonth) {
        const minutes = monthAgg.seconds / 60;
        result.push({ source, metric: 'minutesPerMonth', used: Math.round(minutes * 10) / 10, limit: limits.minutesPerMonth, pct: Math.round((minutes / limits.minutesPerMonth) * 100) });
      }
    }
    return result;
  }

  snapshot() {
    const ts = this.now();
    const monthAgg = this.state.months[monthKey(ts)] || {};
    const dayAgg = this.state.days[dayKey(ts)] || {};
    const monthTotals = this.totalsFor(monthAgg);
    const headroom = this.headroom();
    const anyExceeded = headroom.some(h => h.pct >= 100);
    return {
      generatedAt: ts,
      free: !anyExceeded,
      shadowCost: {
        monthMicroUsd: monthTotals.shadowMicroUsd,
        monthUsd: (monthTotals.shadowMicroUsd / 1e6).toFixed(6),
        dayMicroUsd: this.totalsFor(dayAgg).shadowMicroUsd,
        actualUsd: anyExceeded ? null : '0.000000'
      },
      headroom,
      bySourceMonth: monthAgg,
      bySourceDay: dayAgg,
      hours: this.state.hours,
      days: this.state.days,
      recentEvents: this.state.recentEvents.slice(-25),
      registryVersion: this.registry.version,
      registryLastVerified: this.registry.lastVerified,
      caveats: [
        'Egress measured at application layer; +' + Math.round(((this.registry.egressOverheadFactor || 1) - 1) * 100) + '% overhead factor applied for TCP/TLS.',
        'GitHub Pages bandwidth is an estimate from asset sizes and page loads.',
        'Cloudflare neurons are estimated per-model when the API omits usage data.'
      ]
    };
  }
}

module.exports = { CostLedger, loadRegistry, priceEventMicroUsd, hourKey, dayKey, monthKey };
