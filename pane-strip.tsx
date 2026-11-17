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

/** When to look again after a layout change: BB draws the split, and the scrolling split sizes it, a little later. */
const LOOK_AGAIN_MS = [0, 100, 400, 1200];

/** Which part of the split is in view; null while it all fits or isn't scrolling. */
function useSplitViewport(layout: string | null) {
  const [viewport, setViewport] = useState<{ left: number; right: number } | null>(null);
  useEffect(() => {
    if (layout === null) {
      setViewport(null);
      return;
    }
    const read = () => {
      const scroller = document.querySelector<HTMLElement>(SCROLLER);
      const next = scroller ? splitViewport(scroller) : null;
      setViewport((current) => (current?.left === next?.left && current?.right === next?.right ? current : next));
    };
    // Scroll events don't bubble, but they can be caught on the way down, so
    // this works whenever BB creates or replaces the scrolled element.
    const scrolled = (event: Event) => {
      if (event.target instanceof Element && event.target.matches(SCROLLER)) read();
    };
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    window.addEventListener("resize", read);
    const timers = LOOK_AGAIN_MS.map((ms) => window.setTimeout(read, ms));
    return () => {
      document.removeEventListener("scroll", scrolled, { capture: true });
      window.removeEventListener("resize", read);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [layout]);
  return viewport;
}

/**
 * One chip per open split pane, in the workspace bar: its workspace's color,
 * the thread's title and what it is doing. The chips of the panes on screen are
 * lit, and clicking one goes to its pane.
 */
export function PaneStrip({ state, threads }: { state: WorkspaceState; threads: readonly PluginSidebarThread[] }) {
  const enabled = useSettings().values?.paneStrip === true;
  const split = useSidebarSplitLayout();
  const navigate = useBbNavigate();
  const panes = useMemo(() => (enabled && split ? paneOrder(split.panes) : []), [enabled, split]);
  // Any change of the layout can move what is in view, a divider drag included.
  const layout = panes.length < 2 ? null : panes.map((pane) => `${pane.paneId}:${pane.rect.x}:${pane.rect.width}`).join("|");
  const viewport = useSplitViewport(layout);
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
