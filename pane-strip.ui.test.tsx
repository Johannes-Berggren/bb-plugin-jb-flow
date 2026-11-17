import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { exampleWorkspaces } from "./workspaces.fixtures";
import { selectWorkspace } from "./workspace-client";

const projects = [
  { id: "h", name: "acme-app", isPersonal: false, href: "/projects/h", settingsHref: "/projects/h/settings" },
  { id: "f", name: "globex-web", isPersonal: false, href: "/projects/f", settingsHref: "/projects/f/settings" },
];
const state = {
  workspaces: exampleWorkspaces(projects).map((workspace) => (workspace.id === "acme" ? { ...workspace, color: "teal" as const } : workspace)),
  threadWorkspaces: {},
};
const thread = (id: string, projectId: string, overrides: Partial<PluginSidebarThread> = {}) =>
  ({
    id,
    projectId,
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
const threads = [
  thread("a", "h", { status: "active" }),
  thread("b", "f", { hasPendingInteraction: true }),
  thread("c", "h", { isUnread: true }),
];
const pane = (paneId: string, x: number, threadId: string | null, isFocused = false) => ({
  paneId,
  rect: { x, y: 0, width: 0.25, height: 1 },
  threadId,
  isFocused,
});
// Given out of order: the strip sorts by position.
const split = { panes: [pane("p3", 0.5, "c"), pane("p1", 0, "a", true), pane("p4", 0.75, null), pane("p2", 0.25, "b")] };
const host = (settings: Record<string, boolean>, sidebarSplitLayout?: typeof split) => ({
  settings: { workspaces: true, ...settings },
  rpc: { workspaces_get: () => state },
  sidebarThreads: { status: "ready" as const, projects, threads, sections: [] },
  sidebarSplitLayout,
});

/** BB's scrolled element around the panes; jsdom has no layout, so the sizes are stubbed. */
function hostSplit(scrollLeft: number) {
  document.body.insertAdjacentHTML("beforeend", `<div id="split-workspace-main-panel"><div><div></div></div></div>`);
  const scroller = document.querySelector<HTMLElement>("#split-workspace-main-panel > div")!;
  Object.defineProperties(scroller, {
    scrollWidth: { value: 2560 },
    clientWidth: { value: 1280 },
    scrollLeft: { value: scrollLeft, writable: true },
  });
  return scroller;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  selectWorkspace(null);
  sessionStorage.clear();
  document.querySelector("#split-workspace-main-panel")?.remove();
  vi.unstubAllGlobals();
});

async function bar(options: ReturnType<typeof host>) {
  const app = await loadPluginApp(() => import("./app"));
  return renderSlot(app.appOverlays.find((overlay) => overlay.id === "workspace-topbar")!, {}, options);
}
const chips = (_slot: unknown) => Array.from(document.querySelectorAll<HTMLElement>(".jf-pane-chip"));

it("lists the open panes in order with their workspace color and state, and goes to a pane on click", async () => {
  const slot = await bar(host({ paneStrip: true }, split));
  const strip = await slot.findByRole("toolbar", { name: "Open panes" });
  await waitFor(() => expect(chips(slot)[0]!.getAttribute("data-jf-color")).toBe("teal"));
  const all = chips(slot);
  expect(all.map((chip) => chip.textContent)).toEqual(["Thread a", "Thread b", "Thread c", ""]);
  expect(all.map((chip) => chip.querySelector(".jf-pane-chip-state")!.getAttribute("data-state"))).toEqual(["working", "needs-you", "unread", "idle"]);
  // Acme is teal, Globex has no color, and a page pane has no workspace.
  expect(all.map((chip) => chip.getAttribute("data-jf-color"))).toEqual(["teal", null, "teal", null]);
  expect(all.map((chip) => chip.getAttribute("aria-current"))).toEqual(["true", null, null, null]);
  expect(all[1]!.getAttribute("aria-label")).toBe("Thread b: waiting on you");
  // The page pane keeps its place but can't be clicked.
  expect(all[3]!.tagName).toBe("SPAN");
  expect(strip.querySelectorAll("button")).toHaveLength(3);

  fireEvent.click(all[1]!);
  expect(slot.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "b", options: { split: true } });
  slot.lifecycle.unmount();
});

it("dims the panes that are scrolled out of view and follows the scroll", async () => {
  const scroller = hostSplit(0);
  const slot = await bar(host({ paneStrip: true }, split));
  await slot.findByRole("toolbar", { name: "Open panes" });
  const inView = () => chips(slot).map((chip) => chip.hasAttribute("data-in-view"));
  // A 2560 wide split in a 1280 wide view: the first two panes show.
  await waitFor(() => expect(inView()).toEqual([true, true, false, false]));
  expect(chips(slot)[2]!.getAttribute("aria-label")).toBe("Thread c: finished, unread, out of view");
  scroller.scrollLeft = 1280;
  fireEvent.scroll(scroller);
  await waitFor(() => expect(inView()).toEqual([false, false, true, true]));
  slot.lifecycle.unmount();
});

it("shows nothing without a split or with the setting off", async () => {
  const off = await bar(host({ paneStrip: false }, split));
  await off.findByRole("tab", { name: "Acme" });
  expect(off.queryByRole("toolbar", { name: "Open panes" })).toBeNull();
  off.lifecycle.unmount();

  const single = await bar(host({ paneStrip: true }));
  await single.findByRole("tab", { name: "Acme" });
  expect(single.queryByRole("toolbar", { name: "Open panes" })).toBeNull();
  single.lifecycle.unmount();
});
