import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { OPEN_QUEUE_EVENT, STATUS_PANES_EVENT } from "./pane-commands-model";

const thread = (id: string, overrides: Partial<PluginSidebarThread> = {}) =>
  ({
    id,
    projectId: "p",
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
const panes = (...threadIds: (string | null)[]) => ({
  panes: threadIds.map((threadId, index) => ({
    paneId: `p${index}`,
    rect: { x: index / threadIds.length, y: 0, width: 1 / threadIds.length, height: 1 },
    threadId,
    isFocused: index === 0,
  })),
});
const sidebarThreads = (threads: PluginSidebarThread[]) => ({ status: "ready" as const, projects: [], threads, sections: [] });

afterEach(() => {
  cleanup();
});

async function host(options: Parameters<typeof renderSlot>[2]) {
  const app = await loadPluginApp(() => import("./app"));
  return renderSlot(app.appOverlays.find((overlay) => overlay.id === "pane-commands")!, {}, options);
}
const opened = (slot: Awaited<ReturnType<typeof host>>) =>
  slot.navigateCalls.flatMap((call) => (call.method === "toThread" ? [[call.threadId, call.options?.split === true] as const] : []));

it("opens what needs you beside the open panes, most urgent first, and ends on the most urgent", async () => {
  const slot = await host({
    rpc: { needs_me_queue: () => ({ threadIds: ["a", "b", "c", "d"] }) },
    sidebarSplitLayout: panes("b", null),
  });
  window.dispatchEvent(new CustomEvent(OPEN_QUEUE_EVENT));
  // b is already open; the rest open as splits, then focus returns to the first.
  await waitFor(() =>
    expect(opened(slot)).toEqual([
      ["a", true],
      ["c", true],
      ["d", true],
      ["a", true],
    ]),
  );
  slot.lifecycle.unmount();
});

it("opens nothing into a full split, and stops after one thread where splits are off", async () => {
  const full = await host({
    rpc: { needs_me_queue: () => ({ threadIds: ["a", "b"] }) },
    sidebarSplitLayout: panes(null, null, null, null, null, null, null, null),
  });
  window.dispatchEvent(new CustomEvent(OPEN_QUEUE_EVENT));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(opened(full)).toEqual([]);
  full.lifecycle.unmount();

  // One pane and no split layout: after the first thread no split appears, so it goes no further.
  const single = await host({ rpc: { needs_me_queue: () => ({ threadIds: ["a", "b", "c"] }) } });
  window.dispatchEvent(new CustomEvent(OPEN_QUEUE_EVENT));
  await waitFor(() => expect(opened(single)).toEqual([["a", true]]));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(opened(single)).toEqual([["a", true]]);
  single.lifecycle.unmount();
});

it("asks only the resting panes with an out-of-date status, and only after the button is pressed", async () => {
  const replies: { threadId: string; text: string }[] = [];
  const now = Date.now();
  const current = { goal: "g", done: "d", next: "n", blocked: "", milestones: [], capturedAt: now - 60_000 };
  const statuses: Record<string, unknown> = {
    stale: { threadId: "stale", report: null, latest: "", latestAt: now, replyHash: "" },
    fresh: { threadId: "fresh", report: current, latest: "", latestAt: current.capturedAt, replyHash: "" },
    busy: { threadId: "busy", report: null, latest: "", latestAt: now, replyHash: "" },
    asking: { threadId: "asking", report: null, latest: "", latestAt: now, replyHash: "" },
  };
  const slot = await host({
    settings: { threadMonitor: true },
    rpc: {
      thread_status: (input: unknown) => statuses[(input as { threadId: string }).threadId] ?? null,
      thread_reply: (input: unknown) => {
        replies.push(input as { threadId: string; text: string });
        return { ok: true };
      },
    },
    sidebarThreads: sidebarThreads([thread("stale"), thread("fresh"), thread("busy", { status: "active" }), thread("asking", { hasPendingInteraction: true })]),
    sidebarSplitLayout: panes("stale", "fresh", "busy", "asking", null),
  });
  window.dispatchEvent(new CustomEvent(STATUS_PANES_EVENT));
  const dialog = within(await within(document.body).findByRole("dialog"));
  const list = within(await dialog.findByRole("list", { name: "Threads to ask" }));
  // The working thread and the one waiting on an answer are never asked.
  expect(list.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Thread staleNo status report yet"]);
  expect(replies).toEqual([]);
  fireEvent.click(dialog.getByRole("button", { name: "Ask 1 thread" }));
  await waitFor(() => expect(replies).toHaveLength(1));
  expect(replies[0]!.threadId).toBe("stale");
  expect(replies[0]!.text).toContain("**Goal:**");
  await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
  slot.lifecycle.unmount();
});

it("says so when every resting pane is current, and does nothing with the thread monitor off", async () => {
  const now = Date.now();
  const report = { goal: "g", done: "d", next: "n", blocked: "", milestones: [], capturedAt: now - 60_000 };
  const reply = vi.fn();
  const current = await host({
    settings: { threadMonitor: true },
    rpc: { thread_status: () => ({ threadId: "a", report, latest: "", latestAt: report.capturedAt, replyHash: "" }), thread_reply: reply },
    sidebarThreads: sidebarThreads([thread("a")]),
    sidebarSplitLayout: panes("a", null),
  });
  window.dispatchEvent(new CustomEvent(STATUS_PANES_EVENT));
  const dialog = within(await within(document.body).findByRole("dialog"));
  await dialog.findByText("Every open pane that is at rest has a current status report.");
  expect(dialog.queryByRole("button", { name: /^Ask/ })).toBeNull();
  // The dialog's own corner button is also named Close; the first is the footer's.
  fireEvent.click(dialog.getAllByRole("button", { name: "Close" })[0]!);
  await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
  current.lifecycle.unmount();

  const off = await host({ settings: { threadMonitor: false }, sidebarThreads: sidebarThreads([thread("a")]), sidebarSplitLayout: panes("a", null) });
  window.dispatchEvent(new CustomEvent(STATUS_PANES_EVENT));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(within(document.body).queryByRole("dialog")).toBeNull();
  expect(reply).not.toHaveBeenCalled();
  off.lifecycle.unmount();
});
