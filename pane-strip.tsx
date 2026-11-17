import { useEffect, useMemo, useState } from "react";
import {
  useBbNavigate,
  useSettings,
  useSidebarSplitLayout,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { workspaceColor, workspaceForThread, type WorkspaceState } from "./workspaces";
import { PANE_STATE_LABEL, paneInView, paneOrder, paneState, splitViewport } from "./pane-strip-model";
import "./pane-strip.css";

/** BB's element around the split panes, the one the scrolling split scrolls. */
const SCROLLER = "#split-workspace-main-panel > div";

/** Which part of the split is in view; null while it all fits or isn't scrolling. */
function useSplitViewport(paneCount: number) {
  const [viewport, setViewport] = useState<{ left: number; right: number } | null>(null);
  useEffect(() => {
    if (paneCount < 2) {
      setViewport(null);
      return;
    }
    let scroller: HTMLElement | null = null;
    let sizes: ResizeObserver | null = null;
    const read = () => {
      const next = scroller ? splitViewport(scroller) : null;
      setViewport((current) => (current?.left === next?.left && current?.right === next?.right ? current : next));
    };
    // After BB has laid the panes out for this layout.
    const frame = requestAnimationFrame(() => {
      scroller = document.querySelector<HTMLElement>(SCROLLER);
      if (!scroller) return;
      scroller.addEventListener("scroll", read, { passive: true });
      if (typeof ResizeObserver !== "undefined") {
        sizes = new ResizeObserver(read);
        sizes.observe(scroller);
        if (scroller.firstElementChild) sizes.observe(scroller.firstElementChild);
      }
      read();
    });
    return () => {
      cancelAnimationFrame(frame);
      scroller?.removeEventListener("scroll", read);
      sizes?.disconnect();
    };
  }, [paneCount]);
  return viewport;
}

/**
 * One chip per open split pane, in the workspace bar: its workspace's color,
 * the thread's title and what it is doing. Chips of panes scrolled out of view
 * are dimmed, and clicking one goes to its pane.
 */
export function PaneStrip({ state, threads }: { state: WorkspaceState; threads: readonly PluginSidebarThread[] }) {
  const enabled = useSettings().values?.paneStrip === true;
  const split = useSidebarSplitLayout();
  const navigate = useBbNavigate();
  const panes = useMemo(() => (enabled && split ? paneOrder(split.panes) : []), [enabled, split]);
  const viewport = useSplitViewport(panes.length);
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  if (panes.length < 2) return null;
  return (
    <div className="jf-pane-strip" role="toolbar" aria-label="Open panes">
      {panes.map((pane) => {
        const thread = pane.threadId === null ? undefined : byId.get(pane.threadId);
        const inView = paneInView(pane.rect, viewport);
        if (!thread)
          return (
            // A pane that shows a page, not a thread: it keeps its place in the row.
            <span key={pane.paneId} className="jf-pane-chip" data-in-view={inView || undefined} aria-current={pane.isFocused ? "true" : undefined} title="Page">
              <i className="jf-pane-chip-state" data-state="idle" aria-hidden="true" />
            </span>
          );
        const status = paneState(thread);
        const title = `${thread.displayTitle}: ${PANE_STATE_LABEL[status]}${inView ? "" : ", out of view"}`;
        return (
          <button
            type="button"
            key={pane.paneId}
            className="jf-pane-chip"
            data-jf-color={workspaceColor(workspaceForThread(thread, state, threads), state.workspaces)}
            data-in-view={inView || undefined}
            aria-current={pane.isFocused ? "true" : undefined}
            aria-label={title}
            title={title}
            onClick={() => navigate.toThread(thread.id, { split: true })}
          >
            <i className="jf-pane-chip-state" data-state={status} aria-hidden="true" />
            <span className="jf-pane-chip-title">{thread.displayTitle}</span>
          </button>
        );
      })}
    </div>
  );
}
