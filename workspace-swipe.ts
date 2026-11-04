// Two-finger horizontal swipes on the sidebar step through the workspace tabs,
// apart from React so they can be tested.

/** A workspace tab: a workspace id, null for All, or "unassigned". */
export type SwipeTab = string | null;

/** The tab one step left (-1) or right (1) of `selected`; undefined at either end. */
export function swipeTarget(order: readonly SwipeTab[], selected: SwipeTab, direction: 1 | -1): SwipeTab | undefined {
  const index = order.indexOf(selected);
  if (index === -1) return undefined;
  const next = index + direction;
  return next >= 0 && next < order.length ? order[next] : undefined;
}

type WheelLike = { deltaX: number; deltaY: number; timeStamp: number };

/**
 * Turns a stream of wheel events into at most one step per gesture. Mostly
 * vertical events (scrolling the list) never count. A gesture ends after
 * `quietMs` without wheel events, so the trackpad's momentum after you lift
 * your fingers can't switch a second time.
 */
export function createSwipeTracker({ threshold = 100, quietMs = 250 } = {}) {
  let sum = 0;
  let locked = false;
  let last = Number.NEGATIVE_INFINITY;
  return (event: WheelLike): 1 | -1 | 0 => {
    if (event.timeStamp - last > quietMs) {
      sum = 0;
      locked = false;
    }
    last = event.timeStamp;
    if (locked || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return 0;
    sum += event.deltaX;
    if (Math.abs(sum) < threshold) return 0;
    locked = true;
    const direction = sum > 0 ? 1 : -1;
    sum = 0;
    return direction;
  };
}
