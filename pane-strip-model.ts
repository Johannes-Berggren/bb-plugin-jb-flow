// What the pane strip shows for each open pane, apart from React so it can be tested.

export type PaneRect = { x: number; y: number; width: number; height: number };

/** What a pane's thread is doing, most urgent first. */
export type PaneState = "needs-you" | "error" | "working" | "unread" | "idle";

export const PANE_STATE_LABEL: Record<PaneState, string> = {
  "needs-you": "waiting on you",
  error: "stopped with an error",
  working: "working",
  unread: "finished, unread",
  idle: "idle",
};

type StripThread = {
  status: string;
  indicator: string;
  hasPendingInteraction: boolean;
  isUnread: boolean;
  activity?: { workflows: number; backgroundAgents: number; backgroundCommands: number };
};

export function paneState(thread: StripThread): PaneState {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return "needs-you";
  if (thread.status === "error" || thread.indicator === "unread-error") return "error";
  const background = thread.activity
    ? thread.activity.workflows + thread.activity.backgroundAgents + thread.activity.backgroundCommands
    : 0;
  if (thread.status !== "idle" || background > 0) return "working";
  return thread.isUnread ? "unread" : "idle";
}

/** Panes in reading order: left to right, and top to bottom within a column. */
export function paneOrder<Pane extends { rect: PaneRect }>(panes: readonly Pane[]): Pane[] {
  return [...panes].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
}

/** The part of the split in view, as fractions of its full width. Null while everything fits. */
export function splitViewport({
  scrollLeft,
  clientWidth,
  scrollWidth,
}: {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}): { left: number; right: number } | null {
  if (!(scrollWidth > clientWidth + 1)) return null;
  return { left: scrollLeft / scrollWidth, right: (scrollLeft + clientWidth) / scrollWidth };
}

/** In view when at least half of the pane's width is; everything is while nothing scrolls. */
export function paneInView(rect: Pick<PaneRect, "x" | "width">, viewport: { left: number; right: number } | null): boolean {
  if (viewport === null) return true;
  const shown = Math.min(rect.x + rect.width, viewport.right) - Math.max(rect.x, viewport.left);
  return shown >= rect.width / 2 - 1e-9;
}
