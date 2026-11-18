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

/**
 * `yourMove`: the thread's last message asks you something and you haven't
 * answered, read or not (Your move in the Triage list). It waits on you like a
 * question does, so it gets the same dot.
 */
export function paneState(thread: StripThread, yourMove = false): PaneState {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return "needs-you";
  if (thread.status === "error" || thread.indicator === "unread-error") return "error";
  const background = thread.activity
    ? thread.activity.workflows + thread.activity.backgroundAgents + thread.activity.backgroundCommands
    : 0;
  if (thread.status !== "idle" || background > 0) return "working";
  if (yourMove) return "needs-you";
  return thread.isUnread ? "unread" : "idle";
}

/**
 * Idle with a last message that asks you something, and no answer of yours
 * already queued: the Triage list's Your move and Needs me, read or unread.
 */
export function awaitsYou(
  thread: { id: string; status: string; queuedWork?: string },
  awaiting: Readonly<Record<string, number>> | undefined,
): boolean {
  return thread.status === "idle" && awaiting?.[thread.id] !== undefined && thread.queuedWork !== "waiting";
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

export type EdgeHint = {
  /** Panes mostly beyond this edge. */
  count: number;
  /** How many of them wait on you. */
  needsYou: number;
  /** The pane to scroll to: the nearest one that waits on you, else the nearest one. */
  target: { x: number; width: number };
};

/**
 * What lies beyond each edge of a split that scrolls: how many panes, how many
 * of them wait on you, and which one a click should bring into view. Null for
 * an edge with nothing beyond it, and for both while everything fits.
 */
export function edgeHints(
  panes: readonly { rect: Pick<PaneRect, "x" | "width">; needsYou: boolean }[],
  viewport: { left: number; right: number } | null,
): { left: EdgeHint | null; right: EdgeHint | null } {
  if (viewport === null) return { left: null, right: null };
  const hidden = panes.filter((pane) => !paneInView(pane.rect, viewport));
  const centre = (pane: (typeof panes)[number]) => pane.rect.x + pane.rect.width / 2;
  const side = (beyond: typeof hidden, nearestFirst: (a: (typeof panes)[number], b: (typeof panes)[number]) => number): EdgeHint | null => {
    if (beyond.length === 0) return null;
    const sorted = [...beyond].sort(nearestFirst);
    const target = (sorted.find((pane) => pane.needsYou) ?? sorted[0]!).rect;
    return { count: beyond.length, needsYou: beyond.filter((pane) => pane.needsYou).length, target: { x: target.x, width: target.width } };
  };
  const middle = (viewport.left + viewport.right) / 2;
  return {
    left: side(hidden.filter((pane) => centre(pane) < middle), (a, b) => centre(b) - centre(a)),
    right: side(hidden.filter((pane) => centre(pane) >= middle), (a, b) => centre(a) - centre(b)),
  };
}
