import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";
import type { WorkspaceState } from "./workspaces";
import { selectWorkspace, setWorkspacesEnabled } from "./workspace-client";
import { CATCH_UP_EVENT } from "./catch-up-model";
import { forgetCatchUp } from "./catch-up";

const NOW = Date.now();

const baseState: FlowState = {
  projectShortNames: {},
  stripProjectPrefixes: [],
  awaiting: {},
  promised: {},
  waitingOthers: {},
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
    indicator: "unread-success",
    indicatorLabel: null,
    isUnread: true,
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
    lastReadAt: NOW - 7_200_000,
    latestAttentionAt: NOW - 3_600_000,
    ...overrides,
  };
}

const projects = [
  { id: "p1", name: "web-app", isPersonal: false, href: "/projects/p1", settingsHref: "/projects/p1/settings" },
  { id: "p2", name: "billing-api", isPersonal: false, href: "/projects/p2", settingsHref: "/projects/p2/settings" },
];

const threads = [
  thread("a", "Fix billing export", { hasPendingInteraction: true, indicator: "waiting-for-input", latestAttentionAt: NOW - 50_000 }),
  thread("c", "Mail templates", { latestAttentionAt: NOW - 40_000 }),
  thread("d", "Release notes", { projectId: "p2", latestAttentionAt: NOW - 30_000 }),
  thread("b", "Deploy the worker", { status: "active", projectId: "p2" }),
  thread("r", "Already read", { isUnread: false }),
];

const report = {
  goal: "Templates render in every mail client",
  done: "Rewrote the layout tables",
  next: "Merge and deploy",
  blocked: "",
  milestones: [],
  steps: { mode: "go" as const, question: "", items: ["Merge the PR", "Deploy to staging", "Tidy the branch"], recommended: [1] },
  capturedAt: NOW,
};

function card(threadId: string) {
  const since = { turns: 2, yourPrompts: 1, otherPrompts: 0, more: false, firstAt: NOW - 60_000 };
  if (threadId === "c") {
    const move = { mode: "go", options: report.steps.items.map((text, index) => ({ n: index + 1, text, recommended: index === 0 })) };
    return { reply: "Done.\n\n**Goal:** …", truncated: false, report, move, since };
  }
  return { reply: `Latest reply for ${threadId}`, truncated: false, report: null, move: { mode: "choice", options: [] }, since };
}

type MountOptions = {
  settings?: Record<string, boolean>;
  state?: Partial<FlowState>;
  workspaces?: WorkspaceState;
  threads?: PluginSidebarThread[];
  rpc?: Record<string, (input: never) => unknown>;
  slot?: "overlay" | "panel";
};

async function mount(options: MountOptions = {}) {
  const app = await loadPluginApp(() => import("./app"));
  const registration =
    options.slot === "panel"
      ? app.navPanels.find((item) => item.id === "catch-up")!
      : app.appOverlays.find((item) => item.id === "catch-up")!;
  const state = { ...baseState, ...options.state };
  return renderSlot(
    registration as never,
    { subPath: "" } as never,
    {
      settings: { catchUp: true, ...options.settings },
      rpc: {
        state_get: () => state,
        workspaces_get: () => options.workspaces ?? { workspaces: [], threadWorkspaces: {} },
        catch_up_card: (input: { threadId: string }) => card(input.threadId),
        thread_reply: () => ({ ok: true }),
        snooze: (input: { until?: number }) => ({ until: input.until ?? NOW, note: null, fromSectionId: null, snoozedAt: NOW }),
        unsnooze: () => ({ removed: true }),
        archive: (input: { threadIds: string[] }) => ({ archived: input.threadIds.length, failed: [] }),
        ...options.rpc,
      } as never,
      sidebarThreads: { status: "ready", threads: options.threads ?? threads, projects, sections: [] },
      sdk: {
        subscribe: (() => () => {}) as never,
        threads: {
          markRead: (async () => ({})) as never,
          markUnread: (async () => ({})) as never,
          unarchive: (async () => ({})) as never,
        },
      },
      realtimeConnectionState: "connected",
    },
  );
}

const deck = () => document.querySelector<HTMLElement>(".jf-catchup")!;
const press = (key: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(deck(), { key, ...init });
const title = () => document.querySelector(".jf-catchup-title")?.textContent;

async function openDeck() {
  act(() => {
    window.dispatchEvent(new CustomEvent(CATCH_UP_EVENT));
  });
  await waitFor(() => expect(document.querySelector(".jf-catchup-card")).not.toBeNull());
}

const marks = (slot: Awaited<ReturnType<typeof mount>>, method: string) =>
  slot.sdkCalls.filter((call) => call.method === method).map((call) => (call.args[0] as { threadId: string }).threadId);

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  forgetCatchUp();
});
afterEach(() => {
  cleanup();
  selectWorkspace(null);
  setWorkspacesEnabled(false);
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("Catch up", () => {
  it("does nothing while the setting is off", async () => {
    await mount({ settings: { catchUp: false } });
    act(() => {
      window.dispatchEvent(new CustomEvent(CATCH_UP_EVENT));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector(".jf-catchup")).toBeNull();
  });

  it("deals unread threads, needs-you first, and skips running and read ones", async () => {
    await mount();
    await openDeck();
    expect(title()).toBe("Fix billing export");
    expect(deck().textContent).toContain("1 of 3");
    expect(deck().textContent).toContain("Needs your input");
    expect(deck().textContent).toContain("Since you looked");
  });

  it("→ marks read and moves on; ← keeps it unread; z undoes", async () => {
    const slot = await mount();
    await openDeck();
    press("ArrowRight");
    await waitFor(() => expect(title()).toBe("Mail templates"));
    expect(marks(slot, "threads.markRead")).toEqual(["a"]);
    press("ArrowLeft");
    await waitFor(() => expect(title()).toBe("Release notes"));
    expect(marks(slot, "threads.markRead")).toEqual(["a"]);
    press("z");
    await waitFor(() => expect(title()).toBe("Mail templates"));
    press("z");
    await waitFor(() => expect(title()).toBe("Fix billing export"));
    await waitFor(() => expect(marks(slot, "threads.markUnread")).toEqual(["a"]));
  });

  it("shows a status report with next steps and sends the pick with g", async () => {
    const slot = await mount();
    await openDeck();
    press("u");
    await waitFor(() => expect(title()).toBe("Mail templates"));
    await waitFor(() => expect(deck().textContent).toContain("Templates render in every mail client"));
    expect(deck().textContent).toContain("Merge and deploy");
    press("1");
    press("3");
    await waitFor(() => expect(within(deck()).getByRole("button", { name: /Go with 1, 3/ })).toBeTruthy());
    press("g");
    await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "thread_reply")).toBe(true));
    const reply = slot.rpcCalls.find((call) => call.method === "thread_reply")!;
    expect(reply.input).toEqual({ threadId: "c", text: "go 1,3" });
    await waitFor(() => expect(title()).toBe("Release notes"));
    expect(marks(slot, "threads.markRead")).toContain("c");
    press("z");
    await waitFor(() => expect(deck().textContent).toContain("can't be undone"));
  });

  it("renders the last reply as Markdown when there's no report", async () => {
    await mount();
    await openDeck();
    press("u");
    press("u");
    await waitFor(() => expect(title()).toBe("Release notes"));
    await waitFor(() => expect(within(deck()).getByTestId("bb-markdown").textContent).toBe("Latest reply for d"));
  });

  it("holds an archive for undo and commits it on close", async () => {
    const slot = await mount();
    await openDeck();
    press("e");
    await waitFor(() => expect(title()).toBe("Mail templates"));
    press("z");
    await waitFor(() => expect(title()).toBe("Fix billing export"));
    expect(slot.rpcCalls.some((call) => call.method === "archive")).toBe(false);
    press("e");
    await waitFor(() => expect(title()).toBe("Mail templates"));
    fireEvent.click(within(deck()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(slot.rpcCalls.find((call) => call.method === "archive")?.input).toEqual({ threadIds: ["a"] }));
  });

  it("snoozes from the sheet and opens a thread with o", async () => {
    const slot = await mount();
    await openDeck();
    press("s");
    const custom = await waitFor(() => within(deck()).getByLabelText("Custom snooze time"));
    fireEvent.change(custom, { target: { value: "3d" } });
    fireEvent.submit(custom.closest("form")!);
    await waitFor(() => expect(title()).toBe("Mail templates"));
    expect(slot.rpcCalls.find((call) => call.method === "snooze")?.input).toMatchObject({ threadId: "a", when: "3d", note: null });
    press("o");
    await waitFor(() => expect(slot.navigateCalls).toContainEqual({ method: "toThread", threadId: "c", options: undefined }));
  });

  it("ends with what you did, and Mark all read leaves what needs you", async () => {
    const slot = await mount();
    await openDeck();
    fireEvent.click(within(deck()).getByRole("button", { name: "Mark all read" }));
    expect(deck().textContent).toContain("Mark 2 updates read? The thread that needs you stays.");
    press("Enter");
    await waitFor(() => expect(marks(slot, "threads.markRead").sort()).toEqual(["c", "d"]));
    expect(title()).toBe("Fix billing export");
    press("ArrowRight");
    await waitFor(() => expect(deck().textContent).toContain("You're all caught up"));
    expect(deck().textContent).toContain("3 read");
    expect(deck().textContent).toContain("1 thread still working");
  });

  it("covers the selected workspace, with a chip for all of them", async () => {
    setWorkspacesEnabled(true);
    selectWorkspace("ws-billing");
    await mount({
      settings: { workspaces: true },
      workspaces: {
        workspaces: [{ id: "ws-billing", name: "Billing", projectIds: ["p2"], sectionIds: [], pluginIds: [], sectionOrder: [] }],
        threadWorkspaces: {},
      },
    });
    await openDeck();
    expect(title()).toBe("Release notes");
    expect(deck().textContent).toContain("1 of 1");
    fireEvent.click(within(deck()).getByRole("button", { name: "Billing" }));
    await waitFor(() => expect(title()).toBe("Fix billing export"));
    expect(deck().textContent).toContain("1 of 3");
  });

  it("runs as the Catch up page, with a badge for the nav entry", async () => {
    await mount({ slot: "panel" });
    await waitFor(() => expect(title()).toBe("Fix billing export"));
    const app = await loadPluginApp(() => import("./app"));
    const panel = app.navPanels.find((item) => item.id === "catch-up")!;
    const Badge = () => <pre data-testid="badge">{JSON.stringify(panel.experimental_useBadge!())}</pre>;
    const badge = renderSlot({ component: Badge }, {}, {
      settings: { catchUp: true },
      rpc: { state_get: () => baseState, workspaces_get: () => ({ workspaces: [], threadWorkspaces: {} }) } as never,
      sidebarThreads: { status: "ready", threads, projects, sections: [] },
      realtimeConnectionState: "connected",
    });
    await waitFor(() =>
      expect(JSON.parse(badge.getByTestId("badge").textContent!)).toEqual({ count: 3, tone: "critical", label: "3 unread threads · 1 needs you" }),
    );
  });

  it("says it's off on the page when the setting is off", async () => {
    const slot = await mount({ slot: "panel", settings: { catchUp: false } });
    await waitFor(() => expect(slot.container.textContent).toContain("Catch up is off"));
  });
});
