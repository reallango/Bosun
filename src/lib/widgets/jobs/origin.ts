/**
 * Where a job came from, so a person can come back to the screen it was started on, with what they had filled in, to correct it and
 * try again. The editor values and the row the screen was opened for are kept with the job, encrypted. Values the package marks as
 * secret (the passwords in an environment list) are taken out first and kept apart: the browser only ever gets a placeholder
 * (`bosun-saved:<n>`) back, and the server puts the real value in again when the form is submitted from that job
 * (`savedFrom`). A secret never goes back to the browser and never appears in a job's log.
 */
import { decrypt, encrypt } from '@/lib/crypto/keys';
import { getMasterKey } from '@/lib/secrets';
import type { Block, EditorField } from '@/lib/widgets/runtime/spec-v2';
import type { ScreenSpec } from '@/lib/widgets/runtime/spec-screens';
import { isSecretName } from '@/lib/widgets/runtime/layout';

export const TOKEN_RE = /bosun-saved:(\d{1,4})/g;
const MAX_ORIGIN_BYTES = 120_000;

export interface Origin {
  screenId: string;
  /** The row the screen was opened for (a container), or null. */
  context: Record<string, unknown> | null;
  /** Editor values with secrets replaced by placeholders. */
  values: Record<string, unknown>;
  /** The real secret values, by placeholder number. */
  secrets: string[];
}

/** The editor fields of a screen (all of its editors). */
export function editorFieldsOf(screen: ScreenSpec | undefined): EditorField[] {
  const out: EditorField[] = [];
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.type === 'editor') out.push(...b.fields);
      else if (b.type === 'tabs') b.tabs.forEach(t => walk(t.blocks));
      else if (b.type === 'section') walk(b.blocks);
    }
  };
  if (screen) walk(screen.blocks);
  return out;
}

/** Replace the values of secret-looking names in a `KEY=value` line with a placeholder; the real value goes to `secrets`. */
function maskLine(line: string, secrets: string[]): string {
  const eq = line.indexOf('=');
  if (eq <= 0) return line;
  const name = line.slice(0, eq);
  const value = line.slice(eq + 1);
  if (!isSecretName(name) || value === '' || /^bosun-saved:\d+$/.test(value)) return line;
  secrets.push(value);
  return `${name}=bosun-saved:${secrets.length - 1}`;
}

/** The values with every masked field's secrets taken out (see EditorField.mask). */
export function maskValues(fields: EditorField[], values: Record<string, unknown>, existing: string[] = []): { values: Record<string, unknown>; secrets: string[] } {
  const secrets = [...existing];
  const out: Record<string, unknown> = { ...values };
  for (const f of fields) {
    if (f.mask !== 'secret-names') continue;
    const v = out[f.name];
    if (f.input === 'pairs' && Array.isArray(v)) out[f.name] = (v as unknown[]).map(x => (typeof x === 'string' ? maskLine(x, secrets) : x));
    else if (f.input === 'textarea' && typeof v === 'string') out[f.name] = v.split('\n').map(l => maskLine(l, secrets)).join('\n');
  }
  return { values: out, secrets };
}

/** Put the real values back wherever a placeholder stands. Throws when a placeholder has no saved value. */
export function resolveTokens<T>(input: T, secrets: string[]): T {
  const swap = (s: string): string => s.replace(TOKEN_RE, (_m, n: string) => {
    const v = secrets[Number(n)];
    if (v === undefined) throw new Error('A saved value is no longer available: enter it again.');
    return v;
  });
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return swap(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    return x;
  };
  return walk(input) as T;
}

/** What the browser sent as the origin of an action, checked and bounded; null when it is not usable. */
export function sanitizeOrigin(raw: unknown): { screenId: string; context: Record<string, unknown> | null; values: Record<string, unknown> } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.screenId !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(o.screenId)) return null;
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const values = obj(o.values);
  if (!values) return null;
  const context = obj(o.context);
  if (JSON.stringify({ context, values }).length > MAX_ORIGIN_BYTES) return null;
  return { screenId: o.screenId, context, values };
}

export const encryptOrigin = (o: Origin): string => encrypt(JSON.stringify(o), getMasterKey());

export function decryptOrigin(enc: string | null | undefined): Origin | null {
  if (!enc) return null;
  try {
    const o = JSON.parse(decrypt(enc, getMasterKey())) as Origin;
    return o && typeof o.screenId === 'string' && o.values && Array.isArray(o.secrets) ? o : null;
  } catch { return null; }
}
