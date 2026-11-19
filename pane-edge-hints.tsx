// Small markers at the edges of a split that scrolls: how many panes lie beyond
// each edge, and whether one of them waits on you. Clicking one scrolls that
// pane into view without focusing it, so nothing is marked read.
import { useMemo } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useSettings,
  useSidebarSplitLayout,
} from "@get-bb/plugin-sdk/app";
import { useFlowState } from "./flow-state";
import { awaitsYou, edgeHints, paneState, type EdgeHint } from "./pane-strip-model";
import { SCROLLER, useSplitViewport } from "./pane-strip";
import { revealScrollLeft } from "./split-scroll-model";
import "./pane-edge-hints.css";

function scrollTo(target: EdgeHint["target"]) {
  const scroller = document.querySelector<HTMLElement>(SCROLLER);
  if (!scroller) return;
  const left = revealScrollLeft({ ...target, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth, scrollLeft: scroller.scrollLeft });
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  scroller.scrollTo({ left, behavior: reduce ? "auto" : "smooth" });
}

function Hint({ side, hint }: { side: "left" | "right"; hint: EdgeHint }) {
  const panes = `${hint.count} ${hint.count === 1 ? "pane" : "panes"}`;
  const label = `${panes} to the ${side}${hint.needsYou ? `, ${hint.needsYou} waiting on you` : ""}`;
  return (
    <button
      type="button"
      className="jf-edge-hint"
      data-side={side}
      data-needs-you={hint.needsYou > 0 || undefined}
      aria-label={label}
      title={label}
      onClick={() => scrollTo(hint.target)}
    >
      <span aria-hidden="true">{side === "left" ? "‹" : "›"}</span>
      {/* Panes waiting on you when any are, else all the panes beyond; the full count is in the label. */}
      <span aria-hidden="true">{hint.needsYou > 0 ? hint.needsYou : hint.count}</span>
    </button>
  );
}

/** Mounted once per window; draws nothing unless the split scrolls and panes are out of view. */
export function PaneEdgeHints() {
  const enabled = useSettings().values?.splitScroll === true;
  const split = useSidebarSplitLayout();
  const { threads } = useSidebarThreads();
  const awaiting = useFlowState().state?.awaiting;
  const panes = enabled && split && split.panes.length > 1 ? split.panes : null;
  const layout = panes === null ? null : panes.map((pane) => `${pane.paneId}:${pane.rect.x}:${pane.rect.width}`).join("|");
  const viewport = useSplitViewport(layout);
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  if (panes === null || viewport === null) return null;
  // Panes in a nested column share their column's place, so count columns only once each.
  const columns = new Map<string, { rect: { x: number; width: number }; needsYou: boolean }>();
  for (const pane of panes) {
    const thread = pane.threadId === null ? undefined : byId.get(pane.threadId);
    const needsYou = thread !== undefined && paneState(thread, awaitsYou(thread, awaiting)) === "needs-you";
    const key = `${pane.rect.x}:${pane.rect.width}`;
    const seen = columns.get(key);
    columns.set(key, { rect: { x: pane.rect.x, width: pane.rect.width }, needsYou: needsYou || seen?.needsYou === true });
  }
  const { left, right } = edgeHints([...columns.values()], viewport);
  if (!left && !right) return null;
  const { top, left: boxLeft, width, height } = viewport.box;
  return (
    <div className="jf-edge-hints" style={{ top, left: boxLeft, width, height }}>
      {left ? <Hint side="left" hint={left} /> : null}
      {right ? <Hint side="right" hint={right} /> : null}
    </div>
  );
}
