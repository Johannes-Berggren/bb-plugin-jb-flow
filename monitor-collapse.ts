import { useEffect, useState } from "react";

export const MONITOR_COLLAPSE_KEY = "jb-flow:thread-monitor-collapsed";
const EVENT = "jb-flow:monitor-collapse";
const mobile = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(max-width: 640px)").matches ??
    window.innerWidth <= 640);
function preference(): boolean {
  try {
    const value = window.localStorage.getItem(MONITOR_COLLAPSE_KEY);
    if (value === "true" || value === "false") return value === "true";
  } catch {
    /* Storage can be unavailable in private browsers. */
  }
  return mobile();
}

/** Device preference shared by split panes; thread status continues updating when hidden. */
export function useMonitorCollapse() {
  const [collapsed, setCollapsed] = useState(preference);
  useEffect(() => {
    const update = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (typeof detail === "boolean") setCollapsed(detail);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === MONITOR_COLLAPSE_KEY || event.key === null)
        setCollapsed(preference());
    };
    const media = window.matchMedia?.("(max-width: 640px)");
    const resize = () => {
      try {
        if (window.localStorage.getItem(MONITOR_COLLAPSE_KEY) === null)
          setCollapsed(mobile());
      } catch {
        /* Keep the current choice. */
      }
    };
    window.addEventListener(EVENT, update);
    window.addEventListener("storage", storage);
    media?.addEventListener("change", resize);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("storage", storage);
      media?.removeEventListener("change", resize);
    };
  }, []);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(MONITOR_COLLAPSE_KEY, String(next));
    } catch {
      /* Still works for this visit. */
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  };
  return { collapsed, toggle };
}
