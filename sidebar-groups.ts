// Ordering and grouping for the Triage list's rows, apart from React so they can be tested.

/** Newest first, by last activity or (so rows don't jump when read) by creation. */
export function sortRows<T extends { createdAt: number; updatedAt: number }>(threads: T[], byCreation: boolean): T[] {
  return [...threads].sort((a, b) => (byCreation ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt));
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

/**
 * How long since a thread last wanted attention. Reading a thread moves
 * `updatedAt`, so that says nothing about how long it has really been quiet.
 */
export function quietFor(thread: { latestAttentionAt: number | null; updatedAt: number }, now: number): number {
  return now - (thread.latestAttentionAt ?? thread.updatedAt);
}

/**
 * Unfiled, top-level threads that have been quiet for at least `staleDays`, quietest
 * first. Counted with quietFor, so opening a thread doesn't hold it back for another
 * stretch without anything having happened in it.
 */
export function staleThreads<
  T extends {
    id: string;
    sectionId: string | null;
    parentThreadId: string | null;
    pinnedAt: number | null;
    status: string;
    latestAttentionAt: number | null;
    updatedAt: number;
  },
>(threads: readonly T[], options: { now: number; staleMs: number; keptUntil: Readonly<Record<string, number>>; snoozed: Readonly<Record<string, unknown>> }): T[] {
  return threads
    .filter(
      (thread) =>
        thread.sectionId === null &&
        thread.parentThreadId === null &&
        thread.pinnedAt === null &&
        thread.status !== "active" &&
        options.snoozed[thread.id] === undefined &&
        (options.keptUntil[thread.id] ?? 0) < options.now &&
        quietFor(thread, options.now) > options.staleMs,
    )
    .sort((a, b) => quietFor(b, options.now) - quietFor(a, options.now));
}

