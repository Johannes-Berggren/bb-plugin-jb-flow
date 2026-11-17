// The arithmetic behind the scrolling split, apart from the DOM so it can be tested.

/** A pane's place in the split, as fractions of the split area (BB's own layout). */
export type SplitPaneRect = { x: number; y: number; width: number; height: number };

export const DEFAULT_MIN_PANE_WIDTH = 640;

/** The setting as a usable width: whole pixels between 320 and 1600. */
export function minPaneWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MIN_PANE_WIDTH;
  return Math.round(Math.min(1600, Math.max(320, value)));
}

/** How many panes sit side by side: the most that any horizontal line through the split crosses. */
export function splitColumns(panes: readonly { rect: SplitPaneRect }[]): number {
  let most = 0;
  for (const { rect } of panes) {
    // The busiest line always runs just below some pane's top edge.
    const line = rect.y + 1e-6;
    const crossed = panes.filter((pane) => pane.rect.y <= line && line < pane.rect.y + pane.rect.height).length;
    most = Math.max(most, crossed);
  }
  return most;
}

/**
 * How wide the split must be to give each column `minPx`. Null when there is
 * no split to scroll. It depends on the number of columns only, not on their
 * proportions, so dragging a divider never changes it: the panes you resize
 * are the only ones that move. As a min-width it only takes effect when the
 * window is narrower than this.
 */
export function requiredSplitWidth(panes: readonly { rect: SplitPaneRect }[], minPx: number): number | null {
  if (panes.length < 2) return null;
  const columns = splitColumns(panes);
  return columns > 0 ? columns * minPx : null;
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
}: Pick<SplitPaneRect, "x" | "width"> & { scrollWidth: number; clientWidth: number; scrollLeft: number }): number {
  const max = Math.max(0, scrollWidth - clientWidth);
  const left = x * scrollWidth;
  const right = (x + width) * scrollWidth;
  let target = scrollLeft;
  if (left < scrollLeft || right - left > clientWidth) target = left;
  else if (right > scrollLeft + clientWidth) target = right - clientWidth;
  return Math.round(Math.min(max, Math.max(0, target)));
}
