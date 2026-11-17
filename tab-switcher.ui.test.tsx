import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";
import type { WorkspaceState } from "./workspaces";
import { selectWorkspace, setWorkspacesEnabled } from "./workspace-client";

const NOW = Date.now();

const baseState: FlowState = {
  projectShortNames: {},
  stripProjectPrefixes: [],
  awaiting: {},
  promised: {},
  waitingOthers: {},
  readyToGo: {},
  sectionOrder: [],
  machines: { hosts: [], threadHosts: {}, environmentHosts: {}, localHostId: null },
  laneSections: {},
  sectionProjects: {},
  threadPrs: {},
  running: {},
  watching: {},
  snoozedSectionId: null,
  snoozes: {},
  tags: {},
  focused: {},
  due: {},
};

function thread(id: string, title: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id,
    title,
    displayTitle: title,
    titleFallback: null,
    projectId: "p1",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: `/projects/p1/threads/${id}`,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
    lastReadAt: null,
    latestAttentionAt: NOW - 3_600_000,
    ...overrides,
  };
}

const projects = [
  { id: "p1", name: "web-app", isPersonal: false, href: "/projects/p1", settingsHref: "/projects/p1/settings" },
  { id: "p2", name: "billing-api", isPersonal: false, href: "/projects/p2", settingsHref: "/projects/p2/settings" },
];

const threads = [
  thread("a", "Fix billing export"),
  thread("b", "Deploy the worker", { projectId: "p2", isUnread: true }),
  thread("c", "Mail templates"),
  thread("d", "Old cleanup", { updatedAt: NOW - 9 * 86_400_000 }),
];

const workspaceState: WorkspaceState = {
  workspaces: [
    { id: "web", name: "Web", projectIds: ["p1"], sectionIds: [], pluginIds: [], sectionOrder: [] },
    { id: "billing", name: "Billing", projectIds: ["p2"], sectionIds: [], pluginIds: [], sectionOrder: [] },
  ],
  threadWorkspaces: {},
};

async function mount(options: { settings?: Record<string, unknown>; workspaces?: WorkspaceState } = {}) {
  const app = await loadPluginApp(() => import("./app"));
  const overlay = app.appOverlays.find((item) => item.id === "tab-switcher")!;
  return renderSlot(
    overlay,
    {},
    {
      settings: { tabSwitcher: true, ...options.settings },
      rpc: {
        state_get: () => baseState,
        workspaces_get: () => options.workspaces ?? { workspaces: [], threadWorkspaces: {} },
      } as never,
      sidebarThreads: { status: "ready", threads, projects, sections: [] },
      context: { threadId: "a" },
      sdk: { subscribe: (() => () => {}) as never },
      realtimeConnectionState: "connected",
    },
  );
}

/** Ctrl+Tab (or another key with Ctrl held); returns whether the switcher took it. */
const ctrl = (key = "Tab", extra: Record<string, unknown> = {}) =>
  !fireEvent.keyDown(window, { key, code: key === "`" ? "Backquote" : key, ctrlKey: true, ...extra });
const release = () => fireEvent.keyUp(window, { key: "Control", code: "ControlLeft" });

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  localStorage.clear();
  // Viewed most recently first: c, then b.
  localStorage.setItem("jb-flow.palette.recent", JSON.stringify(["c", "b"]));
});
afterEach(() => {
  cleanup();
  selectWorkspace(null);
  setWorkspacesEnabled(false);
  sessionStorage.clear();
});

describe("Ctrl+Tab switcher", () => {
  it("a quick tap flips to the thread viewed before this one, without showing the panel", async () => {
    const slot = await mount();
    await waitFor(() => expect(ctrl()).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    release();
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "c" });
  });

  it("holding shows recent threads; Tab steps, releasing opens the selection", async () => {
    const slot = await mount();
    await waitFor(() => expect(ctrl()).toBe(true));
    expect(ctrl()).toBe(true);
    const panel = await screen.findByRole("dialog");
    const rows = Array.from(panel.querySelectorAll('[role="listbox"][aria-label="Recent threads"] [role="option"]'));
    expect(rows.map((row) => row.querySelector(".jf-switcher-title")?.textContent)).toEqual([
      "Fix billing export",
      "Mail templates",
      "Deploy the worker",
      "Old cleanup",
    ]);
    expect(rows[2]!.getAttribute("aria-selected")).toBe("true");
    expect(rows[0]!.textContent).toContain("open now");
    release();
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "b" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Shift+Tab steps back, wrapping to the oldest", async () => {
    const slot = await mount();
    await waitFor(() => expect(ctrl()).toBe(true));
    expect(ctrl("Tab", { shiftKey: true })).toBe(true);
    expect(ctrl("Tab", { shiftKey: true })).toBe(true);
    release();
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "d" });
  });

  it("Escape cancels without opening anything", async () => {
    const slot = await mount();
    await waitFor(() => expect(ctrl()).toBe(true));
    await screen.findByRole("dialog");
    expect(ctrl("Escape")).toBe(true);
    release();
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pressing a row opens it", async () => {
    const slot = await mount();
    await waitFor(() => expect(ctrl()).toBe(true));
    const panel = await screen.findByRole("dialog");
    fireEvent.mouseDown(panel.querySelector("#jf-switcher-d")!);
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "d" });
  });

  it("Ctrl+` switches to the workspace used before this one", async () => {
    localStorage.setItem("jb-flow.workspaces.recent", JSON.stringify(["web", "billing"]));
    setWorkspacesEnabled(true);
    selectWorkspace("web");
    await mount({ settings: { workspaces: true }, workspaces: workspaceState });
    await waitFor(() => expect(ctrl("`")).toBe(true));
    const panel = await screen.findByRole("dialog");
    const tabs = Array.from(panel.querySelectorAll('[aria-label="Workspaces"] [role="option"]')).map((tab) => tab.textContent);
    expect(tabs).toEqual(["Web", "Billing1", "All1", "No workspace"]);
    release();
    expect(sessionStorage.getItem("jb-flow-workspace")).toBe("billing");
  });

  it("with the setting off, Ctrl+Tab is left alone", async () => {
    const slot = await mount({ settings: { tabSwitcher: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctrl()).toBe(false);
    release();
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });

  it("stands down while a modal is open", async () => {
    const slot = await mount();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ctrl()).toBe(false);
      release();
      expect(slot.inspection.navigateCalls).toHaveLength(0);
    } finally {
      modal.remove();
    }
  });

  it("keeps the recent list fresh as threads open", async () => {
    await mount({ settings: { tabSwitcher: false } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("jb-flow.palette.recent")!)).toEqual(["a", "c", "b"]));
  });
});
