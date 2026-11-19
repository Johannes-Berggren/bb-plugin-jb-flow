import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Lane } from "./lanes";

vi.mock("sonner", async (importOriginal) => ({ ...(await importOriginal<typeof import("sonner")>()), toast: vi.fn() }));
const { toast } = await import("sonner");
const { ThreadRow } = await import("./thread-row");

const NOW = Date.now();

function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
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
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
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
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    lastReadAt: null,
    latestAttentionAt: NOW - 60_000,
    ...overrides,
  };
}

const lanes: Lane[] = [
  { id: "priority", title: "Priority", sectionId: "sec_priority", key: "1" },
  { id: "active", title: "Active", sectionId: null, key: "2" },
  { id: "waiting", title: "Waiting for others", sectionId: "sec_waiting", key: "3" },
  { id: "later", title: "Pick up later", sectionId: "sec_later", key: "4" },
  { id: "low", title: "Low priority", sectionId: "sec_low", key: "5" },
];

type Handlers = { onSnooze: () => void; onTag: () => void; onToggleFocus: (() => void) | undefined; onSetDue: (() => void) | undefined };

/** A few rows as the triage list lays them out, so focus can move between them. */
function Rows({ threads, handlers }: { threads: PluginSidebarThread[]; handlers: Handlers }) {
  return (
    <>
      {threads.map((item) => (
        <ThreadRow
          key={item.id}
          thread={item}
          project={undefined}
          active={false}
          tags={[]}
          snoozeUntil={undefined}
          watching={undefined}
          createdPrs={undefined}
          running={undefined}
          now={NOW}
          lanes={lanes}
          otherSections={[]}
          onNavigate={() => {}}
          onUnsnooze={() => {}}
          onRename={() => {}}
          onNewSection={() => {}}
          machine={null}
          workspaceState={{ workspaces: [], threadWorkspaces: {} } as never}
          onWorkspace={() => {}}
          focused={false}
          reason={undefined}
          due={undefined}
          {...handlers}
        />
      ))}
    </>
  );
}

function mount(threads: PluginSidebarThread[], overrides: Partial<Handlers> = {}) {
  const handlers: Handlers = { onSnooze: vi.fn(), onTag: vi.fn(), onToggleFocus: vi.fn(), onSetDue: vi.fn(), ...overrides };
  const ok = async () => ({ ok: true });
  const slot = renderSlot(
    { component: Rows },
    { threads, handlers },
    { sdk: { threads: { archive: ok, update: ok, markRead: ok, markUnread: ok } } as never },
  );
  const row = (id: string) => slot.container.querySelector<HTMLElement>(`[data-jb-flow-row="${id}"]`)!;
  const calls = (method: string) => slot.sdkCalls.filter((call) => call.method === method).map((call) => call.args[0]);
  return { slot, handlers, row, calls };
}

const three = () => [thread("a"), thread("b"), thread("c")];

describe("Thread row keys", () => {
  beforeEach(() => vi.mocked(toast).mockClear());
  afterEach(cleanup);

  it("E archives the row and moves focus to the next one", async () => {
    const { row, calls } = mount(three());
    row("a").focus();
    fireEvent.keyDown(row("a"), { key: "e" });
    expect(calls("threads.archive")).toEqual([{ threadId: "a" }]);
    await waitFor(() => expect(document.activeElement).toBe(row("b")));
  });

  it("E on the last row moves focus up to the one before", async () => {
    const { row, calls } = mount(three());
    fireEvent.keyDown(row("c"), { key: "e" });
    expect(calls("threads.archive")).toEqual([{ threadId: "c" }]);
    await waitFor(() => expect(document.activeElement).toBe(row("b")));
  });

  it("E on a pinned row explains instead of archiving", () => {
    const { row, calls } = mount([thread("a", { isPinned: true, pinnedAt: NOW })]);
    row("a").focus();
    fireEvent.keyDown(row("a"), { key: "e" });
    expect(calls("threads.archive")).toEqual([]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0]![0]).toMatch(/Pinned threads aren't archived with E/);
    expect(document.activeElement).toBe(row("a"));
  });

  it("number keys move the row to their lane and keep focus on the list", async () => {
    const { row, calls } = mount(three());
    for (const lane of lanes) fireEvent.keyDown(row("a"), { key: lane.key });
    expect(calls("threads.update")).toEqual(lanes.map((lane) => ({ threadId: "a", sectionId: lane.sectionId })));
    await waitFor(() => expect(document.activeElement).toBe(row("b")));
  });

  it("F, D, S and T call their actions", () => {
    const { row, handlers } = mount(three());
    fireEvent.keyDown(row("a"), { key: "f" });
    fireEvent.keyDown(row("a"), { key: "d" });
    fireEvent.keyDown(row("a"), { key: "s" });
    fireEvent.keyDown(row("a"), { key: "t" });
    for (const handler of [handlers.onToggleFocus, handlers.onSetDue, handlers.onSnooze, handlers.onTag]) expect(handler).toHaveBeenCalledTimes(1);
  });

  it("F and D do nothing when Now and Focus is off", () => {
    const { row, slot } = mount(three(), { onToggleFocus: undefined, onSetDue: undefined });
    fireEvent.keyDown(row("a"), { key: "f" });
    fireEvent.keyDown(row("a"), { key: "d" });
    expect(slot.sdkCalls).toEqual([]);
  });

  it("U marks an unread row read, and a read row unread", () => {
    const { row, calls } = mount([thread("a", { isUnread: true }), thread("b")]);
    fireEvent.keyDown(row("a"), { key: "u" });
    fireEvent.keyDown(row("b"), { key: "u" });
    expect(calls("threads.markRead")).toEqual([{ threadId: "a" }]);
    expect(calls("threads.markUnread")).toEqual([{ threadId: "b" }]);
  });

  it("J and K move focus down and up, and stop at the ends", () => {
    const { row } = mount(three());
    row("a").focus();
    fireEvent.keyDown(row("a"), { key: "j" });
    expect(document.activeElement).toBe(row("b"));
    fireEvent.keyDown(row("b"), { key: "j" });
    expect(document.activeElement).toBe(row("c"));
    fireEvent.keyDown(row("c"), { key: "j" });
    expect(document.activeElement).toBe(row("c"));
    fireEvent.keyDown(row("c"), { key: "k" });
    expect(document.activeElement).toBe(row("b"));
    fireEvent.keyDown(row("a"), { key: "k" });
    expect(document.activeElement).toBe(row("b"));
  });

  it("keys with Cmd, Ctrl or Alt are left to bb", () => {
    const { row, slot, handlers } = mount(three());
    fireEvent.keyDown(row("a"), { key: "e", metaKey: true });
    fireEvent.keyDown(row("a"), { key: "e", ctrlKey: true });
    fireEvent.keyDown(row("a"), { key: "1", altKey: true });
    fireEvent.keyDown(row("a"), { key: "s", metaKey: true });
    expect(slot.sdkCalls).toEqual([]);
    expect(handlers.onSnooze).not.toHaveBeenCalled();
  });
});
