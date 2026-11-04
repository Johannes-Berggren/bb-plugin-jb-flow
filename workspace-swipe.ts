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
 * vertical events (scrolling the list) never count. After a step, the
 * trackpad's momentum keeps sending ever smaller events; those can't switch
 * again. A new gesture starts after `quietMs` without wheel events, or as soon
 * as the sideways movement grows again or reverses, so a quick second swipe
 * isn't swallowed by the first one's momentum.
 */
export function createSwipeTracker({ threshold = 100, quietMs = 250 } = {}) {
  let sum = 0;
  let locked = false;
  let last = Number.NEGATIVE_INFINITY;
  // While locked: the largest and smallest sideways step since the switch, and its direction.
  let largest = 0;
  let smallest = Number.POSITIVE_INFINITY;
  let lockedDirection = 0;
  return (event: WheelLike): 1 | -1 | 0 => {
    if (event.timeStamp - last > quietMs) {
      sum = 0;
      locked = false;
    }
    last = event.timeStamp;
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return 0;
    const size = Math.abs(event.deltaX);
    if (locked) {
      const reversed = Math.sign(event.deltaX) === -lockedDirection && size > 4;
      // Only once the momentum has clearly slowed: a swipe that speeds up isn't a new one.
      const slowed = smallest < largest / 2;
      const growing = slowed && size > smallest * 2 + 4;
      if (!reversed && !growing) {
        largest = Math.max(largest, size);
        smallest = Math.min(smallest, size);
        return 0;
      }
      locked = false;
      sum = 0;
    }
    sum += event.deltaX;
    if (Math.abs(sum) < threshold) return 0;
    const direction = sum > 0 ? 1 : -1;
    locked = true;
    lockedDirection = direction;
    largest = size;
    smallest = size;
    sum = 0;
    return direction;
  };
}
