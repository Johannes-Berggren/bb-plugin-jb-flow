import assert from "node:assert/strict";
import { test } from "node:test";
import { ballState, focusLimitOf, needsYouNow, nextAfter, nowQueue, reasonLabel, serverNowThread, sidebarNowThread, waited, type NowFlow, type NowThread } from "./now-model.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const thread = (id: string, changes: Partial<NowThread> = {}): NowThread => ({
  id,
  busy: false,
  blocked: null,
  isUnread: false,
  snoozed: false,
  attentionAt: NOW - HOUR,
  ...changes,
});

const flow = (changes: Partial<NowFlow> = {}): NowFlow => ({
  awaiting: {},
  promised: {},
  waitingOthers: {},
  readyToGo: {},
  watching: {},
  threadPrs: {},
  focused: {},
  due: {},
  ...changes,
});

const pr = (attention: string, state = "open") => ({ state, attention }) as unknown as NowFlow["threadPrs"][string][number];
const ids = (entries: readonly { thread: { id: string } }[]) => entries.map((entry) => entry.thread.id);

test("each state, in the order the checks run", () => {
  const state = (changes: Partial<NowThread>, flowChanges: Partial<NowFlow> = {}) => ballState(thread("t", changes), flow(flowChanges), NOW);
  assert.equal(state({ blocked: "input" }), "blocked");
  assert.equal(state({ blocked: "failed", busy: true }), "blocked");
  assert.equal(state({ busy: true }, { awaiting: { t: 1 } }), "running");
  assert.equal(state({}, { awaiting: { t: 1 }, watching: { t: { kind: "ci", label: "" } } }), "yours");
  assert.equal(state({ attentionAt: NOW - 2 * HOUR }, { promised: { t: 1 } }), "stalled");
  assert.equal(state({}, { threadPrs: { t: [pr("checks_failed")] } }), "pr");
  assert.equal(state({}, { threadPrs: { t: [pr("ready_to_merge")] } }), "pr");
  assert.equal(state({}, { readyToGo: { t: 1 } }), "go");
  assert.equal(state({}, { watching: { t: { kind: "release", label: "" } } }), "watched");
  assert.equal(state({}, { waitingOthers: { t: 1 } }), "others");
  assert.equal(state({}, { threadPrs: { t: [pr("review_requested")] } }), "others");
  assert.equal(state({ attentionAt: NOW - HOUR }), "recent");
  assert.equal(state({ attentionAt: NOW - 5 * HOUR }), "cold");
});

test("a watched promise isn't stalled, and neither is a fresh one", () => {
  const old = { attentionAt: NOW - 2 * HOUR };
  assert.equal(ballState(thread("t", old), flow({ promised: { t: 1 }, watching: { t: { kind: "ci", label: "" } } }), NOW), "watched");
  assert.equal(ballState(thread("t", { attentionAt: NOW - 60_000 }), flow({ promised: { t: 1 } }), NOW), "recent");
});

test("a merged PR doesn't count as open", () => {
  assert.equal(ballState(thread("t"), flow({ threadPrs: { t: [pr("checks_failed", "merged")] } }), NOW), "recent");
});

test("Now holds today's Needs me and focused threads that want you", () => {
  const { now } = nowQueue(
    [thread("input", { blocked: "input" }), thread("ask", { isUnread: true }), thread("readAsk"), thread("focusedAsk"), thread("idle")],
    flow({ awaiting: { ask: 1, readAsk: 1, focusedAsk: 1 }, focused: { focusedAsk: 1 } }),
    { now: NOW },
  );
  assert.deepEqual(ids(now).sort(), ["ask", "focusedAsk", "input"]);
});

test("reading a focused ask changes neither its place nor its wait", () => {
  const threads = (isUnread: boolean) => [thread("a", { isUnread, attentionAt: NOW - 20 * HOUR }), thread("b", { attentionAt: NOW - 30 * HOUR })];
  const state = flow({ awaiting: { a: NOW - 20 * HOUR, b: NOW - 30 * HOUR }, focused: { a: 1, b: 1 } });
  const unread = nowQueue(threads(true), state, { now: NOW }).now;
  const read = nowQueue(threads(false), state, { now: NOW }).now;
  assert.deepEqual(ids(read), ids(unread));
  assert.deepEqual(read.map((entry) => entry.since), unread.map((entry) => entry.since));
});

test("rank: focused and blocked, then focused by longest wait, then the rest oldest first", () => {
  const { now } = nowQueue(
    [
      thread("other-new", { blocked: "input", attentionAt: NOW - HOUR }),
      thread("other-old", { blocked: "failed", attentionAt: NOW - 9 * HOUR }),
      thread("focus-new", { attentionAt: NOW - HOUR }),
      thread("focus-old", { attentionAt: NOW - 50 * HOUR }),
      thread("focus-blocked", { blocked: "input", attentionAt: NOW - 60_000 }),
    ],
    flow({
      awaiting: { "focus-new": NOW - HOUR, "focus-old": NOW - 50 * HOUR },
      focused: { "focus-new": 1, "focus-old": 1, "focus-blocked": 1 },
    }),
    { now: NOW },
  );
  assert.deepEqual(ids(now), ["focus-blocked", "focus-old", "focus-new", "other-old", "other-new"]);
});

test("a focused thread waiting on you comes before a focused thread with no next step, however old", () => {
  const { now } = nowQueue(
    [thread("cold", { attentionAt: NOW - 44 * HOUR }), thread("asked", { attentionAt: NOW - HOUR })],
    flow({ awaiting: { asked: NOW - HOUR }, focused: { cold: 1, asked: 1 } }),
    { now: NOW },
  );
  assert.deepEqual(ids(now), ["asked", "cold"]);
});

test("a backfilled ask is dated by the thread, not by when it was classified", () => {
  const { now } = nowQueue([thread("a", { attentionAt: NOW - 30 * HOUR })], flow({ awaiting: { a: NOW - HOUR }, focused: { a: 1 } }), { now: NOW });
  assert.equal(now[0]?.since, NOW - 30 * HOUR);
});

test("focused threads moving without you go to Moving; unfocused ones stay in their lanes", () => {
  const { now, moving } = nowQueue(
    [
      thread("running", { busy: true }),
      thread("watched"),
      thread("others"),
      thread("recent"),
      thread("cold", { attentionAt: NOW - 5 * HOUR }),
      thread("unfocused", { busy: true }),
    ],
    flow({
      watching: { watched: { kind: "ci", label: "" } },
      waitingOthers: { others: 1 },
      focused: { running: 1, watched: 1, others: 1, recent: 1, cold: 1 },
    }),
    { now: NOW },
  );
  assert.deepEqual(ids(now), ["cold"]);
  assert.deepEqual(ids(moving).sort(), ["others", "recent", "running", "watched"]);
});

test("a thread is only ever in one group", () => {
  const threads = ["a", "b", "c", "d"].map((id, index) => thread(id, { blocked: index % 2 ? "input" : null, busy: index === 2 }));
  const { now, moving } = nowQueue(threads, flow({ focused: { a: 1, b: 1, c: 1, d: 1 } }), { now: NOW, openThreadId: "c", previous: ["c"] });
  const all = [...ids(now), ...ids(moving)];
  assert.equal(new Set(all).size, all.length);
});

test("snoozed threads stay out, even focused and blocked", () => {
  const { now, moving } = nowQueue(
    [thread("a", { snoozed: true, blocked: "input" }), thread("b", { snoozed: true, busy: true })],
    flow({ focused: { a: 1, b: 1 } }),
    { now: NOW },
  );
  assert.deepEqual(ids(now), []);
  assert.deepEqual(ids(moving), []);
});

test("the open thread keeps its row until you open another", () => {
  // You replied: the agent is running, so it would normally move to Moving.
  const threads = [thread("a", { attentionAt: NOW - 3 * HOUR }), thread("b", { busy: true }), thread("c", { attentionAt: NOW - HOUR })];
  const state = flow({ awaiting: { a: NOW - 3 * HOUR, c: NOW - HOUR }, focused: { a: 1, b: 1, c: 1 } });
  const previous = ["a", "b", "c"];
  const open = nowQueue(threads, state, { now: NOW, openThreadId: "b", previous });
  assert.deepEqual(ids(open.now), ["a", "b", "c"]);
  assert.deepEqual(ids(open.moving), []);

  const moved = nowQueue(threads, state, { now: NOW, openThreadId: "a", previous: ids(open.now) });
  assert.deepEqual(ids(moved.now), ["a", "c"]);
  assert.deepEqual(ids(moved.moving), ["b"]);
});

test("an open thread that wasn't in Now doesn't join it, and a snoozed one leaves", () => {
  assert.deepEqual(ids(nowQueue([thread("a")], flow(), { now: NOW, openThreadId: "a", previous: [] }).now), []);
  assert.deepEqual(ids(nowQueue([thread("a", { snoozed: true })], flow(), { now: NOW, openThreadId: "a", previous: ["a"] }).now), []);
});

test("the row names who holds the thread and for how long", () => {
  const label = (changes: Partial<NowThread>, flowChanges: Partial<NowFlow> = {}) => {
    const state = flow({ focused: { t: 1 }, ...flowChanges });
    const { now, moving } = nowQueue([thread("t", changes)], state, { now: NOW });
    return reasonLabel([...now, ...moving][0]!, state, NOW);
  };
  assert.equal(label({ blocked: "input" }), "needs input · 1h");
  assert.equal(label({ blocked: "failed" }), "failed · 1h");
  assert.equal(label({ busy: true }), "running");
  assert.equal(label({ attentionAt: NOW - 18 * HOUR }, { awaiting: { t: NOW - 18 * HOUR } }), "you · 18h");
  assert.equal(label({ attentionAt: NOW - 44 * HOUR }), "no next step · 44h");
  assert.equal(label({}, { threadPrs: { t: [pr("ready_to_merge"), pr("checks_failed")] } }), "checks failed");
  assert.equal(label({}, { readyToGo: { t: 1 } }), "your go · 1h");
  assert.equal(label({}, { watching: { t: { kind: "ci", label: "" } } }), "CI watch");
  assert.equal(label({}, { waitingOthers: { t: 1 } }), "waiting on others");
  assert.equal(label({}), "just finished");
});

test("waited stays short", () => {
  assert.equal(waited(5 * 60_000), "5m");
  assert.equal(waited(47 * HOUR), "47h");
  assert.equal(waited(72 * HOUR), "3d");
  assert.equal(waited(-1000), "0m");
});

test("the sidebar's thread maps onto the queue's shape", () => {
  const base = { id: "t", status: "idle", indicator: "none", hasPendingInteraction: false, isUnread: false, latestAttentionAt: 5 } as Parameters<typeof sidebarNowThread>[0];
  assert.equal(sidebarNowThread({ ...base, hasPendingInteraction: true }, false).blocked, "input");
  assert.equal(sidebarNowThread({ ...base, indicator: "waiting-for-input" }, false).blocked, "input");
  assert.equal(sidebarNowThread({ ...base, status: "error" }, false).blocked, "failed");
  assert.equal(sidebarNowThread({ ...base, indicator: "unread-error" }, false).blocked, "failed");
  assert.equal(sidebarNowThread({ ...base, status: "stopping" }, true).busy, true);
  assert.equal(sidebarNowThread(base, true).snoozed, true);
  assert.equal(sidebarNowThread(base, false).attentionAt, 5);
  // A reply waiting in the queue: the next move is the agent's, not yours.
  assert.equal(sidebarNowThread({ ...base, queuedWork: "waiting" }, false).busy, true);
  assert.equal(sidebarNowThread({ ...base, queuedWork: "failed" }, false).busy, false);
  assert.equal(serverNowThread({ id: "t", status: "idle", hasPendingInteraction: false, latestAttentionAt: 5, lastReadAt: 1, createdAt: 0, queuedWork: "waiting" }, false).busy, true);
  assert.equal(ballState(sidebarNowThread({ ...base, queuedWork: "waiting" }, false), flow({ awaiting: { t: 1 } }), NOW), "running");
});

const due = (at: number) => ({ at, reason: null, source: "agent" as const, setAt: 0 });

test("a thread due within 48h joins Now if it wants something from you, without Focus", () => {
  const { now } = nowQueue(
    [thread("asks"), thread("quiet"), thread("far")],
    flow({ awaiting: { asks: 1, far: 1 }, due: { asks: due(NOW + 40 * HOUR), quiet: due(NOW + 40 * HOUR), far: due(NOW + 96 * HOUR) } }),
    { now: NOW },
  );
  // "quiet" has only just finished, so it wants nothing yet. "far" is too far off.
  assert.deepEqual(ids(now), ["asks"]);
});

test("within 24h or overdue it joins even when someone else has the next step, but not while an agent or watch is on it", () => {
  const soon = NOW + 10 * HOUR;
  const { now, moving } = nowQueue(
    [thread("others"), thread("recent"), thread("running", { busy: true }), thread("watched"), thread("overdue")],
    flow({
      waitingOthers: { others: 1 },
      watching: { watched: { kind: "ci", label: "" } },
      due: { others: due(soon), recent: due(soon), running: due(soon), watched: due(soon), overdue: due(NOW - HOUR) },
    }),
    { now: NOW },
  );
  assert.deepEqual(ids(now), ["overdue", "others", "recent"]);
  // Moving is for Focus threads: unfocused ones keep their lane, with a due chip.
  assert.deepEqual(ids(moving), []);
});

test("full rank: blocked with a deadline or Focus, then due now, then Focus, then due soon, then the rest", () => {
  const { now } = nowQueue(
    [
      thread("rest", { blocked: "input", attentionAt: NOW - 90 * HOUR }),
      thread("due-soon", { attentionAt: NOW - 80 * HOUR }),
      thread("focus-cold", { attentionAt: NOW - 70 * HOUR }),
      thread("focus-asks", { attentionAt: NOW - 2 * HOUR }),
      thread("due-now-later", { attentionAt: NOW - 60 * HOUR }),
      thread("due-now-first", { attentionAt: NOW - HOUR }),
      thread("blocked-far-due", { blocked: "input", attentionAt: NOW - 95 * HOUR }),
      thread("blocked-due", { blocked: "failed", attentionAt: NOW - HOUR }),
    ],
    flow({
      awaiting: { "due-soon": 1, "focus-asks": NOW - 2 * HOUR, "due-now-later": 1, "due-now-first": 1 },
      focused: { "focus-cold": 1, "focus-asks": 1 },
      due: {
        "due-soon": due(NOW + 40 * HOUR),
        "due-now-later": due(NOW + 20 * HOUR),
        "due-now-first": due(NOW + 5 * HOUR),
        "blocked-due": due(NOW + 30 * HOUR),
        // A deadline two weeks off doesn't make it urgent yet.
        "blocked-far-due": due(NOW + 300 * HOUR),
      },
    }),
    { now: NOW },
  );
  assert.deepEqual(ids(now), ["blocked-due", "due-now-first", "due-now-later", "focus-asks", "focus-cold", "due-soon", "blocked-far-due", "rest"]);
});

test("a snoozed thread stays hidden until its deadline is within 24h", () => {
  const state = (at: number) => flow({ awaiting: { a: 1 }, focused: { a: 1 }, due: { a: due(at) } });
  const snoozed = [thread("a", { snoozed: true })];
  assert.deepEqual(ids(nowQueue(snoozed, state(NOW + 30 * HOUR), { now: NOW }).now), []);
  assert.deepEqual(ids(nowQueue(snoozed, state(NOW + 20 * HOUR), { now: NOW }).now), ["a"]);
  assert.deepEqual(ids(nowQueue(snoozed, state(NOW - HOUR), { now: NOW }).now), ["a"]);
});

test("a snoozed thread due soon with an agent on it joins neither group", () => {
  const { now, moving } = nowQueue([thread("a", { snoozed: true, busy: true })], flow({ focused: { a: 1 }, due: { a: due(NOW + HOUR) } }), { now: NOW });
  assert.deepEqual(ids(now), []);
  assert.deepEqual(ids(moving), []);
});

test("the row leads with the deadline", () => {
  const state = flow({ awaiting: { a: NOW - 27 * HOUR }, due: { a: due(NOW - 3 * 24 * HOUR) } });
  const { now } = nowQueue([thread("a", { attentionAt: NOW - 27 * HOUR })], state, { now: NOW });
  assert.equal(reasonLabel(now[0]!, state, NOW), "3d overdue · you 27h");
});

test("next moves on from where you are, wrapping around", () => {
  assert.equal(nextAfter(["a", "b", "c"], "a"), "b");
  assert.equal(nextAfter(["a", "b", "c"], "c"), "a");
});

test("next starts at the top from a thread that isn't in the list, or from none", () => {
  assert.equal(nextAfter(["a", "b"], "elsewhere"), "a");
  assert.equal(nextAfter(["a", "b"], null), "a");
});

test("with only the thread you're on, or nothing, there's nowhere to go", () => {
  assert.equal(nextAfter(["a"], "a"), null);
  assert.equal(nextAfter([], "a"), null);
  assert.equal(nextAfter([], null), null);
});

test("pressing next repeatedly visits every thread, even ones that stay after reading", () => {
  const order = ["a", "b", "c"];
  const seen: (string | null)[] = [];
  let current: string | null = null;
  for (let press = 0; press < 3; press++) {
    current = nextAfter(order, current);
    seen.push(current);
  }
  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("a tab counts what's waiting on you right now, not everything in Now", () => {
  const state = flow({
    awaiting: { yours: 1 },
    readyToGo: { go: 1 },
    focused: { blocked: 1, yours: 1, go: 1, cold: 1, late: 1 },
    due: { late: due(NOW - HOUR) },
  });
  const { now } = nowQueue(
    [thread("blocked", { blocked: "input" }), thread("yours"), thread("go"), thread("cold", { attentionAt: NOW - 5 * HOUR }), thread("late", { attentionAt: NOW - 5 * HOUR })],
    state,
    { now: NOW },
  );
  assert.equal(now.length, 5);
  assert.equal(needsYouNow(now, NOW), 3);
});

test("the server's thread maps onto the same shape", () => {
  const base = { id: "t", status: "idle", hasPendingInteraction: false, latestAttentionAt: 100, lastReadAt: 50, createdAt: 1 };
  assert.equal(serverNowThread(base, false).isUnread, true);
  assert.equal(serverNowThread({ ...base, lastReadAt: null }, false).isUnread, true);
  assert.equal(serverNowThread({ ...base, lastReadAt: 200 }, false).isUnread, false);
  assert.equal(serverNowThread({ ...base, status: "error" }, false).blocked, "failed");
  assert.equal(serverNowThread({ ...base, hasPendingInteraction: true }, false).blocked, "input");
  assert.equal(serverNowThread({ ...base, latestAttentionAt: null }, true).attentionAt, 1);
  assert.equal(serverNowThread({ ...base, status: "stopping" }, true).busy, true);
});

test("the Focus limit survives whatever was typed in its setting", () => {
  assert.equal(focusLimitOf(3), 3);
  assert.equal(focusLimitOf(undefined), 7);
  assert.equal(focusLimitOf("nonsense"), 7);
  assert.equal(focusLimitOf(0), 7);
  assert.equal(focusLimitOf(-2), 1);
});

