// Expanded, resizable plan reviews (the "Expand plan reviews" setting).
// --- plan review banners -----------------------------------------------------------
// BB renders a plan awaiting approval in a banner that starts collapsed, caps its
// body at min(32rem, 50dvh) and sizes the banner to the space left in the thread.
// Core renderers can't be replaced, so this content script expands each banner
// once when it appears (a manual collapse sticks) and lets it take ~75% of the
// window with a single scroll area, resizable by dragging. Selectors are BB's own test ids.

// Only with the "Expand plan reviews" setting on: CommandHost sets this flag on <html>.
export const EXPAND_PLANS_FLAG = "jbFlowExpandPlans";
const PLAN_BANNER = 'html[data-jb-flow-expand-plans] section[data-testid="plan-review-banner"]';
// The plan's height, set by dragging the handle on top of the banner (the
// banner sits above the composer, so it grows upwards). Remembered per browser.
const PLAN_HEIGHT_VAR = "--jf-plan-height";
const PLAN_HEIGHT_KEY = "jb-flow-plan-height";
const PLAN_STYLE = `
${PLAN_BANNER}[data-expanded] {
  position: relative;
  max-height: calc(var(${PLAN_HEIGHT_VAR}, 75dvh) + 5dvh) !important;
}
${PLAN_BANNER} .overflow-y-auto:has([data-testid="plan-review-request"]) {
  max-height: var(${PLAN_HEIGHT_VAR}, 75dvh) !important;
}
${PLAN_BANNER} .jf-plan-resize {
  position: absolute;
  z-index: 2;
  top: -5px;
  left: 0;
  right: 0;
  height: 10px;
  cursor: ns-resize;
  touch-action: none;
}
${PLAN_BANNER} .jf-plan-resize::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 50%;
  width: 36px;
  height: 4px;
  margin-left: -18px;
  border-radius: 999px;
  background: var(--border);
}
${PLAN_BANNER} .jf-plan-resize:hover::after,
${PLAN_BANNER} .jf-plan-resize[data-dragging]::after {
  background: var(--muted-foreground);
}
/* The plan body itself doesn't scroll; the banner body does. */
${PLAN_BANNER} [data-testid="plan-review-request"] > div:first-child {
  max-height: none !important;
  overflow: visible !important;
}
${PLAN_BANNER} [data-testid="plan-review-request"] .text-xs {
  font-size: 0.8125rem;
}
`;

export function mountPlanExpander({ signal }: { signal: AbortSignal }) {
  const style = document.createElement("style");
  style.dataset.jbFlow = "plan-expander";
  style.textContent = PLAN_STYLE;
  document.head.append(style);

  const root = document.documentElement;
  try {
    const saved = Number(localStorage.getItem(PLAN_HEIGHT_KEY));
    if (saved > 0) root.style.setProperty(PLAN_HEIGHT_VAR, `${saved}px`);
  } catch {
    /* No storage: the default height applies. */
  }

  /** A grip on top of the banner: drag up to grow, down to shrink, double-click to reset. */
  const addHandle = (banner: HTMLElement) => {
    if (banner.querySelector(":scope > .jf-plan-resize")) return;
    const handle = document.createElement("div");
    handle.className = "jf-plan-resize";
    handle.title = "Drag to resize the plan · double-click to reset";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.addEventListener("pointerdown", (event) => {
      const body = banner.querySelector<HTMLElement>('.overflow-y-auto:has([data-testid="plan-review-request"])');
      if (!body) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.dataset.dragging = "";
      const startY = event.clientY;
      const startHeight = body.getBoundingClientRect().height;
      // Grow until the banner's top (and this handle) is 110px from the window
      // top, so the handle stays clear of the thread header and can be grabbed again.
      const maxHeight = startHeight + Math.max(0, banner.getBoundingClientRect().top - 110);
      let height = startHeight;
      const move = (next: PointerEvent) => {
        height = Math.round(Math.min(maxHeight, Math.max(160, startHeight + (startY - next.clientY))));
        root.style.setProperty(PLAN_HEIGHT_VAR, `${height}px`);
      };
      const end = () => {
        delete handle.dataset.dragging;
        handle.removeEventListener("pointermove", move);
        try {
          localStorage.setItem(PLAN_HEIGHT_KEY, String(height));
        } catch {
          /* Keep it for this session only. */
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end, { once: true });
      handle.addEventListener("pointercancel", end, { once: true });
    });
    handle.addEventListener("dblclick", () => {
      root.style.removeProperty(PLAN_HEIGHT_VAR);
      try {
        localStorage.removeItem(PLAN_HEIGHT_KEY);
      } catch {
        /* Nothing saved. */
      }
    });
    banner.prepend(handle);
  };

  const seen = new WeakSet<Element>();
  const expand = () => {
    if (!(EXPAND_PLANS_FLAG in document.documentElement.dataset)) return;
    for (const banner of Array.from(document.querySelectorAll<HTMLElement>(PLAN_BANNER))) {
      if (banner.hasAttribute("data-expanded")) addHandle(banner);
      if (seen.has(banner)) continue;
      seen.add(banner);
      if (banner.hasAttribute("data-expanded")) continue;
      const toggle = banner.querySelector('button[aria-expanded="false"]') as HTMLButtonElement | null;
      toggle?.click();
    }
  };
  expand();
  const observer = new MutationObserver(expand);
  // Also when a banner is expanded by hand, so it gets its handle.
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-expanded"] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-jb-flow-expand-plans"] });
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  return () => {
    observer.disconnect();
    style.remove();
    for (const handle of Array.from(document.querySelectorAll(".jf-plan-resize"))) handle.remove();
  };
}
