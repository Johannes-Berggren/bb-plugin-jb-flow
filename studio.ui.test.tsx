import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";

const state: FlowState = {
  projectShortNames: {},
  stripProjectPrefixes: [],
  awaiting: {},
  promised: {},
  waitingOthers: {},
  sectionOrder: [],
  machines: {
    hosts: [],
    threadHosts: {},
    environmentHosts: {},
    localHostId: null,
  },
  laneSections: {},
  sectionProjects: {},
  threadPrs: {},
  running: {},
  watching: {},
  snoozedSectionId: null,
  snoozes: {},
  tags: {},
};

function thread(
  id: string,
  title: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
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
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
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
    createdAt: 1,
    updatedAt: 2,
    lastReadAt: null,
    latestAttentionAt: 1,
    ...overrides,
  };
}

async function mount(subPath = "") {
  const app = await loadPluginApp(() => import("./app"));
  const panel = app.navPanels.find((item) => item.id === "studio")!;
  const slot = renderSlot(
    panel,
    { subPath },
    {
      rpc: { state_get: () => state },
      sidebarThreads: {
        status: "ready",
        threads: [
          thread("a", "Fix billing", { hasPendingInteraction: true }),
          thread("b", "Polish navigation", {
            status: "active",
            projectId: "p2",
          }),
        ],
        projects: [
          {
            id: "p1",
            name: "App",
            isPersonal: false,
            href: "/projects/p1",
            settingsHref: "/projects/p1/settings",
          },
          {
            id: "p2",
            name: "BB",
            isPersonal: false,
            href: "/projects/p2",
            settingsHref: "/projects/p2/settings",
          },
        ],
      },
      realtimeConnectionState: "connected",
    },
  );
  return { slot, panel };
}

afterEach(cleanup);

describe("Studio host integration", () => {
  it("combines project, status and title filters and clears an empty result", async () => {
    const { slot } = await mount();
    expect(await slot.findByText("Fix billing")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Filter by project"), {
      target: { value: "p2" },
    });
    expect(slot.queryByText("Fix billing")).toBeNull();
    expect(slot.getByText("Polish navigation")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Search thread titles"), {
      target: { value: "missing" },
    });
    expect(slot.getByText("No matching threads")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Clear filters" }));
    expect(slot.getByText("Polish navigation")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("opens a deep-linked workspace, delegates creation and toggles density", async () => {
    const { slot } = await mount();
    fireEvent.click(await slot.findByRole("button", { name: /Fix billing/ }));
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({
        method: "toPluginPanel",
        path: "studio",
        options: { subPath: "thread/a" },
      }),
    );
    fireEvent.click(slot.getByRole("button", { name: "New thread" }));
    expect(
      slot.inspection.navigateCalls.some((call) => call.method === "toCompose"),
    ).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Compact" }));
    expect(
      slot
        .getByRole("button", { name: "Comfortable" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    slot.lifecycle.unmount();
  });

  it("provides a safe return from missing or archived workspace links", async () => {
    const { slot } = await mount("thread/missing");
    expect(await slot.findByText("Thread unavailable")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Overview" }));
    expect(
      slot.inspection.navigateCalls.some(
        (call) => call.method === "toPluginPanel",
      ),
    ).toBe(true);
    slot.lifecycle.unmount();
  });

  it("opens the registered native review tab and uses host-owned chat", async () => {
    const { slot, panel } = await mount("thread/a");
    expect(
      await slot.findByRole("heading", { name: "Fix billing" }),
    ).toBeTruthy();
    expect(
      slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("a");
    fireEvent.click(slot.getByRole("button", { name: "Review ↗" }));
    expect(panel.fixedTabs?.[0].panelId).toBe("studio");
    expect(slot.inspection.experimental_fixedTabOpenCalls).toHaveLength(1);
    expect(
      slot.getByRole("link", { name: "Open thread ↗" }).getAttribute("href"),
    ).toBe("/projects/p1/threads/a");
    slot.lifecycle.unmount();
  });

  it("focuses title search with slash and filters attention with the summary card", async () => {
    const { slot } = await mount();
    const input = await slot.findByLabelText("Search thread titles");
    fireEvent.keyDown(slot.getByRole("heading", { name: /Room to think/ }), {
      key: "/",
    });
    expect(document.activeElement).toBe(input);
    fireEvent.click(
      slot.getByRole("button", { name: /Needs you.*Decisions & follow-ups/ }),
    );
    expect(slot.getByText("Fix billing")).toBeTruthy();
    expect(slot.queryByText("Polish navigation")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("resyncs workflow state after the shared connection returns", async () => {
    const { slot } = await mount();
    await slot.findByText("Fix billing");
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    expect(slot.getByText("Reconnecting…")).toBeTruthy();
    const calls = slot.inspection.rpcCalls.length;
    await slot.behavior.setRealtimeConnectionState("connected");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slot.inspection.rpcCalls.length).toBeGreaterThan(calls);
    expect(slot.getByText("Live workspace")).toBeTruthy();
    slot.lifecycle.unmount();
  });
});
