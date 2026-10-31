/**
 * A package's terminal action: an interactive terminal that runs one command the package declared, with the target
 * ({{ref}}) put in. This is the only way Bosun opens such a terminal; it knows nothing about what the command is.
 *
 *  - the target (`ref`) must match the pattern the package declared and a conservative safe set (it goes into a command line);
 *  - API keys first pass the action's check script (when it has one): it may refuse (`ERROR:`) and may pin the target by
 *    printing `REF <exact name>` (the command then uses that, so what was checked is what runs);
 *  - the result is a signed, single-use token carrying the final command: an API terminal token for API keys, a web
 *    terminal token for a signed-in Full access user (who still types their own login in the terminal).
 */
import { NextResponse } from 'next/server';
import type { TokenPayload } from '@/lib/auth/jwt';
import { fail } from '@/lib/api/response';
import { hasRole } from '@/lib/auth/levels';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { runScript, type LoadedSpec } from '@/lib/widgets/runtime/execute';
import type { ActionSpec } from '@/lib/widgets/runtime/spec';
import { issueApiTerminalToken, issueWebCommandToken } from '@/lib/terminal/api-token';

/** Whatever a package's pattern allows, a target that goes into a command line is plain: no spaces, quotes or shell characters. */
export const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@=+-]{0,199}$/;

export async function openTerminalAction(auth: TokenPayload, serverId: string, loaded: LoadedSpec, action: ActionSpec, refRaw: unknown): Promise<NextResponse> {
  const t = action.terminal;
  if (!t) return fail('This action does not open a terminal', 400, 'NOT_A_TERMINAL');
  const matches = (v: unknown): v is string => typeof v === 'string' && SAFE_REF_RE.test(v) && new RegExp(t.refPattern).test(v);
  if (!matches(refRaw)) return fail('ref is missing or not an acceptable name', 400, 'INVALID_REF');
  if (!consumeActionRateLimit(auth.userId).allowed) return fail('Too many requests, slow down', 429, 'RATE_LIMITED');
  const via = `${loaded.type}/${action.id}`;
  const isApi = auth.authType === 'api_key' && !!auth.apiKeyId;

  let ref: string = refRaw;
  if (isApi && t.check) {
    const r = await runScript(serverId, loaded, t.check, { ref });
    if (!r.success || r.protocol.error) return fail(`Terminal refused: ${r.protocol.error || r.stderr.trim().slice(0, 200) || 'the check failed'}`, 403, 'TERMINAL_REFUSED');
    // A REF line pins the target. Any REF line that is not a plain acceptable name is a refusal, never ignored.
    const pin = /^REF (.*)$/m.exec(r.stdout);
    if (pin) {
      const pinned = pin[1].trim();
      if (!matches(pinned)) return fail('Terminal refused: the check returned an unreadable target', 403, 'TERMINAL_REFUSED');
      ref = pinned;
    }
  }
  const command = t.command.replace('{{ref}}', ref);
  const label = `${action.label}: ${refRaw}`.slice(0, 200);
  if (isApi) return issueApiTerminalToken(auth, serverId, 'command', { command, label, via });
  if (!hasRole(auth.role, 'admin')) return fail('A web terminal needs Full access', 403, 'FORBIDDEN');
  return issueWebCommandToken(auth, serverId, command, label, via);
}
