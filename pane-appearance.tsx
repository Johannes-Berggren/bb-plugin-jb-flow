import { useEffect, useMemo } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useSettings,
  useSidebarSplitLayout,
} from "@get-bb/plugin-sdk/app";
import { useWorkspaces } from "./workspace-client";
import { workspaceColor, workspaceForThread, type WorkspaceColor } from "./workspaces";
import "./pane-appearance.css";

const PANE_CLASS = "jb-flow-active-pane";
const PANE_EVENT = "jb-flow-pane-appearance";

/** Owns the class that switches the pane styling on. Off until the preference says otherwise. */
export function mountPaneAppearance({ signal }: { signal: AbortSignal }) {
  if (signal.aborted) return;
  const root = document.documentElement;
  const update = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (typeof detail === "boolean") root.classList.toggle(PANE_CLASS, detail);
  };
  window.addEventListener(PANE_EVENT, update, { signal });
  const cleanup = () => root.classList.remove(PANE_CLASS);
  signal.addEventListener("abort", cleanup, { once: true });
  return () => {
    cleanup();
    window.removeEventListener(PANE_EVENT, update);
    signal.removeEventListener("abort", cleanup);
  };
}

type Pane = { paneId: string; threadId: string | null };

/** One rule per pane that has a workspace color; BB's own nodes are never written to. */
export function paneColorRules(panes: readonly Pane[], colorOf: (threadId: string) => WorkspaceColor | undefined): string {
  return panes
    .flatMap((pane) => {
      const color = pane.threadId === null ? undefined : colorOf(pane.threadId);
      if (!color) return [];
      const id = pane.paneId.replace(/["\\]/g, "\\$&");
      return [`.${PANE_CLASS} [data-split-pane-id="${id}"]{--jf-pane-color:var(--jf-ws-${color})}`];
    })
    .join("\n");
}

/** Frames the active pane while a split is open, and gives every pane its workspace's color. */
export function PaneAppearancePreference() {
  const { values, isLoading } = useSettings();
  const split = useSidebarSplitLayout();
  const { state } = useWorkspaces();
  const { threads } = useSidebarThreads();
  const enabled = values?.highlightActivePane === true && split !== null && split.panes.length > 1;
  const colored = enabled && values?.workspaces === true;
  useEffect(() => {
    if (!isLoading) window.dispatchEvent(new CustomEvent(PANE_EVENT, { detail: enabled }));
  }, [enabled, isLoading]);
  const rules = useMemo(() => {
    if (!colored || split === null) return "";
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    return paneColorRules(split.panes, (threadId) => {
      const thread = byId.get(threadId);
      return thread ? workspaceColor(workspaceForThread(thread, state, threads), state.workspaces) : undefined;
    });
  }, [colored, split, threads, state]);
  return rules === "" ? null : <style data-jf-pane-colors="">{rules}</style>;
}
