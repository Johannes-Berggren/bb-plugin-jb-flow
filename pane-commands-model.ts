// The choices behind the pane commands, apart from React so they can be tested.

/** Commands can't render or use hooks; they send these and the pane commands host does the work. */
export const OPEN_QUEUE_EVENT = "jb-flow:open-queue-panes";
export const STATUS_PANES_EVENT = "jb-flow:status-panes";

/** BB opens at most this many panes in a split. */
export const MAX_PANES = 8;

/**
 * Which threads "Open what needs me side by side" opens: the queue in order,
 * without the ones already open, as many as the split still has room for.
 */
export function queuePicks(
  queue: readonly string[],
  openThreadIds: readonly (string | null)[],
  paneCount: number,
  maxPanes = MAX_PANES,
): string[] {
  const open = new Set(openThreadIds);
  const room = Math.max(0, maxPanes - Math.max(1, paneCount));
  return [...new Set(queue)].filter((id) => !open.has(id)).slice(0, room);
}
