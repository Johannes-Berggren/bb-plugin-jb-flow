// The threads and workspace tabs you used most recently, kept in this
// browser's storage. The palette's Recent section and the Ctrl+Tab switcher
// read them; whichever is mounted keeps them up to date.
import { useEffect } from "react";
import { useBbContext, useSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
import { pushRecent } from "./palette-model";
import { pushRecentWorkspace, type WorkspaceTab } from "./tab-switcher-model";

const RECENT_THREADS_KEY = "jb-flow.palette.recent";
const RECENT_WORKSPACES_KEY = "jb-flow.workspaces.recent";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Works without persistence, just without history. */
  }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** Newest first. */
export const readRecentThreads = (): string[] => strings(readJson<unknown>(RECENT_THREADS_KEY, []));

/** Newest first; null is All. */
export function readRecentWorkspaces(): WorkspaceTab[] {
  const value = readJson<unknown>(RECENT_WORKSPACES_KEY, []);
  return Array.isArray(value) ? value.filter((item): item is WorkspaceTab => item === null || typeof item === "string") : [];
}

/**
 * The thread you're looking at: the focused split pane's, else the route's.
 * With splits, the route keeps the first pane's thread while you work in another.
 */
export function useCurrentThreadId(): string | null {
  const context = useBbContext();
  const layout = useSidebarSplitLayout();
  const focused = layout?.panes.find((pane) => pane.isFocused);
  return focused ? focused.threadId : context.threadId;
}

/** Remembers each thread you open or focus. Writing the same thread twice is harmless, so several callers may mount it. */
export function useRecentThreadsTracker() {
  const threadId = useCurrentThreadId();
  useEffect(() => {
    if (threadId) writeJson(RECENT_THREADS_KEY, pushRecent(readRecentThreads(), threadId));
  }, [threadId]);
}

/** Remembers each workspace tab you select. */
export function useRecentWorkspacesTracker(selected: WorkspaceTab, enabled: boolean) {
  useEffect(() => {
    if (enabled) writeJson(RECENT_WORKSPACES_KEY, pushRecentWorkspace(readRecentWorkspaces(), selected));
  }, [enabled, selected]);
}
