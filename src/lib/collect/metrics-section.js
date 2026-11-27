'use strict';

/**
 * The latest value of every tracked number, as a nested object (`cpu.usage` becomes `{ cpu: { usage } }`), stored
 * as the `metrics` snapshot section. Widgets read their numbers from it (`{metrics.cpu.usage}`), so a widget never
 * has to know how a collector computed them. `sys.uptime_s` rides along although it is not tracked as history.
 */
function metricsSection(metrics, uptimeSeconds) {
  const out = {};
  const all = { ...metrics };
  if (typeof uptimeSeconds === 'number' && Number.isFinite(uptimeSeconds)) all['sys.uptime_s'] = uptimeSeconds;
  for (const [name, value] of Object.entries(all)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const parts = name.split('.');
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  return out;
}

/** Metrics that come from a slower probe tier (disks: every minute or two), so a fast poll does not have them. */
const SLOW_PREFIXES = ['disk.'];

/**
 * The numbers for the `metrics` snapshot: this poll's, plus the last value of every slow-tier metric this poll did not
 * measure, so a widget showing disk usage does not lose it between disk probes. `state` (the collector's per-server
 * state) keeps those last values. Only the snapshot gets them: the metric history records real samples only.
 */
function withSlowMetrics(metrics, state) {
  const slow = (state.slowMetrics && typeof state.slowMetrics === 'object') ? state.slowMetrics : {};
  const measured = Object.keys(metrics).filter(k => SLOW_PREFIXES.some(p => k.startsWith(p)));
  if (measured.length) {
    // A slow probe ran: its values replace all earlier ones (a disk that is gone must not linger).
    const next = {};
    for (const k of measured) next[k] = metrics[k];
    state.slowMetrics = next;
    return { ...metrics };
  }
  return { ...slow, ...metrics };
}

module.exports = { metricsSection, withSlowMetrics };
