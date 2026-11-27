/** Short, scannable text for tool results, with the structured value alongside it. */
import type { ToolResult } from './types';

export const DEFAULT_MAX_CHARS = 8000;
export const DEFAULT_MAX_ROWS = 50;

export function truncate(text: string, max = DEFAULT_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters; narrow the request to see them)`;
}

export function textResult(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) };
}

export function errorResult(message: string, structuredContent?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: message }], ...(structuredContent ? { structuredContent } : {}), isError: true };
}

function shortValue(value: unknown, max = 160): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.length <= max ? value : `${value.slice(0, max)}…`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const json = JSON.stringify(value);
    return json.length <= max ? json : `${json.slice(0, max)}…`;
  } catch {
    return String(value);
  }
}

function rowLine(row: unknown): string {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    return Object.entries(row as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${shortValue(v)}`)
      .join(', ');
  }
  return shortValue(row);
}

export interface FormattedData {
  text: string;
  /** What goes into structuredContent: the shown rows, or the object when it is not too large. */
  structured: unknown;
  truncated: boolean;
  total: number | null;
}

/** One line per row for arrays; key: value lines for objects. Large answers are cut with a note. */
export function formatData(data: unknown, opts: { maxRows?: number; maxChars?: number } = {}): FormattedData {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (data === null || data === undefined) return { text: 'No data.', structured: null, truncated: false, total: null };

  if (Array.isArray(data)) {
    const shown = data.slice(0, maxRows);
    let text = shown.map((row, i) => `${i + 1}. ${rowLine(row)}`).join('\n');
    let truncated = data.length > shown.length;
    if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
    if (truncated) text += `\n… showing ${shown.length} of ${data.length} rows; narrow the request or use a dataset that returns less.`;
    return { text, structured: shown, truncated, total: data.length };
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    let text = entries.map(([k, v]) => `${k}: ${shortValue(v)}`).join('\n');
    let truncated = false;
    if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
    if (truncated) text += '\n… (the object is larger; request a narrower dataset)';
    let structured: unknown = data;
    try {
      if (JSON.stringify(data).length > maxChars * 2) structured = { truncated: true, preview: text };
    } catch { structured = { truncated: true, preview: text }; }
    return { text, structured, truncated, total: null };
  }

  return { text: shortValue(data, maxChars), structured: data, truncated: false, total: null };
}

export interface JobLike {
  id: string;
  status: string;
  steps?: string[];
  percent?: number | null;
  message?: string | null;
  startedAt?: number;
  finishedAt?: number | null;
}

export function formatJob(job: JobLike, maxSteps = 10): string {
  const percent = job.percent === null || job.percent === undefined ? '' : ` (${job.percent}%)`;
  const lines = [`Job ${job.id}: ${job.status}${percent}`];
  if (job.message) lines.push(`message: ${job.message}`);
  const steps = job.steps ?? [];
  if (steps.length) {
    lines.push(`steps (last ${Math.min(steps.length, maxSteps)}):`);
    for (const step of steps.slice(-maxSteps)) lines.push(`  - ${step}`);
  } else {
    lines.push('steps: none yet');
  }
  return lines.join('\n');
}

export function formatAccessRequest(r: {
  id: string; kind: string; status: string; summary?: string; permission_label?: string; server_name?: string | null;
  decided_by?: string | null; decision_note?: string | null; expires_at?: string; result?: unknown;
}): string {
  const lines = [`Request ${r.id}: ${r.status} (${r.kind})`];
  if (r.summary) lines.push(`what: ${r.summary}`);
  if (r.permission_label) lines.push(`permission: ${r.permission_label}`);
  if (r.server_name) lines.push(`server: ${r.server_name}`);
  if (r.expires_at) lines.push(`expires: ${r.expires_at}`);
  if (r.decided_by) lines.push(`decided by: ${r.decided_by}${r.decision_note ? ` — ${r.decision_note}` : ''}`);
  if (r.result !== undefined && r.result !== null) lines.push(`result: ${shortValue(r.result, 500)}`);
  return lines.join('\n');
}
