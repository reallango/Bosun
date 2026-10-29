/**
 * Turning command output and snapshots into the rows a declarative widget shows. Pure.
 */
import { getPath, type DataSpec } from '@/lib/widgets/runtime/spec';

export const MAX_ROWS = 2000;

type Parser = Extract<DataSpec, { source: 'command' }>['parse'];

/** Parse command output. `json`/`jsonlines` return parsed values, `lines` rows of {line}, `text` {text}. */
export function parseOutput(parse: Parser, stdout: string): unknown {
  const clean = stdout.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  switch (parse) {
    case 'json': {
      try { return JSON.parse(clean); } catch { throw new Error('The command did not print valid JSON'); }
    }
    case 'jsonlines': {
      const rows: unknown[] = [];
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
  }
}

/** Select a dotted path inside parsed data (no path = the data itself). */
export function selectPath(data: unknown, path: string | undefined): unknown {
  return path ? getPath(data, path) : data;
}

/** Add renamed copies of fields: `map` goes from a new name to a source (dotted) field name. */
export function applyMap(data: unknown, map: Record<string, string> | undefined): unknown {
  if (!map) return data;
  const one = (row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const [to, from] of Object.entries(map)) out[to] = getPath(row, from);
    return out;
  };
  return Array.isArray(data) ? data.map(one) : one(data);
}

/** Shape what a widget receives: select the path, apply the map, cap the number of rows. */
export function shapeData(spec: Pick<DataSpec, 'path' | 'map'>, parsed: unknown): unknown {
  const picked = applyMap(selectPath(parsed, spec.path), spec.map);
  return Array.isArray(picked) ? picked.slice(0, MAX_ROWS) : picked;
}
