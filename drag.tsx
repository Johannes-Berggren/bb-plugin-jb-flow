// Dragging threads onto sections, and sections into a new order, in the Triage list.
import { createContext, useCallback, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
// --- drag threads between sections ---------------------------------------------------
// Pointer-based (not HTML5 drag) so bb's own drag-to-split keeps working: a
// drop inside the sidebar moves the thread; leaving the sidebar cancels ours
// and bb's split gesture takes over.

export const DROP_ATTR = "data-jb-drop-section";
export const ACTIVE_DROP = "__active";

type DragState = { threadId: string; title: string; x: number; y: number; over: string | null };
export const DragContext = createContext<{
  start: (thread: PluginSidebarThread, event: ReactPointerEvent<HTMLElement>) => void;
  dragging: DragState | null;
}>({ start: () => undefined, dragging: null });

export function useThreadDrag(onDrop: (threadId: string, sectionId: string | null) => void) {
  const [dragging, setDragging] = useState<DragState | null>(null);
  const start = useCallback(
    (thread: PluginSidebarThread, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const nav = event.currentTarget.closest("nav");
      const origin = { x: event.clientX, y: event.clientY };
      let active = false;
      let over: string | null = null;
      const move = (moveEvent: PointerEvent) => {
        if (!active) {
          if (Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 6) return;
          active = true;
        }
        const bounds = nav?.getBoundingClientRect();
        if (bounds && (moveEvent.clientX > bounds.right || moveEvent.clientX < bounds.left)) {
          finish(false); // left the sidebar: bb's drag-to-split owns this gesture
          return;
        }
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(`[${DROP_ATTR}]`);
        over = target?.getAttribute(DROP_ATTR) ?? null;
        setDragging({ threadId: thread.id, title: thread.displayTitle, x: moveEvent.clientX, y: moveEvent.clientY, over });
      };
      const finish = (drop: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", escape);
        setDragging(null);
        if (!active) return;
        // Swallow the click that follows the drag so the row doesn't navigate.
        window.addEventListener("click", (clickEvent) => clickEvent.stopPropagation(), { capture: true, once: true });
        if (drop && over !== null) onDrop(thread.id, over === ACTIVE_DROP ? null : over);
      };
      const up = () => finish(true);
      const escape = (keyEvent: globalThis.KeyboardEvent) => {
        if (keyEvent.key === "Escape") finish(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", escape);
    },
    [onDrop],
  );
  return { start, dragging };
}

// --- reorder sections by dragging their header ---------------------------------------

export const SECTION_ATTR = "data-jb-section-key";
/** Order key for a section; the unsectioned Active lane has no id. */
export const sectionKey = (id: string | null) => id ?? ACTIVE_DROP;

/** Saved order first; sections it doesn't know yet go right after their default predecessor. */
export function mergeOrder(saved: readonly string[], defaults: readonly string[]): string[] {
  const result = saved.filter((key, index) => defaults.includes(key) && saved.indexOf(key) === index);
  defaults.forEach((key, index) => {
    if (result.includes(key)) return;
    const previous = defaults.slice(0, index).reverse().find((candidate) => result.includes(candidate));
    result.splice(previous === undefined ? 0 : result.indexOf(previous) + 1, 0, key);
  });
  return result;
}

type SectionDragState = { key: string; over: string | null; after: boolean };

export function useSectionDrag(onMove: (key: string, target: string, after: boolean) => void) {
  const [dragging, setDragging] = useState<SectionDragState | null>(null);
  const start = useCallback(
    (key: string, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const origin = { x: event.clientX, y: event.clientY };
      let active = false;
      let over: string | null = null;
      let after = false;
      const move = (moveEvent: PointerEvent) => {
        if (!active) {
          if (Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 6) return;
          active = true;
          document.body.style.userSelect = "none";
        }
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(`[${SECTION_ATTR}]`);
        const targetKey = target?.getAttribute(SECTION_ATTR) ?? null;
        if (target && targetKey !== null && targetKey !== key) {
          const bounds = target.getBoundingClientRect();
          over = targetKey;
          after = moveEvent.clientY > bounds.top + bounds.height / 2;
        } else {
          over = null;
        }
        setDragging({ key, over, after });
      };
      const finish = (drop: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", escape);
        setDragging(null);
        if (!active) return;
        document.body.style.userSelect = "";
        // Swallow the click that follows the drag so the header doesn't toggle.
        window.addEventListener("click", (clickEvent) => clickEvent.stopPropagation(), { capture: true, once: true });
        if (drop && over !== null) onMove(key, over, after);
      };
      const up = () => finish(true);
      const escape = (keyEvent: globalThis.KeyboardEvent) => {
        if (keyEvent.key === "Escape") finish(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", escape);
    },
    [onMove],
  );
  return { start, dragging };
}
