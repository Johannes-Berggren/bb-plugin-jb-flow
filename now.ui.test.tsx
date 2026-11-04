import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";

const NOW = Date.now();
const HOUR = 3_600_000;

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
};

function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
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
    updatedAt: NOW - HOUR,
    lastReadAt: null,
    latestAttentionAt: NOW - HOUR,
    ...overrides,
  };
}

const projects = [{ id: "p1", name: "web-app", isPersonal: false, href: "/projects/p1", settingsHref: "/projects/p1/settings" }];

async function mount(options: {
  threads: PluginSidebarThread[];
  state?: Partial<FlowState>;
  settings?: Record<string, unknown>;
  activeThreadId?: string | null;
  focusSet?: (input: { threadId: string; focused: boolean }) => unknown;
}) {
  const app = await loadPluginApp(() => import("./app"));
  const list = app.threadLists.find((item) => item.id === "triage")!;
  const state = { ...baseState, ...options.state };
  return renderSlot(
    list,
    { activeThreadId: options.activeThreadId ?? null, onNavigate: () => {} },
    {
      settings: { nowQueue: true, focusLimit: 7, ...options.settings },
      rpc: {
        state_get: () => state,
        workspaces_get: () => ({ workspaces: [], threadWorkspaces: {} }),
        focus_set: options.focusSet ?? ((input: { focused: boolean }) => ({ focused: input.focused })),
      } as never,
      sidebarThreads: { status: "ready", threads: options.threads, projects, sections: [] },
    },
  );
}

const heading = (root: HTMLElement, title: string) =>
  within(root)
    .queryAllByRole("button")
    .find((button) => button.getAttribute("aria-expanded") !== null && button.textContent?.startsWith(title));

const rowsUnder = (root: HTMLElement, title: string) => {
  const section = heading(root, title)?.closest("section");
  return section ? [...section.querySelectorAll("[data-jb-flow-row]")].map((row) => row.getAttribute("data-jb-flow-row")) : null;
};

/** Flow state is cached between mounts: wait for this test's stars before pressing keys. */
const stars = (root: HTMLElement) => root.querySelectorAll('[aria-label="In Focus"]').length;

describe("Now and Focus", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("with the setting off, Needs me stays, and there's no Now, no star and no f key", async () => {
    const focusSet = vi.fn((input: { focused: boolean }) => ({ focused: input.focused }));
    const slot = await mount({
      threads: [thread("blocked", { hasPendingInteraction: true }), thread("flagged")],
      state: { focused: { flagged: NOW } },
      settings: { nowQueue: false },
      focusSet,
    });
    await waitFor(() => expect(rowsUnder(slot.container, "Needs me")).toEqual(["blocked"]));
    expect(heading(slot.container, "Now")).toBeUndefined();
    expect(heading(slot.container, "Moving")).toBeUndefined();
    expect(slot.container.querySelector('[aria-label="In Focus"]')).toBeNull();
    const row = slot.container.querySelector('[data-jb-flow-row="flagged"]')!;
    fireEvent.keyDown(row, { key: "f" });
    expect(focusSet).not.toHaveBeenCalled();
  });

  it("shows Now in rank order with who holds each thread, and Moving apart", async () => {
    const slot = await mount({
      threads: [
        thread("needs-input", { hasPendingInteraction: true, latestAttentionAt: NOW - HOUR }),
        thread("asked", { latestAttentionAt: NOW - 18 * HOUR }),
        thread("cold", { latestAttentionAt: NOW - 44 * HOUR }),
        thread("watched"),
        thread("lane-row"),
      ],
      state: {
        awaiting: { asked: NOW - 18 * HOUR },
        watching: { watched: { kind: "ci", label: "CI on #1" } },
        focused: { asked: NOW, cold: NOW, watched: NOW },
      },
    });
    await waitFor(() => expect(rowsUnder(slot.container, "Now")).toEqual(["asked", "cold", "needs-input"]));
    const text = (id: string) => slot.container.querySelector(`[data-jb-flow-row="${id}"]`)?.textContent ?? "";
    expect(slot.container.querySelector('[data-jb-flow-row="asked"] [aria-label="In Focus"]')).not.toBeNull();
    expect(slot.container.querySelector('[data-jb-flow-row="needs-input"] [aria-label="In Focus"]')).toBeNull();
    expect(text("asked")).toContain("you · 18h");
    expect(text("cold")).toContain("no next step · 44h");
    expect(text("needs-input")).toContain("needs input · 1h");
    // Moving starts collapsed; its header still counts the thread.
    expect(heading(slot.container, "Moving")?.closest("section")?.textContent).toContain("1");
    expect(slot.container.querySelector('[data-jb-flow-row="watched"]')).toBeNull();
    fireEvent.click(heading(slot.container, "Moving")!);
    await waitFor(() => expect(text("watched")).toContain("CI watch"));
    // A row is in one group only, and everything else keeps its lane.
    expect(slot.container.querySelectorAll('[data-jb-flow-row="asked"]').length).toBe(1);
    expect(slot.container.querySelector('[data-jb-flow-row="lane-row"]')).not.toBeNull();
    expect(rowsUnder(slot.container, "Now")).not.toContain("lane-row");
  });

  it("a focused ask you've read stays in Now", async () => {
    const slot = await mount({
      threads: [thread("read", { isUnread: false, lastReadAt: NOW, updatedAt: NOW, latestAttentionAt: NOW - 18 * HOUR })],
      state: { awaiting: { read: NOW - 18 * HOUR }, focused: { read: NOW } },
    });
    await waitFor(() => expect(rowsUnder(slot.container, "Now")).toEqual(["read"]));
  });

  it("says you're caught up when Now is empty", async () => {
    const slot = await mount({ threads: [] });
    await waitFor(() => expect(slot.container.textContent).toContain("You’re all caught up."));
  });

  it("f adds a thread to Focus and takes it out again", async () => {
    const focusSet = vi.fn((input: { focused: boolean }) => ({ focused: input.focused }));
    const slot = await mount({ threads: [thread("a"), thread("b")], state: { focused: { b: NOW } }, focusSet });
    await waitFor(() => expect(heading(slot.container, "Moving")).toBeDefined());
    fireEvent.click(heading(slot.container, "Moving")!);
    await waitFor(() => expect(stars(slot.container)).toBe(1));
    fireEvent.keyDown(slot.container.querySelector('[data-jb-flow-row="a"]')!, { key: "f" });
    await waitFor(() => expect(focusSet).toHaveBeenCalledWith(expect.objectContaining({ threadId: "a", focused: true })));
    await waitFor(() => expect(slot.container.querySelector('[data-jb-flow-row="b"]')).not.toBeNull());
    fireEvent.keyDown(slot.container.querySelector('[data-jb-flow-row="b"]')!, { key: "f" });
    await waitFor(() => expect(focusSet).toHaveBeenCalledWith(expect.objectContaining({ threadId: "b", focused: false })));
  });

  it("past the limit it asks: drop one to make room, or keep them all", async () => {
    const focusSet = vi.fn((input: { focused: boolean }) => ({ focused: input.focused }));
    const slot = await mount({
      threads: [thread("one"), thread("two"), thread("new")],
      state: { focused: { one: NOW, two: NOW } },
      settings: { focusLimit: 2 },
      focusSet,
    });
    await waitFor(() => expect(heading(slot.container, "Moving")?.closest("section")?.textContent).toContain("2"));
    fireEvent.keyDown(slot.container.querySelector('[data-jb-flow-row="new"]')!, { key: "f" });
    const dialog = await within(document.body).findByRole("dialog");
    expect(dialog.textContent).toContain("Focus is full");
    expect(focusSet).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getAllByRole("button", { name: "Drop" })[0]!);
    await waitFor(() => expect(focusSet).toHaveBeenCalledWith(expect.objectContaining({ threadId: "new", focused: true })));
    expect(focusSet).toHaveBeenCalledWith(expect.objectContaining({ threadId: "one", focused: false }));
    await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
  });

  it("Keep all goes past the limit without dropping anything", async () => {
    const focusSet = vi.fn((input: { focused: boolean }) => ({ focused: input.focused }));
    const slot = await mount({
      threads: [thread("one"), thread("new")],
      state: { focused: { one: NOW } },
      settings: { focusLimit: 1 },
      focusSet,
    });
    await waitFor(() => expect(heading(slot.container, "Moving")?.closest("section")?.textContent).toContain("1"));
    fireEvent.keyDown(slot.container.querySelector('[data-jb-flow-row="new"]')!, { key: "f" });
    const dialog = await within(document.body).findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep all" }));
    await waitFor(() => expect(focusSet).toHaveBeenCalledTimes(1));
    expect(focusSet).toHaveBeenCalledWith(expect.objectContaining({ threadId: "new", focused: true }));
  });
});
