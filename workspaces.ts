import { z } from "zod";

const ids = z.array(z.string().min(1).max(160)).max(200);
export const workspaceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(60),
  projectIds: ids,
  sectionIds: ids,
  pluginIds: ids,
  sectionOrder: ids,
});
export const workspaceStateSchema = z.object({
  workspaces: z.array(workspaceSchema).max(30),
  threadWorkspaces: z.record(z.string(), z.string().nullable()),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
export const EMPTY_WORKSPACES: WorkspaceState = { workspaces: [], threadWorkspaces: {} };
export type WorkspaceThread = {
  id: string;
  projectId: string;
  sectionId: string | null;
  parentThreadId: string | null;
};

export function workspaceForThread(
  thread: WorkspaceThread,
  state: WorkspaceState,
  threads: readonly WorkspaceThread[] = [],
): string | null {
  const seen = new Set<string>();
  let current = thread;
  while (!seen.has(current.id)) {
    seen.add(current.id);
    if (Object.hasOwn(state.threadWorkspaces, current.id)) {
      const id = state.threadWorkspaces[current.id];
      return state.workspaces.some((workspace) => workspace.id === id) ? id! : null;
    }
    const parent =
      current.parentThreadId &&
      threads.find((candidate) => candidate.id === current.parentThreadId);
    if (!parent) break;
    current = parent;
  }
  return (
    state.workspaces.find((workspace) => workspace.sectionIds.includes(current.sectionId ?? ""))
      ?.id ??
    state.workspaces.find((workspace) => workspace.projectIds.includes(current.projectId))?.id ??
    null
  );
}

export function inWorkspace(
  thread: WorkspaceThread,
  selected: string | null,
  state: WorkspaceState,
  threads: readonly WorkspaceThread[] = [],
): boolean {
  return (
    selected === null ||
    workspaceForThread(thread, state, threads) === (selected === "unassigned" ? null : selected)
  );
}

export function pluginInWorkspace(
  pluginId: string | null,
  selected: string | null,
  state: WorkspaceState,
): boolean {
  if (pluginId === null || pluginId === "jb-flow" || selected === null || selected === "unassigned")
    return true;
  const owners = state.workspaces.filter((workspace) => workspace.pluginIds.includes(pluginId));
  return owners.length === 0 || owners.some((workspace) => workspace.id === selected);
}

/** A new install starts with no workspaces: All and Unassigned until you add your own. */
export function initialWorkspaces(_projects: readonly { id: string; name: string }[]): Workspace[] {
  return [];
}
