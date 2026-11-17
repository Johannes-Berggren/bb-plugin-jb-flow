import { z } from "zod";

const ids = z.array(z.string().min(1).max(160)).max(200);
/** The colors a workspace can carry. Each has a light and a dark value in workspaces.css. */
export const WORKSPACE_COLORS = ["red", "orange", "amber", "green", "teal", "blue", "violet", "pink"] as const;
export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];
/** The same colors as sRGB, for things outside BB's page that can't read its CSS, such as a key on a control deck. */
export const WORKSPACE_COLOR_HEX: Record<WorkspaceColor, string> = {
  red: "#f66d67",
  orange: "#f99549",
  amber: "#eabe4a",
  green: "#5dc879",
  teal: "#47c7c7",
  blue: "#65a7fa",
  violet: "#ac8ff8",
  pink: "#f780bc",
};
export const workspaceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(60),
  projectIds: ids,
  sectionIds: ids,
  pluginIds: ids,
  sectionOrder: ids,
  /** Split the unsectioned Active lane into one group per project. */
  groupByProject: z.boolean().optional(),
  /** Marks the workspace's tab and its split panes. Absent means no color. */
  color: z.enum(WORKSPACE_COLORS).optional(),
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

/** The color of the workspace with this id, if it has one. */
export function workspaceColor(
  id: string | null,
  workspaces: readonly Pick<Workspace, "id" | "color">[],
): WorkspaceColor | undefined {
  return id === null ? undefined : workspaces.find((workspace) => workspace.id === id)?.color;
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

/** A new install starts with no workspaces: All and No workspace until you add your own. */
export function initialWorkspaces(_projects: readonly { id: string; name: string }[]): Workspace[] {
  return [];
}
