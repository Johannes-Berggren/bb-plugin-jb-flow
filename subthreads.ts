// Subthreads in the Triage list: threads an agent spawned under another, or forked from it.
// Apart from React so they can be tested.

type Node = { id: string; parentThreadId: string | null };

/**
 * The threads that get a row of their own: no parent, or a parent that isn't
 * in the list (archived, hidden or in another workspace), so no thread is lost.
 */
export function topLevel<T extends Node>(threads: readonly T[]): T[] {
  const ids = new Set(threads.map((thread) => thread.id));
  return threads.filter((thread) => thread.parentThreadId === null || !ids.has(thread.parentThreadId));
}

/** Each parent's children among `threads`, in the order given. */
export function childrenByParent<T extends Node>(threads: readonly T[]): Map<string, T[]> {
  const ids = new Set(threads.map((thread) => thread.id));
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null || !ids.has(thread.parentThreadId)) continue;
    const siblings = children.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else children.set(thread.parentThreadId, [thread]);
  }
  return children;
}

/**
 * The rows under a thread, depth first, each with its depth below it (1 for a
 * child). Nothing under a folded thread shows. A broken parent chain can't loop.
 */
export function subthreadRows<T extends Node>(
  threadId: string,
  children: ReadonlyMap<string, readonly T[]>,
  folded: (threadId: string) => boolean,
): Array<{ thread: T; depth: number }> {
  const rows: Array<{ thread: T; depth: number }> = [];
  const seen = new Set([threadId]);
  const visit = (id: string, depth: number) => {
    if (folded(id)) return;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      rows.push({ thread: child, depth });
      visit(child.id, depth + 1);
    }
  };
  visit(threadId, 1);
  return rows;
}

/** Every thread under this one, at any depth. */
export function descendants<T extends Node>(threadId: string, children: ReadonlyMap<string, readonly T[]>): T[] {
  return subthreadRows(threadId, children, () => false).map((row) => row.thread);
}
