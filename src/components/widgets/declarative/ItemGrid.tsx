'use client';

import type { CSSProperties, ReactNode, Ref } from 'react';
import { useMeasuredSize } from '@/components/dashboard/widget-size';
import { balancedArrangement, gridTemplate, MIN_ITEM_WIDTH_PX, type Arrangement, type ArrangementKind } from '@/lib/widgets/runtime/arrangement';
import type { MinItemWidth } from '@/lib/widgets/runtime/sizing';

/** The cell gap of a filling grid in px: the comfortable and the compact spacing (gap-2 and 0.375rem). */
export const ITEM_GAP_PX = 8;
export const ITEM_GAP_COMPACT_PX = 6;

export interface ItemGridBoxProps {
  /** The measured arrangement; null before the box is measured, and when the block fixes its own columns. */
  arrangement: Arrangement | null;
  /** The cell gap in px; without it the class keeps its own gap. */
  gap?: number;
  className: string;
  children?: ReactNode;
  innerRef?: Ref<HTMLDivElement>;
}

/** The grid element of a stat or gauge block: the arrangement sets its template, the class sets everything else. */
export function ItemGridBox({ arrangement, gap, className, children, innerRef }: ItemGridBoxProps) {
  const style: CSSProperties = {
    ...(arrangement ? gridTemplate(arrangement) : {}),
    ...(gap !== undefined ? { gap } : {}),
  };
  return <div ref={innerRef} className={className} style={Object.keys(style).length ? style : undefined}>{children}</div>;
}

export interface ItemGridProps {
  /** Inside a widget, filling its body (a dialog or page keeps the reading layout). */
  fill: boolean;
  /** A fixed column count from the block, which wins over the arrangement. */
  columns?: number;
  minItemWidth?: MinItemWidth;
  kind: ArrangementKind;
  /** How many items actually render (after `when` and `alternatives`). */
  count: number;
  /** The widest value of the block, in characters: a tile is never narrower than it needs at the readable floor. */
  valueChars: number;
  compact: boolean;
  className: string;
  children: ReactNode;
}

/**
 * A stat or gauge grid that fills a widget: it measures its own box and lays the items out in the balanced arrangement for
 * that box, so the tiles or rings rearrange as the widget is resized. Before the first measurement, and whenever the block
 * fixes a `columns` count, the class alone decides the layout.
 */
export function ItemGrid({ fill, columns, minItemWidth, kind, count, valueChars, compact, className, children }: ItemGridProps) {
  const { ref, info } = useMeasuredSize<HTMLDivElement>();
  const gap = compact ? ITEM_GAP_COMPACT_PX : ITEM_GAP_PX;
  const arrangement = fill && !columns && info.width > 0 && info.height > 0
    ? balancedArrangement(count, info.width, info.height, kind, gap, { minItemWidth: MIN_ITEM_WIDTH_PX[minItemWidth ?? 'md'], valueChars })
    : null;
  return <ItemGridBox innerRef={ref} arrangement={arrangement} gap={fill ? gap : undefined} className={className}>{children}</ItemGridBox>;
}
