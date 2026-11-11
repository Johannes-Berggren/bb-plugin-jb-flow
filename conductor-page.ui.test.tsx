import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ConductorPage, ConductorStatus, FlowState } from "./server";
import type { WorkspaceState } from "./workspaces";

const NOW = Date.now();

const baseState = {
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
} satisfies FlowState;

const workspaces: WorkspaceState = {
  workspaces: [{ id: "ws", name: "Web", projectIds: ["p1"], sectionIds: [], pluginIds: [], sectionOrder: [] }],
  threadWorkspaces: {},
};

function thread(id: string, title: string): PluginSidebarThread {
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
  };
}

const threads = [thread("thr_a", "Fix billing export"), thread("thr_b", "Chart library"), thread("thr_c", "Old item")];
const projects = [{ id: "p1", name: "web-app", isPersonal: false, href: "/projects/p1", settingsHref: "/projects/p1/settings" }];

const status: ConductorStatus = {
  workspaceId: "ws",
  name: "Web",
  enabled: true,
  active: true,
  threadId: "thr_conductor",
  open: 2,
  undelivered: 0,
  needsYou: 2,
};

const page: ConductorPage = {
  workspaceId: "ws",
  threadId: "thr_conductor",
  threadStatus: "idle",
  active: true,
  briefing: {
    at: NOW - 60_000,
    items: [
      { threadId: "thr_a", kind: "ready", summary: "CI is green; it waits for your go to deploy.", recommendation: "Deploy", reply: "go" },
      { threadId: "thr_b", kind: "decision", summary: "Pick a chart library.", recommendation: "Option 2: smaller bundle", reply: "2" },
      { threadId: "thr_c", kind: "fyi", summary: "Already dealt with." },
    ],
    handled: [{ threadId: "thr_a", what: "Merged acme/web-app#12" }],
  },
  resolved: ["thr_c"],
  log: [{ id: 1, at: NOW - 30_000, kind: "merged", threadId: "thr_a", text: "Merged acme/web-app#12." }],
  open: 2,
  lastWakeAt: NOW - 120_000,
};

async function mountPanel(options: { settings?: Record<string, boolean>; subPath?: string; rpc?: Record<string, (input: never) => unknown> } = {}) {
  const app = await loadPluginApp(() => import("./app"));
  const panel = app.navPanels.find((item) => item.id === "conductor")!;
  return renderSlot(
    panel as never,
    { subPath: options.subPath ?? "ws" } as never,
    {
      settings: { conductor: true, workspaces: true, ...options.settings },
      rpc: {
        state_get: () => baseState,
        workspaces_get: () => workspaces,
        conductor_list: () => ({ enabled: true, conductors: [status] }),
        conductor_page: () => page,
        conductor_card: () => ({ done: "ok" }),
        conductor_wake: () => ({ result: "woken" }),
        conductor_start: () => ({ threadId: "thr_conductor" }),
        ...options.rpc,
      } as never,
      sidebarThreads: { status: "ready", threads, projects, sections: [] },
      realtimeConnectionState: "connected",
    },
  );
}

const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".jf-conductor-card"));

afterEach(() => cleanup());

describe("Conductor page", () => {
  it("shows the briefing as cards, leaving out the ones you've dealt with", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(slot.container.textContent).toContain("Needs you · 2");
    expect(cards()[0]!.textContent).toContain("Fix billing export");
    expect(cards()[1]!.textContent).toContain("Option 2: smaller bundle");
    expect(slot.container.textContent).toContain("2 in its inbox");
    fireEvent.click(slot.getByRole("button", { name: "Handled · 1" }));
    expect(slot.container.textContent).toContain("Merged acme/web-app#12");
  });

  it("Go sends the card's reply to its worker through the server", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.click(within(cards()[1]!).getByRole("button", { name: "Go" }));
    await waitFor(() =>
      expect(slot.rpcCalls.find((call) => call.method === "conductor_card")?.input).toEqual({ workspaceId: "ws", threadId: "thr_b", action: "go" }),
    );
  });

  it("Reply sends your own text, and Snooze picks a time", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Reply…" }));
    fireEvent.change(within(cards()[0]!).getByRole("textbox"), { target: { value: "Deploy after lunch" } });
    fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(slot.rpcCalls.find((call) => call.method === "conductor_card")?.input).toEqual({
        workspaceId: "ws",
        threadId: "thr_a",
        action: "reply",
        text: "Deploy after lunch",
      }),
    );
    fireEvent.click(within(cards()[1]!).getByRole("button", { name: "Snooze" }));
    fireEvent.click(within(cards()[1]!).getByRole("button", { name: "Tomorrow" }));
    await waitFor(() =>
      expect(slot.rpcCalls.filter((call) => call.method === "conductor_card").at(-1)?.input).toEqual({
        workspaceId: "ws",
        threadId: "thr_b",
        action: "snooze",
        until: "tomorrow",
      }),
    );
  });

  it("wakes the conductor on request", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.click(slot.getByRole("button", { name: "Wake now" }));
    await waitFor(() => expect(slot.container.textContent).toContain("Woken with its inbox."));
  });

  it("offers to start one for a workspace without a conductor", async () => {
    const slot = await mountPanel({ rpc: { conductor_list: () => ({ enabled: true, conductors: [] }) } });
    await waitFor(() => expect(slot.container.textContent).toContain("This workspace has no conductor yet."));
    fireEvent.click(slot.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(slot.rpcCalls.find((call) => call.method === "conductor_start")?.input).toEqual({ workspaceId: "ws" }));
  });

  it("says it's off while the setting is off", async () => {
    const slot = await mountPanel({ settings: { conductor: false } });
    await waitFor(() => expect(slot.container.textContent).toContain("Conductor is off"));
    expect(cards()).toHaveLength(0);
  });

  it("badges the nav entry with what the running conductors' briefings still need from you", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const panel = app.navPanels.find((item) => item.id === "conductor")!;
    const Badge = () => <pre data-testid="badge">{JSON.stringify(panel.experimental_useBadge!())}</pre>;
    const badge = renderSlot({ component: Badge }, {}, {
      settings: { conductor: true },
      rpc: { conductor_list: () => ({ enabled: true, conductors: [status, { ...status, workspaceId: "off", active: false, needsYou: 5 }] }) } as never,
      realtimeConnectionState: "connected",
    });
    await waitFor(() =>
      expect(JSON.parse(badge.getByTestId("badge").textContent!)).toEqual({ count: 2, tone: "critical", label: "2 items in your conductors' briefings" }),
    );
  });

  it("lists the conductor's activity in its side-panel tab", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const panel = app.navPanels.find((item) => item.id === "conductor")!;
    const tab = panel.fixedTabs!.find((item) => item.id === "activity")!;
    const slot = renderSlot(tab as never, { subPath: "ws" } as never, {
      settings: { conductor: true },
      rpc: { conductor_page: () => page } as never,
      realtimeConnectionState: "connected",
    });
    await waitFor(() => expect(slot.container.textContent).toContain("Merged acme/web-app#12."));
  });
});
