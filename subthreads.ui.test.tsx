import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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
  // Flow state is cached between mounts, so the Done test's PRs live here.
  threadPrs: Object.fromEntries(
    ["finished", "busy-parent"].map((id) => [
      id,
      [{ repo: "acme/web-app", number: 1, title: "Merged", url: "https://github.com/acme/web-app/pull/1", state: "merged" as const, attention: "merged" as const, base: "main", head: "feature", stackedOn: null, checkedAt: NOW }],
    ]),
  ),
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
    parentNotifications: "auto",
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

async function mount(threads: PluginSidebarThread[], settings: Record<string, unknown> = {}, rpc: Record<string, (input: never) => unknown> = {}) {
  const app = await loadPluginApp(() => import("./app"));
  const list = app.threadLists.find((item) => item.id === "triage")!;
  return renderSlot(
    list,
    { activeThreadId: null, onNavigate: () => {} },
    {
      settings: { nowQueue: false, ...settings },
      rpc: {
        state_get: () => state,
        workspaces_get: () => ({ workspaces: [], threadWorkspaces: {} }),
        archive: (input: { threadIds: string[] }) => ({ archived: input.threadIds.length, failed: [] }),
        ...rpc,
      } as never,
      sidebarThreads: { status: "ready", threads, projects, sections: [] },
    },
  );
}

const rows = (root: HTMLElement) => [...root.querySelectorAll("[data-jb-flow-row]")].map((row) => row.getAttribute("data-jb-flow-row"));
const row = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-jb-flow-row="${id}"]`)!;
const toggleOf = (root: HTMLElement, id: string) => row(root, id).querySelector<HTMLButtonElement>("button[aria-expanded]");

const heading = (root: HTMLElement, title: string) =>
  within(root)
    .queryAllByRole("button")
    .find((button) => button.getAttribute("aria-expanded") !== null && button.textContent?.startsWith(title));
const rowsUnder = (root: HTMLElement, title: string) => {
  const section = heading(root, title)?.closest("section");
  return section ? [...section.querySelectorAll("[data-jb-flow-row]")].map((row) => row.getAttribute("data-jb-flow-row")) : null;
};
const headerCount = (root: HTMLElement, title: string) => heading(root, title)?.parentElement?.lastElementChild?.textContent;
/** The count in the header of the group a row is in. */
const groupCount = (root: HTMLElement, id: string) => row(root, id).closest("section")?.querySelector("[data-jb-flow-section-header] > span:last-child")?.textContent;
const chip = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>(".jf-filter-chip")].find((button) => button.querySelector(".jf-filter-label")?.textContent === label);
const chipCount = (root: HTMLElement, label: string) => chip(root, label)?.querySelector(".jf-filter-count")?.textContent;
const needsInput = { hasPendingInteraction: true, isUnread: true };
const running = { status: "active" } as const;

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

  it("a subthread that needs you brings its parent into Needs me, and counts there", async () => {
    const slot = await mount([thread("parent", 1), thread("other", 2), thread("child", 3, { parentThreadId: "parent", ...needsInput }), thread("sibling", 4, { parentThreadId: "parent" })]);
    await waitFor(() => expect(rowsUnder(slot.container, "Needs me")).toEqual(["parent", "child", "sibling"]));
    expect(chipCount(slot.container, "Needs me")).toBe("1");
    expect(headerCount(slot.container, "Needs me")).toBe("1");
    // The parent moved up with it: it isn't also in its lane.
    expect(rows(slot.container).filter((id) => id === "parent")).toHaveLength(1);
  });

  it("with Now on, a subthread that needs you brings its parent into Now, and says why on its own row", async () => {
    const slot = await mount([thread("parent", 1), thread("child", 2, { parentThreadId: "parent", ...needsInput }), thread("other", 3)], { nowQueue: true });
    await waitFor(() => expect(rowsUnder(slot.container, "Now")).toEqual(["parent", "child"]));
    expect(row(slot.container, "child").querySelector("[data-jb-flow-reason]")?.textContent).toContain("needs input");
    expect(row(slot.container, "parent").querySelector("[data-jb-flow-reason]")).toBeNull();
    expect(rows(slot.container).filter((id) => id === "parent")).toHaveLength(1);
  });

  it("a conductor headline for a subthread shows on its row, or on its parent's row while it's folded away", async () => {
    const briefs = {
      conductor_briefs: () => ({
        briefs: [{ workspaceId: "ws", threadId: "child", at: NOW, item: { threadId: "child", kind: "decision", headline: "Pick a chart library", summary: "Two fit.", recommendation: "Option 2" } }],
      }),
    };
    const threads = () => [thread("parent", 1), thread("child", 2, { parentThreadId: "parent", ...needsInput })];
    const reason = (root: HTMLElement, id: string) => row(root, id)?.querySelector<HTMLElement>("[data-jb-flow-reason]") ?? null;
    const slot = await mount(threads(), { nowQueue: true, conductor: true }, briefs);
    await waitFor(() => expect(reason(slot.container, "child")?.textContent).toBe("Pick a chart library"));
    expect(reason(slot.container, "parent")).toBeNull();
    cleanup();

    localStorage.setItem("jb-flow:collapsed", JSON.stringify({ "subthreads:parent": true }));
    const folded = await mount(threads(), { nowQueue: true, conductor: true }, briefs);
    await waitFor(() => expect(reason(folded.container, "parent")?.textContent).toBe("Pick a chart library"));
    expect(rows(folded.container)).toEqual(["parent"]);
    expect(reason(folded.container, "parent")?.title).toMatch(/\nIn a folded subthread$/);
  });

  it("a filter counts and finds subthreads, showing only those that match, under their parents", async () => {
    const slot = await mount([
      thread("parent", 1),
      thread("other", 2, running),
      thread("child-a", 3, { parentThreadId: "parent" }),
      thread("grandchild", 4, { parentThreadId: "child-a", ...running }),
      thread("child-b", 5, { parentThreadId: "parent" }),
      thread("quiet", 6),
    ]);
    await waitFor(() => expect(chipCount(slot.container, "Running")).toBe("2"));
    fireEvent.click(chip(slot.container, "Running")!);
    await waitFor(() => expect(rows(slot.container)).toEqual(["parent", "child-a", "grandchild", "other"]));
    expect(groupCount(slot.container, "parent")).toBe("2");
  });

  it("a filter shows its matches even under a folded parent", async () => {
    localStorage.setItem("jb-flow:collapsed", JSON.stringify({ "subthreads:parent": true }));
    const slot = await mount([thread("parent", 1), thread("child", 2, { parentThreadId: "parent", ...needsInput }), thread("sibling", 3, { parentThreadId: "parent" })]);
    await waitFor(() => expect(chip(slot.container, "Needs me")).toBeDefined());
    fireEvent.click(chip(slot.container, "Needs me")!);
    await waitFor(() => expect(rows(slot.container)).toEqual(["parent", "child"]));
  });

  it("Done holds a thread only once everything under it is finished; Archive all sends the threads, and bb takes their subthreads", async () => {
    const slot = await mount([
      thread("finished", 300),
      thread("finished-child", 301, { parentThreadId: "finished" }),
      thread("busy-parent", 302),
      thread("busy-child", 303, { parentThreadId: "busy-parent", ...running }),
    ]);
    await waitFor(() => expect(chipCount(slot.container, "Done")).toBe("2"));
    fireEvent.click(chip(slot.container, "Done")!);
    await waitFor(() => expect(rows(slot.container)).toEqual(["finished", "finished-child"]));
    fireEvent.click(within(slot.container).getByRole("button", { name: "Archive all" }));
    await waitFor(() => expect(slot.rpcCalls.find((call) => call.method === "archive")?.input).toEqual({ threadIds: ["finished"] }));
  });

  it("← on a subthread without subthreads moves to its parent", async () => {
    const slot = await mount(family());
    await waitFor(() => expect(rows(slot.container)).toContain("grandchild"));
    row(slot.container, "grandchild").focus();
    fireEvent.keyDown(row(slot.container, "grandchild"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row(slot.container, "child-a"));
    fireEvent.keyDown(row(slot.container, "child-b"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row(slot.container, "parent"));
    // Nothing above a top-level row.
    fireEvent.keyDown(row(slot.container, "other"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row(slot.container, "parent"));
  });

  it("forgets the folds of threads that are gone", async () => {
    localStorage.setItem("jb-flow:collapsed", JSON.stringify({ "subthreads:parent": true, "subthreads:gone": true, "lane:active": false }));
    const slot = await mount(family());
    await waitFor(() => expect(rows(slot.container)).toEqual(["parent", "other"]));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("jb-flow:collapsed")!)).toEqual({ "subthreads:parent": true, "lane:active": false }));
  });
});
