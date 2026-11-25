import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
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
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
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
};

const page: ConductorPage = {
  workspaceId: "ws",
  threadId: "thr_conductor",
  threadStatus: "idle",
  active: true,
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
        conductor_wake: () => ({ result: "woken" }),
        conductor_fleet: () => [],
        conductor_start: () => ({ threadId: "thr_conductor" }),
        ...options.rpc,
      } as never,
      sidebarThreads: { status: "ready", threads, projects, sections: [] },
      realtimeConnectionState: "connected",
    },
  );
}

afterEach(() => cleanup());

describe("Conductor page", () => {
  it("opens on the conductor's conversation, with no briefing to work through", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(slot.container.textContent).toContain("2 waiting in its inbox"));
    expect(slot.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Conversation", "Threads", "Activity"]);
    expect(slot.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true");
  });

  it("wakes the conductor on request", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(slot.container.textContent).toContain("2 waiting in its inbox"));
    fireEvent.click(slot.getByRole("button", { name: /Wake now/ }));
    await waitFor(() => expect(slot.container.textContent).toContain("Woken with its inbox"));
  });

  it("lists the workspace's threads and the conductor's activity in their tabs", async () => {
    const slot = await mountPanel({
      rpc: {
        conductor_fleet: () => [
          { threadId: "thr_a", title: "Fix billing export", parentTitle: null, projectId: "p1", state: "yours", group: "needs-you", reason: "you · 2h", needsYou: true, unread: true, prs: [], next: "Deploy", blocked: null },
          { threadId: "thr_b", title: "Verify invoices", parentTitle: "Fix billing export", projectId: "p1", state: "blocked", group: "stuck", reason: "failed", needsYou: true, unread: false, prs: [], next: null, blocked: "Test job stopped" },
          { threadId: "thr_c", title: "Update docs", parentTitle: null, projectId: "p1", state: "cold", group: "archive-candidate", reason: "worker reports completion", needsYou: false, unread: false, prs: [], next: "Nothing pending.", blocked: null },
        ],
      },
    });
    await waitFor(() => expect(slot.getByRole("tab", { name: /Threads/ }).textContent).toBe("Threads2"));
    fireEvent.click(slot.getByRole("tab", { name: /Threads/ }));
    await waitFor(() => expect(slot.container.textContent).toContain("Needs you"));
    expect(slot.container.textContent).toContain("Next: Deploy");
    expect(slot.container.textContent).toContain("Subthread of Fix billing export");
    expect(slot.container.textContent).toContain("Blocked: Test job stopped");
    expect(slot.container.textContent).toContain("Archive candidates");
    fireEvent.click(slot.getByRole("button", { name: "Fix billing export" }));
    expect(slot.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_a", options: { split: true } });
    fireEvent.click(slot.getByRole("tab", { name: "Activity" }));
    await waitFor(() => expect(slot.container.textContent).toContain("Merged acme/web-app#12."));
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
    expect(slot.queryAllByRole("tab")).toHaveLength(0);
  });

  it("puts no count on its navigation entry", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const panel = app.navPanels.find((item) => item.id === "conductor")!;
    expect(panel.experimental_useBadge).toBeUndefined();
  });
});
