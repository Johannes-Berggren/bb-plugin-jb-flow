// The arithmetic behind the scrolling split, apart from the DOM so it can be tested.

/** A pane's place in the split, as fractions of the split area (BB's own layout). */
export type SplitPaneRect = { x: number; width: number };

/** BB opens at most this many panes; the strip never needs to be wider than that many minimums. */
const MAX_PANES = 8;
export const DEFAULT_MIN_PANE_WIDTH = 640;

/** The setting as a usable width: whole pixels between 320 and 1600. */
export function minPaneWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MIN_PANE_WIDTH;
  return Math.round(Math.min(1600, Math.max(320, value)));
}

/**
 * How wide the split must be for its narrowest pane to reach `minPx`, keeping
 * the proportions BB already has. Null when there is no split to scroll. As a
 * min-width it only takes effect when the window is narrower than this.
 */
export function requiredSplitWidth(panes: readonly { rect: SplitPaneRect }[], minPx: number): number | null {
  if (panes.length < 2) return null;
  const narrowest = Math.min(...panes.map((pane) => pane.rect.width));
  if (!(narrowest > 0)) return null;
  // A sliver in a nested split would otherwise ask for a strip many screens wide.
  return Math.round(Math.min(minPx / Math.min(1, narrowest), MAX_PANES * minPx));
}

/**
 * Where the strip should scroll to so the pane is in view: unchanged when it
 * already is, otherwise the nearest position showing it whole, or its left
 * edge when it is wider than the view.
 */
export function revealScrollLeft({
  x,
  width,
  scrollWidth,
  clientWidth,
  scrollLeft,
}: SplitPaneRect & { scrollWidth: number; clientWidth: number; scrollLeft: number }): number {
  const max = Math.max(0, scrollWidth - clientWidth);
  const left = x * scrollWidth;
  const right = (x + width) * scrollWidth;
  let target = scrollLeft;
  if (left < scrollLeft || right - left > clientWidth) target = left;
  else if (right > scrollLeft + clientWidth) target = right - clientWidth;
  return Math.round(Math.min(max, Math.max(0, target)));
}
