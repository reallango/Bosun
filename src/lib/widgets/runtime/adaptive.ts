/**
 * Adaptive items: a stat tile, a ring gauge or a meter row may carry `when`, and an item may list `alternatives`
 * that are tried in order. That covers "show the errors when there are any, else the average uptime" and "one mount:
 * show the throughput, several: show the fullest" without Bosun knowing the widget. Pure (no I/O).
 */
import { evalCond, type Cond } from './spec';
import type { InfoItem } from './spec-v2';
import type { ViewContext } from './layout';

/** An item that may hide itself and name fallbacks. */
export interface AdaptiveItem {
  when?: Cond;
  alternatives?: AdaptiveItem[];
}

/**
 * The item to draw: the item itself while its `when` holds (or it has none), otherwise the first alternative that
 * does, tried depth first. Null when nothing holds, so the caller leaves the item out.
 */
export function pickAdaptive<T extends { when?: Cond; alternatives?: T[] }>(item: T, ctx: ViewContext): T | null {
  if (!item.when || evalCond(item.when, ctx)) return item;
  for (const alternative of item.alternatives ?? []) {
    const picked = pickAdaptive(alternative, ctx);
    if (picked) return picked as T;
  }
  return null;
}

/** The `label value` pairs of an info line whose `when` holds (in the order written). */
export function visibleInfo(items: readonly InfoItem[], ctx: ViewContext): InfoItem[] {
  return items.filter(item => !item.when || evalCond(item.when, ctx));
}

/** The text of an info line: `Label value · Label value`, or an empty string when no pair is shown. */
export function infoLineText(items: readonly InfoItem[], ctx: ViewContext, valueOf: (template: string) => string): string {
  return visibleInfo(items, ctx).map(item => `${item.label} ${valueOf(item.value)}`.trim()).join(' · ');
}
