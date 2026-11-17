import { useEffect } from "react";
import { useSettings, useSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
import { minPaneWidth, requiredSplitWidth, revealScrollLeft } from "./split-scroll-model";
import "./split-scroll.css";

const SCROLL_CLASS = "jb-flow-split-scroll";
/** Set only while the strip really is wider than the view. */
const OVERFLOW_CLASS = "jb-flow-split-overflow";
const WIDTH_VAR = "--jb-flow-split-min-width";
const SCROLL_EVENT = "jb-flow-split-scroll";
/** BB's element around the split panes; the side panel sits outside it and stays put. */
const SCROLLER = "#split-workspace-main-panel > div";
/** BB measures a divider drag once, at pointer-down. */
const DRAGGING = "#split-workspace-main-panel [data-dragging]";
const MAXIMIZED = '#split-workspace-main-panel [data-split-pane-id][data-maximized="true"]';

type Focused = { key: string; x: number; width: number };
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
  /** A reveal that is still owed; a later layout event must not drop it. */
  let owed: "smooth" | "auto" | null = null;
  let attributes: MutationObserver | null = null;
  let sizes: ResizeObserver | null = null;
  let watched: HTMLElement | null = null;
  let wasMaximized = false;

  const on = () => root.classList.contains(SCROLL_CLASS);
  const present = (selector: string) => document.querySelector(selector) !== null;
  const measure = () => {
    const scroller = on() ? document.querySelector<HTMLElement>(SCROLLER) : null;
    root.classList.toggle(OVERFLOW_CLASS, scroller !== null && scroller.scrollWidth > scroller.clientWidth + 1);
    return scroller;
  };
  /** BB creates the scrolled element with the split and drops it with the last second pane. */
  const watchSizes = (scroller: HTMLElement | null) => {
    if (scroller === watched) return;
    sizes?.disconnect();
    sizes = null;
    watched = scroller;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    sizes = new ResizeObserver(measure);
    sizes.observe(scroller);
    if (scroller.firstElementChild) sizes.observe(scroller.firstElementChild);
  };
  /** After BB has laid the panes out: note whether the strip overflows, and show the focused pane if asked. */
  const settle = (reveal: "smooth" | "auto" | null) => {
    owed = reveal ?? owed;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const scroller = measure();
      watchSizes(scroller);
      const behavior = owed;
      owed = null;
      if (!scroller || !focused || behavior === null || present(DRAGGING) || present(MAXIMIZED)) return;
      const left = revealScrollLeft({
        x: focused.x,
        width: focused.width,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        scrollLeft: scroller.scrollLeft,
      });
      if (left !== Math.round(scroller.scrollLeft)) scroller.scrollTo({ left, behavior });
    });
  };
  const watchAttributes = (enabled: boolean) => {
    if (!enabled) {
      attributes?.disconnect();
      attributes = null;
      return;
    }
    if (attributes) return;
    wasMaximized = present(MAXIMIZED);
    // Maximizing collapses the strip, so the scroll position is lost. BB's
    // layout doesn't change on maximize; this attribute is the only signal.
    attributes = new MutationObserver(() => {
      const now = present(MAXIMIZED);
      if (wasMaximized && !now) settle("auto");
      wasMaximized = now;
    });
    attributes.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-maximized"] });
  };
  const apply = (preference: Preference) => {
    const enabled = preference.width !== null;
    root.classList.toggle(SCROLL_CLASS, enabled);
    if (enabled) root.style.setProperty(WIDTH_VAR, `${preference.width}px`);
    else root.style.removeProperty(WIDTH_VAR);
    watchAttributes(enabled);
    const moved = preference.focused?.key !== focused?.key;
    focused = preference.focused;
    if (!enabled) {
      cancelAnimationFrame(frame);
      owed = null;
      watchSizes(null);
      root.classList.remove(OVERFLOW_CLASS);
      return;
    }
    // Only a change of pane scrolls; resizing a divider leaves the strip where it is.
    settle(moved && focused ? "smooth" : null);
  };
  const update = (event: Event) => {
    const preference = readPreference((event as CustomEvent<unknown>).detail);
    if (preference) apply(preference);
  };
  window.addEventListener(SCROLL_EVENT, update, { signal });
  const cleanup = () => apply({ width: null, focused: null });
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
