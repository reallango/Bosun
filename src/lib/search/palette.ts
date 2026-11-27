/**
 * Matching and ranking for the command palette. Pure, so the keyboard and network parts of the palette stay apart
 * from the rule for what a query finds.
 */

export type PaletteKind = 'dashboard' | 'server' | 'settings' | 'screen';

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  label: string;
  /** A short second line (a group, a host, a dashboard name). */
  detail?: string;
  href: string;
  /** Words that should match too (a settings group, a host name). */
  keywords?: string[];
}

const KIND_ORDER: Record<PaletteKind, number> = { dashboard: 0, server: 1, settings: 2, screen: 3 };

const normalize = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

/** How well one query word matches `text`, or null when it is not a subsequence. */
function scoreToken(token: string, text: string): number | null {
  const t = normalize(text);
  let at = 0;
  let previous = -2;
  let score = 0;
  for (const ch of token) {
    const index = t.indexOf(ch, at);
    if (index === -1) return null;
    score += 1;
    if (index === 0) score += 8;
    else if (!/[a-z0-9]/.test(t[index - 1])) score += 6;
    if (index === previous + 1) score += 4;
    if (index === at) score += 2;
    previous = index;
    at = index + 1;
  }
  // A match in a short label is more meaningful than the same match in a long one.
  return score + Math.max(0, 12 - Math.floor(t.length / 6));
}

/**
 * Score an item against a query. Every word must match the label, the detail or a keyword; words may match different
 * fields. Higher is better; null means the item does not match at all.
 */
export function matchScore(query: string, item: PaletteItem): number | null {
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let total = 0;
  for (const token of tokens) {
    const scores: number[] = [];
    const label = scoreToken(token, item.label);
    if (label !== null) scores.push(label);
    if (item.detail) {
      const detail = scoreToken(token, item.detail);
      if (detail !== null) scores.push(detail * 0.6);
    }
    for (const keyword of item.keywords ?? []) {
      const keywordScore = scoreToken(token, keyword);
      if (keywordScore !== null) scores.push(keywordScore * 0.5);
    }
    if (scores.length === 0) return null;
    total += Math.max(...scores);
  }
  return total;
}

/** The items a query finds, best first. An empty query keeps the caller's order. */
export function searchPalette(items: PaletteItem[], query: string, limit = 30): PaletteItem[] {
  if (normalize(query).trim() === '') return items.slice(0, limit);

  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    const score = matchScore(query, item);
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) =>
    b.score - a.score
    || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind]
    || a.item.label.length - b.item.label.length
    || a.item.label.localeCompare(b.item.label)
    || a.item.id.localeCompare(b.item.id)
  );
  return scored.slice(0, limit).map(s => s.item);
}
