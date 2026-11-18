import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const thread = (id: string, overrides: Partial<PluginSidebarThread> = {}) =>
  ({
    id,
    projectId: "p",
    displayTitle: `Thread ${id}`,
    sectionId: null,
    parentThreadId: null,
    isArchived: false,
    isHidden: false,
    isUnread: false,
    hasPendingInteraction: false,
    status: "idle",
    indicator: "none",
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    ...overrides,
  }) as PluginSidebarThread;
// Four panes; the last one asks you something.
const threads = [thread("a"), thread("b"), thread("c"), thread("d", { hasPendingInteraction: true })];
const split = {
  panes: threads.map((entry, index) => ({
    paneId: `p${index}`,
    rect: { x: index / 4, y: 0, width: 0.25, height: 1 },
    threadId: entry.id,
    isFocused: index === 0,
  })),
};
const host = (splitScroll: boolean) => ({
  settings: { splitScroll },
  rpc: { state_get: () => ({ awaiting: {} }) } as never,
  sidebarThreads: { status: "ready" as const, projects: [], threads, sections: [] },
  sidebarSplitLayout: split,
});

/** BB's scrolled element; jsdom has no layout, so the sizes are stubbed. */
function hostSplit(scrollLeft: number) {
  document.body.insertAdjacentHTML("beforeend", `<div id="split-workspace-main-panel"><div><div></div></div></div>`);
  const scroller = document.querySelector<HTMLElement>("#split-workspace-main-panel > div")!;
  Object.defineProperties(scroller, {
    scrollWidth: { value: 2560 },
    clientWidth: { value: 1280 },
    scrollLeft: { value: scrollLeft, writable: true },
  });
  const scrollTo = vi.fn();
  scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
  return { scroller, scrollTo };
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => {
  cleanup();
  document.querySelector("#split-workspace-main-panel")?.remove();
  vi.unstubAllGlobals();
});

async function hints(options: ReturnType<typeof host>) {
  const app = await loadPluginApp(() => import("./app"));
  return renderSlot(app.appOverlays.find((overlay) => overlay.id === "pane-edge-hints")!, {}, options);
}

it("shows what lies beyond each edge and scrolls to the pane that waits on you", async () => {
  const { scroller, scrollTo } = hostSplit(0);
  const slot = await hints(host(true));
  // Panes a and b show; c and d are to the right, and d waits on you.
  const right = await slot.findByRole("button", { name: "2 panes to the right, 1 waiting on you" });
  expect(right.textContent).toContain("1 needs you");
  expect(slot.queryByRole("button", { name: /to the left/ })).toBeNull();
  fireEvent.click(right);
  // Pane d's right edge at the view's right edge.
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 1280, behavior: "smooth" });

  scroller.scrollLeft = 1280;
  fireEvent.scroll(scroller);
  const left = await slot.findByRole("button", { name: "2 panes to the left" });
  expect(left.textContent).toContain("2");
  await waitFor(() => expect(slot.queryByRole("button", { name: /to the right/ })).toBeNull());
  slot.lifecycle.unmount();
});

it("draws nothing with scrolling off", async () => {
  hostSplit(0);
  const slot = await hints(host(false));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(slot.queryByRole("button")).toBeNull();
  slot.lifecycle.unmount();
});
