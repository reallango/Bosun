'use strict';

/**
 * Package widgets that use host scripts (spec version 2), on the poller's side: scripts that produce a widget's data and
 * "state probes" that detect what a widget needs to know about a host (is the service installed, which version, ...).
 * Plain CommonJS with the SSH call injected, like packages.js, so it can be tested without a host.
 *
 * The script text comes from the package files stored in the database (`widget_packages.files`). Parameters are
 * validated against the script's declaration and reach it as data (see widgets/runtime/script-run.js).
 */

const windows = require('./windows');
const { parseOutput, shapeData } = require('../widgets/runtime/data');
const { buildScriptInvocation, parseStateOutput, scriptFileFor, validateParamValues } = require('../widgets/runtime/script-run');

const STATE_SUFFIX = ':state';
const MIN_PERIOD_SEC = 5;

/** The snapshot section a package's state probe is stored in. */
const stateSectionFor = (type) => `pkg:${type}${STATE_SUFFIX}`;

function parseJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/** The text of a script for each platform it supports, from the package's stored files, or null when the script is unknown. */
function scriptSource(spec, scriptId, filesRaw) {
  const script = spec && spec.scripts && spec.scripts[scriptId];
  const files = parseJson(filesRaw);
  if (!script || !files || typeof files !== 'object') return null;
  const texts = {};
  for (const platform of ['linux', 'windows']) {
    const file = scriptFileFor(script, platform);
    if (file && typeof files[file] !== 'string') return null;   // a declared file that the package does not hold
    texts[platform] = file ? files[file] : null;
  }
  return { as: script.as, timeoutSec: script.timeoutSec, params: script.params || {}, texts };
}

/** Argument values from a widget instance's settings (`config.<key>`); a setting that is not set falls back to the parameter's default. */
function resolveArgs(argMap, params, config) {
  const values = {};
  for (const [name, path] of Object.entries(argMap || {})) {
    const key = String(path).replace(/^config\./, '');
    const v = config && Object.prototype.hasOwnProperty.call(config, key) ? config[key] : undefined;
    const dflt = params[name] && params[name].default;
    values[name] = v === undefined || v === null || v === '' ? dflt : v;
  }
  return values;
}

/** The command (and stdin) for a script on a platform, wrapped for exec. */
function invocationFor(source, platform, values) {
  const text = source.texts[platform === 'windows' ? 'windows' : 'linux'];
  if (!text) return null;
  const inv = buildScriptInvocation(platform, text, values);
  return { command: platform === 'windows' ? windows.powershellCommand(inv.command) : inv.command, stdin: inv.stdin };
}

const clean = (platform) => (platform === 'windows' ? windows.cleanPowerShellOutput : (s) => String(s || ''));

/**
 * Run a collector whose data comes from a package script. Same result shape as runCollector:
 * `{ ok: true, data }` or `{ ok: false, error }`.
 */
async function runScriptCollector(collector, platform, exec) {
  const src = collector.script;
  let inv;
  try {
    const values = validateParamValues(src.params, resolveArgs(collector.args, src.params, collector.config));
    inv = invocationFor(src, platform, values);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
  }
  if (!inv) return { ok: false, error: `This widget is not available on ${platform === 'windows' ? 'Windows' : 'Linux'} hosts` };
  let r;
  try {
    r = await exec(inv.command, { timeoutMs: collector.timeoutMs, stdin: inv.stdin });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
  }
  const c = clean(platform);
  const stdout = c(r.stdout);
  const stderr = c(r.stderr);
  if (r.timedOut) return { ok: false, error: 'The script timed out' };
  if (r.exitCode !== 0) return { ok: false, error: (stderr || stdout).trim().slice(0, 300) || `The script failed (exit ${r.exitCode})` };
  try {
    return { ok: true, data: shapeData(collector, parseOutput(collector.parse, stdout.slice(0, 256 * 1024))) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
  }
}

/** State probes of the widgets in `rows` ({ type, spec, files }), one per widget type. */
function stateProbesFrom(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const type = String(row.type);
    if (seen.has(type)) continue;
    const spec = parseJson(row.spec);
    const st = spec && spec.state;
    if (!st || typeof st.script !== 'string' || !st.fields) continue;
    const src = scriptSource(spec, st.script, row.files);
    if (!src || Object.keys(src.params).length) continue;   // a probe takes no parameters
    seen.add(type);
    out.push({
      type,
      script: src,
      fields: st.fields,
      periodMs: Math.max(MIN_PERIOD_SEC, Number(st.periodSec) || 60) * 1000,
      initialDelayMs: Math.max(0, Number(st.initialDelaySec) || 0) * 1000,
      timeoutMs: Math.min(900, Math.max(1, src.timeoutSec || 60)) * 1000,
    });
  }
  return out;
}

/**
 * Is a probe due? `last` is when it last ran, `firstSeen` when this process first saw the widget on the host. A probe with
 * an initial delay (a slow check) first runs after that delay, also on a forced poll; later forced polls run it at once.
 */
function isStateDue(probe, last, firstSeen, now, force = false) {
  if (last === undefined) return now - (firstSeen === undefined ? now : firstSeen) >= probe.initialDelayMs;
  return force || now - last >= probe.periodMs;
}

/** Run a probe: `{ ok: true, data }` with the typed object, or `{ ok: false, error }`. */
async function runStateProbe(probe, platform, exec) {
  const inv = invocationFor(probe.script, platform, {});
  if (!inv) return { ok: false, error: `This widget is not available on ${platform === 'windows' ? 'Windows' : 'Linux'} hosts` };
  let r;
  try {
    r = await exec(inv.command, { timeoutMs: probe.timeoutMs, stdin: inv.stdin });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
  }
  const c = clean(platform);
  const stdout = c(r.stdout);
  if (r.timedOut) return { ok: false, error: 'The probe timed out' };
  if (r.exitCode !== 0) return { ok: false, error: (c(r.stderr) || stdout).trim().slice(0, 300) || `The probe failed (exit ${r.exitCode})` };
  return { ok: true, data: parseStateOutput(stdout.slice(0, 256 * 1024), probe.fields) };
}

module.exports = { STATE_SUFFIX, stateSectionFor, scriptSource, resolveArgs, runScriptCollector, stateProbesFrom, isStateDue, runStateProbe };
