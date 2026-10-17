import "./timeline-activity.css";

const ROW = "[data-timeline-row-id]";
const GROUP = '[data-timeline-row-id*=":work-summary:"]';

/** Enhance native activity bundles without moving React nodes or replacing controls. */
export function mountTimelineActivity({ signal }: { signal: AbortSignal }) {
  if (signal.aborted) return;
  const entries = new Map<HTMLElement, { button: HTMLButtonElement; expanded: boolean }>();
  let frame: number | undefined;
  const clear = (group: HTMLElement) => {
    entries.get(group)?.button.remove();
    entries.delete(group);
    group.removeAttribute("data-jb-flow-trace");
    group.querySelectorAll("[data-jb-flow-trace-past]").forEach(row => row.removeAttribute("data-jb-flow-trace-past"));
  };
  const sync = () => {
    frame = undefined;
    const enabled = document.documentElement.classList.contains("jb-flow-shell");
    for (const group of entries.keys()) if (!enabled || !group.isConnected) clear(group);
    if (!enabled) return;
    document.querySelectorAll<HTMLElement>(GROUP).forEach(group => {
      const children = Array.from(group.querySelectorAll<HTMLElement>(ROW)).filter(row => row.parentElement?.closest(ROW) === group);
      // BB's shimmer marks live work. Unknown structures fall back to the native UI.
      const live = children.some(row => row.querySelector(".animate-shine"));
      const past = live ? children.filter(row =>
        row.querySelector(".opacity-40") && !row.querySelector(".animate-shine, .text-destructive-text, [role=alert]") &&
        !/\b(error|failed|interrupted|denied)\b/i.test(row.textContent ?? "") &&
        !row.querySelector('[aria-expanded="true"], input, textarea, [role="dialog"]')
      ) : [];
      if (!past.length) { clear(group); return; }
      let entry = entries.get(group);
      if (!entry) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.jbFlowTraceToggle = "";
        entry = { button, expanded: false };
        const state = entry;
        button.addEventListener("click", () => { state.expanded = !state.expanded; sync(); });
        entries.set(group, entry);
        group.append(button);
      }
      const hidden = new Set(past);
      for (const row of children) {
        if (hidden.has(row)) row.setAttribute("data-jb-flow-trace-past", "");
        else row.removeAttribute("data-jb-flow-trace-past");
      }
      group.dataset.jbFlowTrace = entry.expanded ? "expanded" : "compact";
      if (entry.button.getAttribute("aria-expanded") !== String(entry.expanded))
        entry.button.setAttribute("aria-expanded", String(entry.expanded));
      const label = `${entry.expanded ? "Hide" : "Show"} trace · ${past.length} earlier ${past.length === 1 ? "step" : "steps"}`;
      if (entry.button.textContent !== label) entry.button.textContent = label;
    });
  };
  const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(sync); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "aria-expanded"] });
  const rootObserver = new MutationObserver(schedule);
  rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  sync();
  const cleanup = () => {
    observer.disconnect(); rootObserver.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    for (const group of entries.keys()) clear(group);
  };
  signal.addEventListener("abort", cleanup, { once: true });
  return () => { cleanup(); signal.removeEventListener("abort", cleanup); };
}
