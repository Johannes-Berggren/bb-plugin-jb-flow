import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";

const NOW = Date.now();
const HOUR = 3_600_000;

const state: FlowState = {
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

// Newest first: the list sorts by last activity, so `age` (hours) sets the order.
function thread(id: string, age: number, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id,
    title: id,
    displayTitle: id,
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
    createdAt: NOW - 96 * HOUR,
    updatedAt: NOW - age * 60_000,
    lastReadAt: null,
    latestAttentionAt: NOW - age * 60_000,
    ...overrides,
  };
}

const projects = [{ id: "p1", name: "web-app", isPersonal: false, href: "/projects/p1", settingsHref: "/projects/p1/settings" }];

async function mount(threads: PluginSidebarThread[]) {
  const app = await loadPluginApp(() => import("./app"));
  const list = app.threadLists.find((item) => item.id === "triage")!;
  return renderSlot(
    list,
    { activeThreadId: null, onNavigate: () => {} },
    {
      settings: { nowQueue: false },
      rpc: {
        state_get: () => state,
        workspaces_get: () => ({ workspaces: [], threadWorkspaces: {} }),
      } as never,
      sidebarThreads: { status: "ready", threads, projects, sections: [] },
    },
  );
}

const rows = (root: HTMLElement) => [...root.querySelectorAll("[data-jb-flow-row]")].map((row) => row.getAttribute("data-jb-flow-row"));
const row = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-jb-flow-row="${id}"]`)!;
const toggleOf = (root: HTMLElement, id: string) => row(root, id).querySelector<HTMLButtonElement>("button[aria-expanded]");

const family = () => [
  thread("parent", 1),
  thread("other", 2),
  thread("child-a", 3, { parentThreadId: "parent" }),
  thread("grandchild", 4, { parentThreadId: "child-a" }),
  thread("child-b", 5, { parentThreadId: "parent" }),
];

describe("Subthreads", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("shows each subthread under its parent, indented, and nowhere else", async () => {
    const slot = await mount(family());
    await waitFor(() => expect(rows(slot.container)).toEqual(["parent", "child-a", "grandchild", "child-b", "other"]));
    expect(row(slot.container, "parent").hasAttribute("data-jb-flow-subthread")).toBe(false);
    expect(row(slot.container, "child-a").style.marginLeft).toBe("1rem");
    expect(row(slot.container, "grandchild").style.marginLeft).toBe("2rem");
    expect(toggleOf(slot.container, "parent")?.getAttribute("aria-expanded")).toBe("true");
    expect(toggleOf(slot.container, "other")).toBeNull();
  });

  it("folds a thread's subthreads into a count, and remembers it", async () => {
    const slot = await mount(family());
    await waitFor(() => expect(toggleOf(slot.container, "parent")).not.toBeNull());
    fireEvent.click(toggleOf(slot.container, "parent")!);
    await waitFor(() => expect(rows(slot.container)).toEqual(["parent", "other"]));
    expect(row(slot.container, "parent").querySelector("[data-jb-flow-subthread-count]")?.textContent).toBe("3");
    cleanup();

    const again = await mount(family());
    await waitFor(() => expect(rows(again.container)).toEqual(["parent", "other"]));
    fireEvent.click(toggleOf(again.container, "parent")!);
    await waitFor(() => expect(rows(again.container)).toEqual(["parent", "child-a", "grandchild", "child-b", "other"]));
  });

  it("folds and unfolds with the arrow keys", async () => {
    const slot = await mount(family());
    await waitFor(() => expect(rows(slot.container)).toContain("grandchild"));
    fireEvent.keyDown(row(slot.container, "child-a"), { key: "ArrowLeft" });
    await waitFor(() => expect(rows(slot.container)).toEqual(["parent", "child-a", "child-b", "other"]));
    fireEvent.keyDown(row(slot.container, "child-a"), { key: "ArrowRight" });
    await waitFor(() => expect(rows(slot.container)).toContain("grandchild"));
  });

  it("a folded parent says when a subthread needs you", async () => {
    const slot = await mount([thread("parent", 1), thread("child", 2, { parentThreadId: "parent", hasPendingInteraction: true })]);
    await waitFor(() => expect(toggleOf(slot.container, "parent")).not.toBeNull());
    fireEvent.click(toggleOf(slot.container, "parent")!);
    await waitFor(() => expect(row(slot.container, "parent").querySelector("[data-jb-flow-subthread-count]")?.getAttribute("title")).toBe("1 subthread, one needs you"));
  });

  it("a subthread whose parent is archived keeps a row of its own", async () => {
    const slot = await mount([thread("gone", 1, { isArchived: true, archivedAt: NOW }), thread("orphan", 2, { parentThreadId: "gone" })]);
    await waitFor(() => expect(rows(slot.container)).toEqual(["orphan"]));
    expect(row(slot.container, "orphan").hasAttribute("data-jb-flow-subthread")).toBe(false);
  });
});
