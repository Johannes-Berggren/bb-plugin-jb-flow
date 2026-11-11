import "./callouts.css";

// GitHub-style callouts ("> [!TIP]") in chat messages. BB renders the marker as
// literal text; with "Polish the entire BB interface" on, this script drops the
// marker and tags the blockquote so callouts.css can style it as a callout.
// It only edits the marker's own text node and sets one attribute, so React's
// nodes stay where React put them, and it puts the text back when polish is off.

/** On the blockquote, the callout's type: note, tip, important, warning or caution. */
export const CALLOUT_ATTR = "data-jf-callout";
const QUOTE = "[data-timeline-row-id] blockquote";
const MARKER = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*\r?\n?/i;

/** The blockquote's first text that isn't only whitespace. */
function firstText(quote: Element): Text | null {
  const walker = document.createTreeWalker(quote, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue?.trim()) return node as Text;
  }
  return null;
}

export function mountCallouts({ signal }: { signal: AbortSignal }) {
  if (signal.aborted) return;
  // Each callout's marker text node, what it said, and what this script left in it.
  const entries = new Map<Element, { node: Text; original: string; stripped: string }>();
  let frame: number | undefined;
  const clear = (quote: Element) => {
    const entry = entries.get(quote);
    // Put the marker back only if nothing has rewritten the text since.
    if (entry && entry.node.nodeValue === entry.stripped) entry.node.nodeValue = entry.original;
    quote.removeAttribute(CALLOUT_ATTR);
    entries.delete(quote);
  };
  const sync = () => {
    frame = undefined;
    const enabled = document.documentElement.classList.contains("jb-flow-shell");
    for (const quote of entries.keys()) if (!enabled || !quote.isConnected) clear(quote);
    if (!enabled) return;
    document.querySelectorAll(QUOTE).forEach((quote) => {
      const node = firstText(quote);
      const match = node ? MARKER.exec(node.nodeValue ?? "") : null;
      // Already a callout, or a plain quote. A re-render that brings the marker back lands here again.
      if (!node || !match) return;
      const original = node.nodeValue ?? "";
      const stripped = original.slice(match[0].length);
      node.nodeValue = stripped;
      entries.set(quote, { node, original, stripped });
      quote.setAttribute(CALLOUT_ATTR, match[1]!.toLowerCase());
    });
  };
  const schedule = () => {
    if (frame === undefined) frame = requestAnimationFrame(sync);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const rootObserver = new MutationObserver(schedule);
  rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  sync();
  const cleanup = () => {
    observer.disconnect();
    rootObserver.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    for (const quote of [...entries.keys()]) clear(quote);
  };
  signal.addEventListener("abort", cleanup, { once: true });
  return () => {
    cleanup();
    signal.removeEventListener("abort", cleanup);
  };
}
