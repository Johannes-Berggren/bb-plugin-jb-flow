import "./inline-code-copy.css";

/** Set on <html> by the settings bridge while "Copy buttons on code" is on. */
export const COPY_CODE_FLAG = "jbFlowCopyCode";

const COPY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** An inline code chip in a chat message. Fenced blocks (<pre>) already have BB's own Copy code. */
export function copyableChip(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const code = target.closest<HTMLElement>("code");
  if (!code || code.closest("pre, [contenteditable], textarea") || !code.closest("[data-timeline-row-id]")) return null;
  return code.textContent?.trim() ? code : null;
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older embeds without the async clipboard API.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/**
 * One floating copy button that follows the hovered code chip. It lives in <body>,
 * so BB's message markup, text selection and selection-copy stay untouched.
 */
export function mountInlineCodeCopy({ signal }: { signal: AbortSignal }) {
  if (signal.aborted) return;
  const root = document.documentElement;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "jf-code-copy";
  button.hidden = true;
  document.body.append(button);

  let chip: HTMLElement | null = null;
  let hideTimer: number | undefined;
  let doneTimer: number | undefined;
  const label = (copied: boolean) => {
    button.innerHTML = copied ? DONE_ICON : COPY_ICON;
    button.dataset.copied = String(copied);
    button.title = copied ? "Copied" : "Copy";
    button.setAttribute("aria-label", copied ? "Copied" : "Copy code");
  };
  const hide = () => {
    window.clearTimeout(hideTimer);
    chip = null;
    button.hidden = true;
  };
  const show = (next: HTMLElement) => {
    window.clearTimeout(hideTimer);
    if (chip === next && !button.hidden) return;
    chip = next;
    window.clearTimeout(doneTimer);
    label(false);
    button.hidden = false;
    // Just past the chip's right edge; inside it when that edge is near the window edge.
    const box = next.getBoundingClientRect();
    const size = button.offsetWidth || 22;
    const left = box.right + 2 + size > window.innerWidth ? box.right - size : box.right + 2;
    button.style.left = `${Math.round(left)}px`;
    button.style.top = `${Math.round(box.top + box.height / 2 - size / 2)}px`;
  };
  const hideSoon = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 250);
  };

  const over = (event: Event) => {
    if (button.contains(event.target as Node)) {
      window.clearTimeout(hideTimer);
      return;
    }
    const next = COPY_CODE_FLAG in root.dataset ? copyableChip(event.target) : null;
    if (next) show(next);
    else if (chip) hideSoon();
  };
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    const text = chip?.textContent;
    if (!text) return;
    await writeClipboard(text);
    label(true);
    window.clearTimeout(doneTimer);
    doneTimer = window.setTimeout(() => label(false), 1200);
  });
  document.addEventListener("pointerover", over, { signal });
  // A moved chip leaves the button floating in the wrong place.
  window.addEventListener("scroll", hide, { capture: true, signal });
  window.addEventListener("resize", hide, { signal });

  const cleanup = () => {
    window.clearTimeout(hideTimer);
    window.clearTimeout(doneTimer);
    button.remove();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  return cleanup;
}
