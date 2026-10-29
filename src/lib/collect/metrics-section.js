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

module.exports = { metricsSection };
