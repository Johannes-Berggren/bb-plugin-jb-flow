// The Ctrl+Tab switcher's lists, apart from React so they can be tested:
// threads in the order you last viewed them, and workspace tabs in the order
// you last used them. The current one comes first, so a quick Ctrl+Tab lands
// on index 1: the one before it.

/** A workspace tab: a workspace id, null for All, or "unassigned" (same as the top bar's). */
export type WorkspaceTab = string | null;

export type SwitchThread = {
  id: string;
  isArchived: boolean;
  isHidden: boolean;
  updatedAt: number;
};

/**
 * Up to `limit` threads: the current one, then the ones you viewed most
 * recently, then (to fill the list, or when there's no history yet) the most
 * recently updated. Archived, hidden and unknown threads are left out.
 */
export function threadItems<T extends SwitchThread>(
  recent: readonly string[],
  threads: readonly T[],
  currentId: string | null,
  limit = 9,
): T[] {
  const usable = (thread: T | undefined): thread is T => thread !== undefined && !thread.isArchived && !thread.isHidden;
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const picked: T[] = [];
  const seen = new Set<string>();
  const add = (thread: T | undefined) => {
    if (picked.length >= limit || !usable(thread) || seen.has(thread.id)) return;
    seen.add(thread.id);
    picked.push(thread);
  };
  if (currentId !== null) add(byId.get(currentId));
  for (const id of recent) add(byId.get(id));
  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) add(thread);
  return picked;
}

/** The selected tab, then the ones you used most recently, then the rest in top-bar order. */
export function workspaceItems(
  recent: readonly WorkspaceTab[],
  order: readonly WorkspaceTab[],
  selected: WorkspaceTab,
): WorkspaceTab[] {
  const known = new Set(order);
  const items: WorkspaceTab[] = [];
  for (const tab of [selected, ...recent, ...order]) {
    if (known.has(tab) && !items.includes(tab)) items.push(tab);
  }
  return items;
}

/** Remembers `tab` as the most recently used workspace tab. */
export function pushRecentWorkspace(recent: readonly WorkspaceTab[], tab: WorkspaceTab, limit = 20): WorkspaceTab[] {
  return [tab, ...recent.filter((other) => other !== tab)].slice(0, limit);
}

/**
 * Where a fresh switcher starts. With the current item first, the one before it;
 * without one (a page that isn't a thread), the most recent, so it isn't skipped.
 */
export const startIndex = (length: number, currentFirst = true) => (currentFirst && length > 1 ? 1 : 0);

/** One step forward or back, wrapping at either end. */
export function step(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/** A tab's label in the switcher. */
export function workspaceLabel(tab: WorkspaceTab, workspaces: readonly { id: string; name: string }[]): string {
  if (tab === null) return "All";
  if (tab === "unassigned") return "No workspace";
  return workspaces.find((workspace) => workspace.id === tab)?.name ?? tab;
}

export type SwitcherKey = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean };

/** Which row a key opens the switcher on: Ctrl+Tab threads, Ctrl+` workspaces, anything else nothing. */
export function opensSwitcher(event: SwitcherKey): "threads" | "workspaces" | null {
  if (!event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === "Tab") return "threads";
  if (event.code === "Backquote") return "workspaces";
  return null;
}
