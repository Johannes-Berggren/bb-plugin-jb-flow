// @vitest-environment node
// The server's Now queue with subthreads: what "next" (Alt+Shift+N, the deck,
// `bb jb-flow next`) and "open what needs me" walk, against a small fake bb.
import { describe, expect, it } from "vitest";
import { createFocus } from "./focus";
import { createNowQueue } from "./now-queue";

const HOUR = 3_600_000;
const SNOOZED = "sec_snoozed";

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "proj_web",
    title: `Thread ${id}`,
    titleFallback: null,
    status: "idle",
    sectionId: null as string | null,
    parentThreadId: null as string | null,
    pinnedAt: null as number | null,
    archivedAt: null,
    deletedAt: null,
    visibility: "visible",
    hasPendingInteraction: false,
    latestAttentionAt: null as number | null,
    lastReadAt: null,
    createdAt: Date.now() - 48 * HOUR,
    updatedAt: Date.now() - 48 * HOUR,
    ...overrides,
  };
}

/** Blocked on a prompt since `hoursAgo`. */
const blocked = (hoursAgo: number) => ({ hasPendingInteraction: true, latestAttentionAt: Date.now() - hoursAgo * HOUR });

function queue(threads: ReturnType<typeof thread>[], { nowQueue = true } = {}) {
  const opened: string[] = [];
  const bb = {
    storage: { kv: { get: async () => null, set: async () => undefined } },
    sdk: {
      threads: {
        list: async ({ offset }: { offset: number }) => (offset > 0 ? [] : threads),
        get: async ({ threadId }: { threadId: string }) => threads.find((entry) => entry.id === threadId)!,
        open: async ({ threadId }: { threadId: string }) => void opened.push(threadId),
        archive: async () => ({}),
      },
    },
  };
  const empty = async () => ({});
  const findSnoozedSection = async () => SNOOZED;
  const focus = createFocus(bb as never, empty, findSnoozedSection);
  const now = createNowQueue(bb as never, {
    settings: { get: async () => ({ nowQueue, createdRowOrder: false }) },
    awaiting: { all: empty, promised: empty, waitingOthers: empty, readyToGo: empty } as never,
    prTracker: { byThread: empty } as never,
    nowStore: { all: empty, dueAll: empty } as never,
    focus,
    findSnoozedSection,
    watchingByThread: empty as never,
    listAllActiveThreads: async () => threads as never,
  });
  return { ...now, opened };
}

const order = async (q: ReturnType<typeof queue>) => ((await q.rpc.needs_me_queue(null as never)) as { threadIds: string[] }).threadIds;

describe("the server's Now queue with subthreads", () => {
  it("takes in a subthread that needs you, and next opens the subthread itself", async () => {
    const threads = [thread("parent"), thread("child", { parentThreadId: "parent", ...blocked(1) })];
    const q = queue(threads);
    expect(await order(q)).toEqual(["child"]);
    // `bb jb-flow now` and the deck list it too.
    expect((await q.currentNow(threads as never)).now).toMatchObject([{ id: "child", title: "Thread child", state: "blocked" }]);
    expect(await q.rpc.next_needs_me({ archiveThreadId: null } as never)).toEqual({ opened: "child" });
    expect(q.opened).toEqual(["child"]);
  });

  it("walks Now in the list's order: each row's entries together, the row first, then its subthreads", async () => {
    // Ranked alone, the oldest wait goes first: b1 (3h), then a (2h), then b (1h).
    // The list shows b's row (with b1 under it) first, then a.
    const q = queue([
      thread("a", blocked(2)),
      thread("b", blocked(1)),
      thread("b1", { parentThreadId: "b", ...blocked(3) }),
      thread("b2", { parentThreadId: "b" }),
    ]);
    expect(await order(q)).toEqual(["b", "b1", "a"]);
    expect(await q.nextThread("b", null)).toBe("b1");
    expect(await q.nextThread("b1", null)).toBe("a");
    expect(await q.nextThread("a", null)).toBe("b");
    // A subthread that's in nobody's way stays out, but next still moves on from it.
    expect(await q.nextThread("b2", null)).toBe("b");
  });

  it("archiving a row and moving on skips its subthreads, which bb archives with it", async () => {
    const threads = [thread("a", blocked(2)), thread("b", blocked(1)), thread("b1", { parentThreadId: "b", ...blocked(3) })];
    const q = queue(threads);
    expect(await q.rpc.next_needs_me({ archiveThreadId: "b" } as never)).toEqual({ opened: "a" });
    // Just moving on from b still goes to b1.
    expect(await q.nextThread("b", "b")).toBe("b1");
  });

  it("finds a blocked grandchild", async () => {
    const q = queue([thread("root"), thread("mid", { parentThreadId: "root" }), thread("leaf", { parentThreadId: "mid", ...blocked(1) })]);
    expect(await order(q)).toEqual(["leaf"]);
  });

  it("a subthread goes with its row's snooze", async () => {
    const q = queue([thread("sleeper", { sectionId: SNOOZED }), thread("child", { parentThreadId: "sleeper", ...blocked(1) })]);
    expect(await order(q)).toEqual([]);
    expect(await q.nextThread(null, null)).toBeNull();
  });

  it("a pinned row's blocked subthread isn't in Now, but next still reaches it after Now", async () => {
    const q = queue([
      thread("pinned", { pinnedAt: Date.now() }),
      thread("pinned-child", { parentThreadId: "pinned", ...blocked(5) }),
      thread("other", blocked(1)),
    ]);
    expect(await order(q)).toEqual(["other", "pinned-child"]);
  });

  it("a subthread whose parent is gone is a row of its own", async () => {
    const q = queue([thread("orphan", { parentThreadId: "archived-parent", ...blocked(1) })]);
    expect(await order(q)).toEqual(["orphan"]);
  });

  it("with Now off, next goes to a subthread that needs you, oldest first", async () => {
    const q = queue([thread("parent", blocked(1)), thread("child", { parentThreadId: "parent", ...blocked(2) })], { nowQueue: false });
    expect(await order(q)).toEqual(["child", "parent"]);
    expect(await q.nextThread(null, null)).toBe("child");
  });
});
