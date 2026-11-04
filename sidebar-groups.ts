// Ordering and grouping for the Triage list's rows, apart from React so they can be tested.

/** Newest first, by last activity or (so rows don't jump when read) by creation. */
export function sortRows<T extends { createdAt: number; updatedAt: number }>(threads: T[], byCreation: boolean): T[] {
  return [...threads].sort((a, b) => (byCreation ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt));
}

/**
 * Splits threads into one group per project, keeping their order inside each
 * group. Groups follow the project of their first (newest) thread.
 */
export function groupByProject<T extends { projectId: string }>(
  threads: readonly T[],
): Array<{ projectId: string; threads: T[] }> {
  const groups = new Map<string, T[]>();
  for (const thread of threads) {
    const group = groups.get(thread.projectId);
    if (group) group.push(thread);
    else groups.set(thread.projectId, [thread]);
  }
  return [...groups].map(([projectId, members]) => ({ projectId, threads: members }));
}

/**
 * Splits a filter's matches by section, in your section order, leaving out
 * sections with no matches. Matches in a section the order doesn't know go to
 * `loose`, so a filter never drops a thread.
 */
export function groupBySection<T>(
  members: readonly T[],
  orderedKeys: readonly string[],
  keyOf: (thread: T) => string,
): { sections: Array<{ key: string; threads: T[] }>; loose: T[] } {
  const known = new Set(orderedKeys);
  const sections = orderedKeys.flatMap((key) => {
    const threads = members.filter((thread) => keyOf(thread) === key);
    return threads.length > 0 ? [{ key, threads }] : [];
  });
  return { sections, loose: members.filter((thread) => !known.has(keyOf(thread))) };
}
