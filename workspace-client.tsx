import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { BbNavigate, PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { EMPTY_WORKSPACES, inWorkspace, type WorkspaceState } from "./workspaces";

type Snapshot = { state: WorkspaceState; ready: boolean; error: string | null };
let snapshot: Snapshot = { state: EMPTY_WORKSPACES, ready: false, error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let again = false;
function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useWorkspaces() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const current = useSyncExternalStore(subscribe, () => snapshot);
  const refresh = useCallback((): Promise<void> => {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = rpc
      .call("workspaces_get", null)
      .then(
        (state) => publish({ state, ready: true, error: null }),
        (cause: unknown) =>
          publish({ ...snapshot, error: cause instanceof Error ? cause.message : String(cause) }),
      )
      .finally(() => {
        inflight = null;
        if (again) {
          again = false;
          void refresh();
        }
      });
    return inflight;
  }, [rpc]);
  useEffect(() => {
    if (!snapshot.ready) void refresh();
  }, [refresh]);
  useRealtime("jb-flow-changed", () => {
    void refresh();
  });
  useEffect(() => {
    if (connection === "connected") void refresh();
  }, [connection, refresh]);
  return { ...current, rpc, refresh };
}

const selectionListeners = new Set<() => void>();
let selection: string | null = null;
try {
  selection = sessionStorage.getItem("jb-flow-workspace");
} catch {
  /* Storage can be unavailable in private windows. */
}
export function selectWorkspace(id: string | null) {
  selection = id;
  try {
    if (id === null) sessionStorage.removeItem("jb-flow-workspace");
    else sessionStorage.setItem("jb-flow-workspace", id);
  } catch {
    /* Keep the in-memory selection. */
  }
  for (const listener of selectionListeners) listener();
}
// The Workspaces setting (off by default). While off, everything behaves as
// "All": no filtering anywhere, whatever was selected before.
let workspacesEnabled = false;
export function setWorkspacesEnabled(enabled: boolean) {
  if (workspacesEnabled === enabled) return;
  workspacesEnabled = enabled;
  for (const listener of selectionListeners) listener();
}
export function useSelectedWorkspace() {
  return useSyncExternalStore(
    (listener) => {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
    () => (workspacesEnabled ? selection : null),
  );
}
export function rememberWorkspaceThread(workspaceId: string | null, threadId: string) {
  try {
    sessionStorage.setItem(`jb-flow-workspace-last:${workspaceId ?? "all"}`, threadId);
  } catch {
    /* Navigation works without persistence. */
  }
}
export function lastWorkspaceThread(workspaceId: string | null): string | null {
  try {
    return sessionStorage.getItem(`jb-flow-workspace-last:${workspaceId ?? "all"}`);
  } catch {
    return null;
  }
}

/**
 * Selects a workspace and lands somewhere useful in it: the thread you last had
 * open there, otherwise a new thread in its first project. The top bar and the
 * palette both switch this way.
 */
export function switchWorkspace(
  id: string | null,
  {
    state,
    threads,
    projects,
    currentThreadId,
    navigate,
  }: {
    state: WorkspaceState;
    threads: readonly PluginSidebarThread[];
    projects: readonly Pick<PluginSidebarProject, "id">[];
    currentThreadId: string | null;
    navigate: Pick<BbNavigate, "toThread" | "toCompose">;
  },
) {
  if (currentThreadId) rememberWorkspaceThread(workspacesEnabled ? selection : null, currentThreadId);
  selectWorkspace(id);
  const last = lastWorkspaceThread(id);
  const thread = threads.find(
    (thread) =>
      thread.id === last &&
      !thread.isArchived &&
      !thread.isHidden &&
      inWorkspace(thread, id, state, threads),
  );
  if (thread) {
    navigate.toThread(thread.id);
    return;
  }
  const workspace = state.workspaces.find((workspace) => workspace.id === id);
  const projectId = workspace?.projectIds.find((projectId) =>
    projects.some((project) => project.id === projectId),
  );
  navigate.toCompose({ ...(projectId ? { projectId } : {}), focusPrompt: true });
}
