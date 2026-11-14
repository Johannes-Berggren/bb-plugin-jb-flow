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
      { threadId: "thr_b", kind: "decision", headline: "Pick a chart library", summary: "The dashboard needs charts; two libraries fit.", recommendation: "Option 2: smaller bundle", reply: "2" },
      { threadId: "thr_c", kind: "fyi", summary: "Already dealt with." },
    ],
    handled: [{ threadId: "thr_a", what: "Merged acme/web-app#12" }],
  },
  resolved: ["thr_c"],
  contexts: {
    thr_a: {
      status: "idle",
      waitingSince: NOW - 2 * 3_600_000,
      dueAt: null,
      dueReason: null,
      goal: "Ship the billing export",
      next: "Deploy once you say go",
      blocked: null,
      prs: [{ repo: "acme/web-app", number: 12, attention: "ready_to_merge", url: "https://github.com/acme/web-app/pull/12", title: "Fix export" }],
      options: [],
      optionsMode: null,
    },
    thr_b: {
      status: "idle",
      waitingSince: NOW - 3 * 86_400_000,
      dueAt: NOW + 86_400_000 * 1.5,
      dueReason: "Design review",
      goal: "Charts for the dashboard",
      next: null,
      blocked: null,
      prs: [],
      options: [
        { n: 1, text: "Recharts: familiar, larger bundle", recommended: false },
        { n: 2, text: "uPlot: smaller bundle", recommended: true },
      ],
      optionsMode: "choice",
    },
  },
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
        conductor_fleet: () => [],
        conductor_start: () => ({ threadId: "thr_conductor" }),
        ...options.rpc,
      } as never,
      sidebarThreads: { status: "ready", threads, projects, sections: [] },
      realtimeConnectionState: "connected",
    },
  );
}

const items = () => Array.from(document.querySelectorAll<HTMLElement>(".jf-cd-item"));
const cardCalls = (slot: { rpcCalls: Array<{ method: string; input: unknown }> }) =>
  slot.rpcCalls.filter((call) => call.method === "conductor_card").map((call) => call.input);

afterEach(() => cleanup());

describe("Conductor page", () => {
  it("lists the briefing as lines to scan, decisions first, each opening into its context", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(slot.getByRole("tab", { name: /Briefing/ }).textContent).toBe("Briefing2");
    // Decisions come before what's ready to go; each line is its headline.
    expect(items()[0]!.querySelector(".jf-cd-headline")!.textContent).toBe("Pick a chart library");
    expect(items()[1]!.querySelector(".jf-cd-headline")!.textContent).toBe("CI is green; it waits for your go to deploy.");
    expect(items()[0]!.textContent).toContain("due");
    expect(items()[0]!.textContent).toContain("3d");
    // Collapsed, a line carries the recommendation and a one-click answer.
    expect(items()[0]!.querySelector(".jf-cd-row-rec")!.textContent).toBe("Option 2: smaller bundle");
    expect(within(items()[0]!).getByRole("button", { name: "Choose 2" })).toBeTruthy();
    expect(items()[0]!.textContent).not.toContain("Charts for the dashboard");
    fireEvent.click(items()[0]!.querySelector(".jf-cd-row")!);
    expect(items()[0]!.textContent).toContain("Charts for the dashboard");
    expect(slot.container.textContent).toContain("2 waiting in its inbox");
    fireEvent.click(slot.getByRole("button", { name: /Handled by the conductor · 1/ }));
    expect(slot.container.textContent).toContain("Merged acme/web-app#12");
  });

  it("opens another line with its context, PRs included", async () => {
    await mountPanel();
    await waitFor(() => expect(items()).toHaveLength(2));
    fireEvent.click(items()[1]!.querySelector(".jf-cd-row")!);
    expect(items()[1]!.textContent).toContain("Ship the billing export");
    expect(items()[1]!.textContent).toContain("web-app#12 · ready to merge");
    expect(items()[0]!.textContent).not.toContain("Charts for the dashboard");
  });

  it("filters the briefing by kind", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(items()).toHaveLength(2));
    fireEvent.click(within(slot.getByRole("group", { name: "Show" })).getByRole("button", { name: /Decisions/ }));
    expect(items()).toHaveLength(1);
  });

  it("answers with one of the thread's own options", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(items()).toHaveLength(2));
    fireEvent.click(items()[0]!.querySelector(".jf-cd-row")!);
    const options = within(items()[0]!).getByRole("group", { name: "The thread's options" });
    // The conductor's suggestion is option 2, so that option carries it and no separate draft shows.
    expect(within(options).getByRole("button", { name: /uPlot/ }).textContent).toContain("Conductor's pick");
    expect(within(items()[0]!).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(options).getByRole("button", { name: /Recharts/ }));
    await waitFor(() =>
      expect(cardCalls(slot).at(-1)).toEqual({ workspaceId: "ws", threadId: "thr_b", action: "reply", text: "1" }),
    );
  });

  it("sends the suggestion as a go, straight from a line or from the open item", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(items()).toHaveLength(2));
    fireEvent.click(within(items()[0]!).getByRole("button", { name: "Choose 2" }));
    await waitFor(() => expect(cardCalls(slot).at(-1)).toEqual({ workspaceId: "ws", threadId: "thr_b", action: "go" }));
    fireEvent.click(within(items()[1]!).getByRole("button", { name: "Send “go”" }));
    await waitFor(() => expect(cardCalls(slot).at(-1)).toEqual({ workspaceId: "ws", threadId: "thr_a", action: "go" }));
  });

  it("the open item sends the suggestion untouched as a go", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(items()).toHaveLength(2));
    fireEvent.click(items()[1]!.querySelector(".jf-cd-row")!);
    fireEvent.click(within(items()[1]!).getByRole("button", { name: /Send suggested reply/ }));
    await waitFor(() => expect(cardCalls(slot).at(-1)).toEqual({ workspaceId: "ws", threadId: "thr_a", action: "go" }));
  });

  it("an edited suggestion goes out as your own reply", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(items()).toHaveLength(2));
    fireEvent.click(items()[1]!.querySelector(".jf-cd-row")!);
    fireEvent.change(within(items()[1]!).getByRole("textbox"), { target: { value: "Deploy after lunch" } });
    fireEvent.click(within(items()[1]!).getByRole("button", { name: /^Send/ }));
    await waitFor(() =>
      expect(cardCalls(slot).at(-1)).toEqual({ workspaceId: "ws", threadId: "thr_a", action: "reply", text: "Deploy after lunch" }),
    );
  });

  it("snoozes, opens the thread beside the page, and takes keys", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(items()).toHaveLength(2));
    fireEvent.click(items()[0]!.querySelector(".jf-cd-row")!);
    fireEvent.click(within(items()[0]!).getByRole("button", { name: "Open the thread beside this" }));
    expect(slot.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_b", options: { split: true } });
    fireEvent.click(within(items()[0]!).getByRole("button", { name: "Snooze" }));
    fireEvent.click(within(items()[0]!).getByRole("button", { name: "Tomorrow" }));
    await waitFor(() => expect(cardCalls(slot).at(-1)).toEqual({ workspaceId: "ws", threadId: "thr_b", action: "snooze", until: "tomorrow" }));
    const briefing = document.querySelector<HTMLElement>(".jf-cd-briefing")!;
    fireEvent.keyDown(briefing, { key: "j" });
    await waitFor(() => expect(items()[1]!.textContent).toContain("Ship the billing export"));
    fireEvent.keyDown(briefing, { key: "e" });
    await waitFor(() => expect(cardCalls(slot).at(-1)).toEqual({ workspaceId: "ws", threadId: "thr_a", action: "dismiss" }));
  });

  it("sends a line to the conductor itself and opens the conversation", async () => {
    const slot = await mountPanel({ rpc: { thread_reply: () => ({ ok: true }) } });
    await waitFor(() => expect(items()).toHaveLength(2));
    fireEvent.change(slot.getByRole("textbox", { name: "Tell the conductor" }), { target: { value: "2 go, 1 snooze 3d" } });
    fireEvent.click(slot.getByRole("button", { name: "Send to the conductor" }));
    await waitFor(() =>
      expect(slot.rpcCalls.find((call) => call.method === "thread_reply")?.input).toEqual({ threadId: "thr_conductor", text: "2 go, 1 snooze 3d" }),
    );
    await waitFor(() => expect(slot.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true"));
  });

  it("wakes the conductor on request", async () => {
    const slot = await mountPanel();
    await waitFor(() => expect(items()).toHaveLength(2));
    fireEvent.click(slot.getByRole("button", { name: /Wake now/ }));
    await waitFor(() => expect(slot.container.textContent).toContain("Woken with its inbox"));
  });

  it("lists the workspace's threads and the conductor's activity in their tabs", async () => {
    const slot = await mountPanel({
      rpc: {
        conductor_fleet: () => [
          { threadId: "thr_a", title: "Fix billing export", projectId: "p1", state: "yours", reason: "you · 2h", needsYou: true, unread: true, prs: [], next: "Deploy", blocked: null },
        ],
      },
    });
    await waitFor(() => expect(items()).toHaveLength(2));
    fireEvent.click(slot.getByRole("tab", { name: /Threads/ }));
    await waitFor(() => expect(slot.container.textContent).toContain("Needs you"));
    expect(slot.container.textContent).toContain("Next: Deploy");
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
    expect(items()).toHaveLength(0);
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
});
