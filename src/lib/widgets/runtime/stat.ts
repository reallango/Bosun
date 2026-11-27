/**
 * Stat tiles: which tone a tile takes. A tone is either fixed (`"warning"`) or a map of tones to conditions; the first
 * tone whose condition holds (in the order the spec gives) wins. Pure (no I/O), so the rule can be tested.
 */
import { evalCond } from './spec';
import type { StatItem, StatTone } from './spec-v2';
import type { ViewContext } from './layout';

export function statTone(tone: StatItem['tone'], ctx: ViewContext): StatTone | null {
  if (!tone) return null;
  if (typeof tone === 'string') return tone;
  for (const [name, condition] of Object.entries(tone)) {
    if (condition && evalCond(condition, ctx)) return name as StatTone;
  }
  return null;
}

export { withUnit } from './number-format';
