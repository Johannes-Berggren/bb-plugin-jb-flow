import { useEffect } from "react";
import { useSettings, useSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
import { minPaneWidth, requiredSplitWidth, revealScrollLeft, type SplitPaneRect } from "./split-scroll-model";
import "./split-scroll.css";

const SCROLL_CLASS = "jb-flow-split-scroll";
const WIDTH_VAR = "--jb-flow-split-min-width";
const SCROLL_EVENT = "jb-flow-split-scroll";
/** BB's element around the split panes; the side panel sits outside it and stays put. */
const SCROLLER = "#split-workspace-main-panel > div";
/** While a divider is dragged or a pane is maximized, BB owns the geometry. */
const BUSY = '[data-dragging], [data-split-pane-id][data-maximized="true"]';

type Focused = SplitPaneRect & { key: string };
type Preference = { width: number | null; focused: Focused | null };

function readPreference(detail: unknown): Preference | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { width, focused } = detail as { width?: unknown; focused?: unknown };
  if (width !== null && (typeof width !== "number" || !Number.isFinite(width) || width <= 0)) return null;
  if (focused === null || focused === undefined) return { width, focused: null };
  const { key, x, width: paneWidth } = focused as { key?: unknown; x?: unknown; width?: unknown };
  if (typeof key !== "string" || typeof x !== "number" || typeof paneWidth !== "number") return null;
  return { width, focused: { key, x, width: paneWidth } };
}

/**
 * Owns the class and the width that let the split scroll sideways, and brings
 * the focused pane into view: BB focuses a pane without scrolling to it. Only
 * the strip itself is scrolled, never BB's outer containers.
 */
export function mountSplitScroll({ signal }: { signal: AbortSignal }) {
  if (signal.aborted) return;
  const root = document.documentElement;
  let focused: Focused | null = null;
  let frame = 0;
  let observer: MutationObserver | null = null;
  let wasMaximized = false;

  const reveal = (smooth: boolean) => {
    cancelAnimationFrame(frame);
    // After BB has laid the panes out for the new layout.
    frame = requestAnimationFrame(() => {
      const scroller = document.querySelector<HTMLElement>(SCROLLER);
      if (!scroller || !focused || !root.classList.contains(SCROLL_CLASS)) return;
      if (scroller.querySelector(BUSY)) return;
      const left = revealScrollLeft({
        x: focused.x,
        width: focused.width,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        scrollLeft: scroller.scrollLeft,
      });
      if (left !== Math.round(scroller.scrollLeft)) scroller.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
    });
  };
  const maximized = () => document.querySelector('[data-split-pane-id][data-maximized="true"]') !== null;
  const watchMaximize = (on: boolean) => {
    if (!on) {
      observer?.disconnect();
      observer = null;
      return;
    }
    if (observer) return;
    wasMaximized = maximized();
    // Maximizing collapses the strip, so the scroll position is lost. BB's
    // layout doesn't change on maximize; this attribute is the only signal.
    observer = new MutationObserver(() => {
      const now = maximized();
      if (wasMaximized && !now) reveal(false);
      wasMaximized = now;
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-maximized"] });
  };
  const apply = (preference: Preference) => {
    const on = preference.width !== null;
    root.classList.toggle(SCROLL_CLASS, on);
    if (on) root.style.setProperty(WIDTH_VAR, `${preference.width}px`);
    else root.style.removeProperty(WIDTH_VAR);
    watchMaximize(on);
    const moved = preference.focused?.key !== focused?.key;
    focused = preference.focused;
    // Only a change of pane scrolls, so resizing a divider never moves the strip.
    if (on && moved && focused) reveal(true);
  };
  const update = (event: Event) => {
    const preference = readPreference((event as CustomEvent<unknown>).detail);
    if (preference) apply(preference);
  };
  window.addEventListener(SCROLL_EVENT, update, { signal });
  const cleanup = () => {
    cancelAnimationFrame(frame);
    apply({ width: null, focused: null });
  };
  signal.addEventListener("abort", cleanup, { once: true });
  return () => {
    cleanup();
    window.removeEventListener(SCROLL_EVENT, update);
    signal.removeEventListener("abort", cleanup);
  };
}

/** Bridges the setting and BB's split layout to the content script. */
export function SplitScrollPreference() {
  const { values, isLoading } = useSettings();
  const split = useSidebarSplitLayout();
  const enabled = values?.splitScroll === true && split !== null;
  const width = enabled ? requiredSplitWidth(split.panes, minPaneWidth(values?.splitMinPaneWidth)) : null;
  const pane = enabled ? split.panes.find((candidate) => candidate.isFocused) : undefined;
  // The pane count is part of the key: a pane opening or closing moves the others.
  const key = pane ? `${pane.paneId}:${split?.panes.length}` : null;
  const x = pane?.rect.x ?? 0;
  const paneWidth = pane?.rect.width ?? 0;
  useEffect(() => {
    if (isLoading) return;
    window.dispatchEvent(
      new CustomEvent(SCROLL_EVENT, { detail: { width, focused: key === null ? null : { key, x, width: paneWidth } } }),
    );
  }, [isLoading, width, key, x, paneWidth]);
  return null;
}
