'use strict';

/**
 * Turning command output and snapshots into the rows a declarative widget shows. Plain CommonJS with no
 * imports so the poller (which collects package widget data) and the web app share it. Pure.
 */

const MAX_ROWS = 2000;

/** Own properties only, so a path can never reach `__proto__` or `constructor`. */
function getPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Parse command output. `json`/`jsonlines` return parsed values, `lines` rows of {line}, `text` {text}.
 * @param {'json'|'jsonlines'|'lines'|'text'} parse
 * @param {string} stdout
 */
function parseOutput(parse, stdout) {
  const clean = String(stdout).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  switch (parse) {
    case 'json': {
      try { return JSON.parse(clean); } catch { throw new Error('The command did not print valid JSON'); }
    }
    case 'jsonlines': {
      const rows = [];
      for (const line of clean.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch { throw new Error('The command printed a line that is not valid JSON'); }
        if (rows.length > MAX_ROWS) break;
      }
      return rows;
    }
    case 'lines':
      return clean.split(/\r?\n/).filter(l => l.trim().length > 0).slice(0, MAX_ROWS).map(line => ({ line }));
    case 'text':
      return { text: clean };
    default:
      throw new Error('Unknown output format');
  }
}

/** Select a dotted path inside parsed data (no path = the data itself). */
function selectPath(data, path) {
  return path ? getPath(data, path) : data;
}

/** Add renamed copies of fields: `map` goes from a new name to a source (dotted) field name. */
function applyMap(data, map) {
  if (!map) return data;
  const one = (row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const out = { ...row };
    for (const [to, from] of Object.entries(map)) out[to] = getPath(row, from);
    return out;
  };
  return Array.isArray(data) ? data.map(one) : one(data);
}

/**
 * Shape what a widget receives: select the path, apply the map, cap the number of rows.
 * @param {{ path?: string, map?: Record<string, string> }} spec
 * @param {unknown} parsed
 */
function shapeData(spec, parsed) {
  const picked = applyMap(selectPath(parsed, spec.path), spec.map);
  return Array.isArray(picked) ? picked.slice(0, MAX_ROWS) : picked;
}

function matchCond(c, row) {
  const v = getPath(row, c.field);
  const same = (x) => v === x || (v !== undefined && v !== null && String(v) === String(x));
  if (c.exists !== undefined) return (v !== undefined && v !== null && v !== '') === c.exists;
  if (c.equals !== undefined) return same(c.equals);
  if (c.notEquals !== undefined) return !same(c.notEquals);
  if (Array.isArray(c.in)) return c.in.some(same);
  return false;
}

/**
 * The numbers a widget tracks over time, computed from its (shaped) data. Only metrics with `from` are computed
 * here; the others name metrics the built-in collectors already produce. Returns { name: number }.
 * @param {{ name: string, from?: { field?: string, agg: string, where?: object } }[] | undefined} metrics
 * @param {unknown} data
 */
function extractMetrics(metrics, data) {
  const out = {};
  if (!Array.isArray(metrics) || data === null || data === undefined) return out;
  const rows = Array.isArray(data) ? data : [data];
  for (const m of metrics) {
    if (!m || !m.from) continue;
    const f = m.from;
    const sel = f.where ? rows.filter((r) => matchCond(f.where, r)) : rows;
    if (f.agg === 'count') { out[m.name] = sel.length; continue; }
    const nums = sel.map((r) => Number(getPath(r, f.field))).filter((n) => Number.isFinite(n));
    if (!nums.length) continue;
    if (f.agg === 'sum') out[m.name] = nums.reduce((a, b) => a + b, 0);
    else if (f.agg === 'avg') out[m.name] = nums.reduce((a, b) => a + b, 0) / nums.length;
    else if (f.agg === 'min') out[m.name] = Math.min(...nums);
    else if (f.agg === 'max') out[m.name] = Math.max(...nums);
    else if (f.agg === 'first') out[m.name] = nums[0];
  }
  return out;
}

module.exports = { MAX_ROWS, getPath, parseOutput, selectPath, applyMap, shapeData, matchCond, extractMetrics };
