import { describe, it, expect } from 'vitest';
import { validateParam } from './spec-util';
import { validateParamValues } from './script-run';

const accepts = (raw: Record<string, unknown>) => validateParam('p', raw, 'script').ok;

/** True when a caller that leaves the parameter out gets a run: the runtime fills the default and accepts it. */
const runsWithoutTheParam = (raw: Record<string, unknown>): boolean => {
  const v = validateParam('p', raw, 'script');
  if (!v.ok) return false;
  try { validateParamValues({ p: v.value }, {}); return true; } catch { return false; }
};

describe('a default the run itself would refuse', () => {
  // A caller may leave out a parameter that has a default (validateParamValues fills it), so a default the runtime
  // rejects turns every such call into "Missing parameter"-style errors even though the package installed cleanly.
  it('is refused for a number that is not whole', () => {
    expect(accepts({ type: 'number', min: 0, max: 10, default: 5.5 })).toBe(false);
    expect(runsWithoutTheParam({ type: 'number', min: 0, max: 10, default: 5.5 })).toBe(false);
  });

  it('is still allowed for a number when "integer" is false, and for whole numbers', () => {
    expect(accepts({ type: 'number', min: 0, max: 10, integer: false, default: 5.5 })).toBe(true);
    expect(runsWithoutTheParam({ type: 'number', min: 0, max: 10, integer: false, default: 5.5 })).toBe(true);
    expect(accepts({ type: 'number', min: 0, max: 10, default: 5 })).toBe(true);
  });

  it('is refused for text that is too long, too many lines or off the line pattern', () => {
    expect(accepts({ type: 'text', maxLength: 10, default: 'x'.repeat(20) })).toBe(false);
    expect(accepts({ type: 'text', maxLength: 100, maxLines: 2, default: 'a\nb\nc' })).toBe(false);
    expect(accepts({ type: 'text', maxLength: 100, linePattern: '^[a-z]+$', default: 'AB' })).toBe(false);
    // Control characters, except newlines and tabs, are refused by the run.
    expect(accepts({ type: 'text', maxLength: 100, default: 'a\u0007b' })).toBe(false);
  });

  it('counts lines and length the way the run does (CRLF means one line)', () => {
    expect(runsWithoutTheParam({ type: 'text', maxLength: 100, maxLines: 2, default: 'a\r\nb' })).toBe(true);
    expect(runsWithoutTheParam({ type: 'text', maxLength: 100, maxLines: 3, default: 'a\n\nb' })).toBe(true);
  });

  it('is refused for an empty string, which the run never accepts', () => {
    expect(accepts({ type: 'string', maxLength: 20, pattern: '^[a-z]*$', default: '' })).toBe(false);
    expect(runsWithoutTheParam({ type: 'string', maxLength: 20, values: ['', 'a'], default: '' })).toBe(false);
  });

  it('keeps accepting the defaults the bundled packages declare', () => {
    expect(runsWithoutTheParam({ type: 'text', maxLength: 8000, default: 'volumes=true\nbinds=true' })).toBe(true);
    expect(runsWithoutTheParam({ type: 'boolean', default: false })).toBe(true);
    expect(runsWithoutTheParam({ type: 'string', maxLength: 60, pattern: '^[a-z]+$', default: 'latest' })).toBe(true);
  });
});
