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
 * child). Nothing under a folded thread shows, and with `shown` (a filter's
 * matches, see `withMatches`) nothing outside it. A broken parent chain can't loop.
 */
export function subthreadRows<T extends Node>(
  threadId: string,
  children: ReadonlyMap<string, readonly T[]>,
  folded: (threadId: string) => boolean,
  shown?: ReadonlySet<string>,
): Array<{ thread: T; depth: number }> {
  const rows: Array<{ thread: T; depth: number }> = [];
  const seen = new Set([threadId]);
  const visit = (id: string, depth: number) => {
    if (folded(id)) return;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id) || (shown && !shown.has(child.id))) continue;
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

/** Each top-level row's thread followed by everything under it, keyed by the top-level row's id. */
export function treesOf<T extends Node>(roots: readonly T[], children: ReadonlyMap<string, readonly T[]>): Map<string, T[]> {
  return new Map(roots.map((root) => [root.id, [root, ...descendants(root.id, children)]]));
}

/** The top-level row each thread sits under, by thread id (a top-level row maps to itself). */
export function rootIds<T extends Node>(trees: ReadonlyMap<string, readonly T[]>): Map<string, string> {
  const roots = new Map<string, string>();
  for (const [rootId, members] of trees) for (const member of members) roots.set(member.id, rootId);
  return roots;
}

/**
 * With a filter on, the threads to show: every match, and every thread above a
 * match so it keeps its place under its parent. A top-level row shows when it's
 * in here; a subthread row only when it is too.
 */
export function withMatches<T extends Node>(trees: ReadonlyMap<string, readonly T[]>, matches: (thread: T) => boolean): Set<string> {
  const shown = new Set<string>();
  for (const members of trees.values()) {
    const byId = new Map(members.map((member) => [member.id, member]));
    for (const member of members) {
      if (!matches(member)) continue;
      // Walk up to the top-level row; stop at one already shown (its parents are too).
      for (let at: T | undefined = member; at && !shown.has(at.id); at = at.parentThreadId === null ? undefined : byId.get(at.parentThreadId)) {
        shown.add(at.id);
      }
    }
  }
  return shown;
}

/** The fold state for a thread's subthreads, in the list's collapse store. */
export const foldKey = (threadId: string) => `subthreads:${threadId}`;

/**
 * The collapse store without fold state for threads that are gone (deleted, or
 * archived out of the list), or null when nothing needs to go.
 */
export function pruneFolds(stored: Readonly<Record<string, boolean>>, exists: (threadId: string) => boolean): Record<string, boolean> | null {
  const prefix = foldKey("");
  const gone = Object.keys(stored).filter((key) => key.startsWith(prefix) && !exists(key.slice(prefix.length)));
  if (gone.length === 0) return null;
  const next = { ...stored };
  for (const key of gone) delete next[key];
  return next;
}

/**
 * What ← or → does on a row, as in a tree view: fold or unfold its subthreads,
 * or, on a subthread with nothing left to fold, move up to its parent.
 */
export function arrowAction(
  key: "ArrowLeft" | "ArrowRight",
  row: { subthreads: { folded: boolean } | undefined; hasParent: boolean },
): "fold" | "unfold" | "parent" | null {
  const open = row.subthreads !== undefined && !row.subthreads.folded;
  if (key === "ArrowRight") return row.subthreads?.folded ? "unfold" : null;
  if (open) return "fold";
  return row.hasParent ? "parent" : null;
}

/**
 * Every thread in these rows' trees, each with the row it sits under (itself for
 * a row): rows in the order given, each followed by its subthreads depth first.
 * A subthread goes with its row's pin, snooze and workspace, so callers ask the row.
 */
export function withRows<T extends Node>(rows: readonly T[], trees: ReadonlyMap<string, readonly T[]>): Array<{ thread: T; row: T }> {
  return rows.flatMap((row) => (trees.get(row.id) ?? [row]).map((thread) => ({ thread, row })));
}

/**
 * A flat thread list as the Triage list draws it: its rows (`topLevel`), each
 * row's tree (`treesOf`) and every thread with its row (`withRows`). Subthreads
 * keep the order given. For the server and the workspace tabs, which start from
 * a plain list.
 */
export function forest<T extends Node>(threads: readonly T[]) {
  const rows = topLevel(threads);
  const trees = treesOf(rows, childrenByParent(threads));
  return { rows, trees, members: withRows(rows, trees) };
}

/**
 * Ids in the order a list that draws subthreads under their row shows them:
 * grouped by row, the rows in the order their first id comes up, and each row's
 * ids in tree order (the row, then its subthreads depth first). Ids outside
 * every tree keep their place. Duplicates go.
 */
export function inRowOrder<T extends Node>(ids: readonly string[], trees: ReadonlyMap<string, readonly T[]>): string[] {
  const place = new Map<string, { rowId: string; index: number }>();
  for (const [rowId, members] of trees) members.forEach((member, index) => place.set(member.id, { rowId, index }));
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const key = place.get(id)?.rowId ?? id;
    const group = groups.get(key);
    if (!group) groups.set(key, [id]);
    else if (!group.includes(id)) group.push(id);
  }
  return [...groups.values()].flatMap((group) => group.sort((a, b) => (place.get(a)?.index ?? 0) - (place.get(b)?.index ?? 0)));
}
