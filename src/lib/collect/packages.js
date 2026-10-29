'use strict';

/**
 * Collecting the data of package widgets in the background, the way the poller collects the built-in
 * widgets' sections. Used by poller.js; plain CommonJS with the SSH call injected so it can be tested.
 *
 * A package widget whose `spec.data.source` is `command` runs that command on each server that has
 * one of its widgets on a dashboard, as often as its `cacheSec` allows (never faster than the host is
 * polled), and the shaped result is stored as the host snapshot section `pkg:<widget type>`. The web
 * app only reads that stored section: opening a dashboard never starts an SSH command.
 */

const windows = require('./windows');
const { parseOutput, shapeData, extractMetrics } = require('../widgets/runtime/data');

const SECTION_PREFIX = 'pkg:';
const MIN_INTERVAL_SEC = 5;

/** Snapshot section name for a widget type. */
const sectionFor = (type) => `${SECTION_PREFIX}${type}`;

/**
 * The collectors for a list of `{ type, spec }` rows (spec as stored JSON): only command-sourced widgets,
 * with their account, interval and timeout. Anything malformed is skipped.
 */
function collectorsFrom(rows) {
  const out = [];
  for (const row of rows || []) {
    let spec = row.spec;
    if (typeof spec === 'string') { try { spec = JSON.parse(spec); } catch { continue; } }
    const d = spec && spec.data;
    if (!d || d.source !== 'command' || (d.as !== 'service' && d.as !== 'shell') || typeof d.command !== 'string') continue;
    out.push({
      type: String(row.type),
      as: d.as,
      command: d.command,
      windowsCommand: typeof d.windowsCommand === 'string' ? d.windowsCommand : null,
      parse: d.parse,
      path: d.path,
      map: d.map,
      intervalMs: Math.max(MIN_INTERVAL_SEC, Number(d.cacheSec) || 10) * 1000,
      timeoutMs: Math.min(60, Math.max(1, Number(d.timeoutSec) || 20)) * 1000,
      metrics: computedMetrics(spec),
    });
  }
  return out;
}

/** The metrics of a spec that are computed from the widget's data (the others name built-in collector metrics). */
function computedMetrics(spec) {
  return Array.isArray(spec && spec.metrics) ? spec.metrics.filter((m) => m && m.from) : [];
}

/**
 * Snapshot-sourced widgets that track statistics computed from their data: `{ type, section, path, map, metrics }`.
 * The poller reads the stored section after each poll and records the numbers.
 */
function snapshotTrackersFrom(rows) {
  const out = [];
  for (const row of rows || []) {
    let spec = row.spec;
    if (typeof spec === 'string') { try { spec = JSON.parse(spec); } catch { continue; } }
    const d = spec && spec.data;
    const metrics = computedMetrics(spec);
    if (!d || d.source !== 'snapshot' || typeof d.section !== 'string' || !metrics.length) continue;
    out.push({ type: String(row.type), section: d.section, path: d.path, map: d.map, metrics });
  }
  return out;
}

/** The numbers to record for a collected result (nothing for a failed one). */
function metricsOf(collector, result) {
  return result && result.ok ? extractMetrics(collector.metrics, result.data) : {};
}

/** Is a collector due? `last` is when it last ran (ms) or undefined. A forced poll runs everything. */
function isDue(collector, last, now, force = false) {
  return force || last === undefined || now - last >= collector.intervalMs;
}

/**
 * Run one collector. `exec(command, { timeoutMs })` resolves `{ stdout, stderr, exitCode, timedOut }` for the
 * account the collector needs. Returns what to store: `{ ok: true, data }` or `{ ok: false, error }`.
 */
async function runCollector(collector, platform, exec) {
  const template = platform === 'windows' ? collector.windowsCommand : collector.command;
  if (!template) return { ok: false, error: 'This widget is not available on Windows hosts' };
  const command = platform === 'windows' ? windows.powershellCommand(template) : template;
  let r;
  try {
    r = await exec(command, { timeoutMs: collector.timeoutMs });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
  }
  const clean = platform === 'windows' ? windows.cleanPowerShellOutput : (s) => String(s || '');
  const stdout = clean(r.stdout);
  const stderr = clean(r.stderr);
  if (r.timedOut) return { ok: false, error: 'The command timed out' };
  if (r.exitCode !== 0) return { ok: false, error: (stderr || stdout).trim().slice(0, 300) || `The command failed (exit ${r.exitCode})` };
  try {
    return { ok: true, data: shapeData(collector, parseOutput(collector.parse, stdout.slice(0, 256 * 1024))) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
  }
}

module.exports = { SECTION_PREFIX, sectionFor, collectorsFrom, snapshotTrackersFrom, metricsOf, isDue, runCollector };
