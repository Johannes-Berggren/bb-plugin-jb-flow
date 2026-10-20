import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { EMPTY_WORKSPACES, type WorkspaceState } from "./workspaces";

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
