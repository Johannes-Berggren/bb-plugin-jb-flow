import assert from "node:assert/strict";
import { test } from "node:test";
import {
  badgeFor,
  buildQueue,
  bulkReadable,
  countSince,
  current,
  eligible,
  freshIds,
  progress,
  pullFresh,
  record,
  recordBulk,
  requeueKept,
  resumable,
  settle,
  startSession,
  stillWorking,
  summary,
  swipeOutcome,
  tier,
  undo,
  undoBlocked,
  upcoming,
  type CatchUpFlow,
  type CatchUpThread,
} from "./catch-up-model.ts";

const NOW = 1_800_000_000_000;

function thread(id: string, overrides: Partial<CatchUpThread> = {}): CatchUpThread {
  return {
    id,
    status: "idle",
    indicator: "unread-success",
    hasPendingInteraction: false,
    isUnread: true,
    isArchived: false,
    isHidden: false,
    parentThreadId: null,
    originKind: null,
    sectionId: null,
    latestAttentionAt: NOW - 60_000,
    lastReadAt: NOW - 3_600_000,
    ...overrides,
  };
}

const flow = (overrides: Partial<CatchUpFlow> = {}): CatchUpFlow => ({
  awaiting: {},
  snoozes: {},
  snoozedSectionId: null,
  threadPrs: {},
  ...overrides,
});

const pr = (attention: string, state = "open") =>
  ({ repo: "acme/web-app", number: 7, title: "Fix", url: "https://github.com/acme/web-app/pull/7", state, attention, base: "main", head: "fix", stackedOn: null, checkedAt: NOW }) as never;

test("eligible: unread, visible, awake, top-level threads that aren't working", () => {
  const f = flow({ snoozes: { s: { until: NOW + 1, note: null, fromSectionId: null, snoozedAt: NOW } }, snoozedSectionId: "zz" });
  assert.equal(eligible(thread("a"), f), true);
  assert.equal(eligible(thread("a", { isUnread: false }), f), false);
  assert.equal(eligible(thread("a", { isArchived: true }), f), false);
  assert.equal(eligible(thread("a", { isHidden: true }), f), false);
  assert.equal(eligible(thread("s"), f), false, "snoozed by record");
  assert.equal(eligible(thread("a", { sectionId: "zz" }), f), false, "in the Snoozed section");
  assert.equal(eligible(thread("a", { status: "active" }), f), false, "still working");
  assert.equal(eligible(thread("a", { status: "active", hasPendingInteraction: true }), f), true, "working but asking you");
  assert.equal(eligible(thread("a", { status: "error", indicator: "unread-error" }), f), true);
  assert.equal(eligible(thread("a", { parentThreadId: "p" }), f), false, "a spawned child");
  assert.equal(eligible(thread("a", { parentThreadId: "p", originKind: "fork" }), f), true, "a fork you made");
});

test("tier: input, failed, your move, PR to act on, update", () => {
  const f = flow({ awaiting: { m: NOW }, threadPrs: { p: [pr("checks_failed")], q: [pr("checks_failed", "merged")] } });
  assert.equal(tier(thread("i", { indicator: "waiting-for-input" }), f), 0);
  assert.equal(tier(thread("e", { status: "error" }), f), 1);
  assert.equal(tier(thread("m"), f), 2);
  assert.equal(tier(thread("p"), f), 3);
  assert.equal(tier(thread("q"), f), 4, "a merged PR isn't one to act on");
  assert.equal(tier(thread("u"), f), 4);
});

test("buildQueue: needs-you first, then oldest first, stable on ties", () => {
  const f = flow({ awaiting: { m: NOW } });
  const queue = buildQueue(
    [
      thread("u2", { latestAttentionAt: NOW - 10 }),
      thread("u1", { latestAttentionAt: NOW - 20 }),
      thread("m", { latestAttentionAt: NOW }),
      thread("i", { hasPendingInteraction: true, latestAttentionAt: NOW }),
      thread("b", { latestAttentionAt: NOW - 20 }),
      thread("read", { isUnread: false }),
    ],
    f,
  );
  assert.deepEqual(queue.map((entry) => entry.thread.id), ["i", "m", "b", "u1", "u2"]);
  const scoped = buildQueue([thread("x"), thread("y")], f, (candidate) => candidate.id === "y");
  assert.deepEqual(scoped.map((entry) => entry.thread.id), ["y"]);
});

test("stillWorking counts unread threads that will join when they finish", () => {
  assert.equal(stillWorking([thread("a", { status: "active" }), thread("b"), thread("c", { status: "active", hasPendingInteraction: true })], flow()), 1);
});

test("badgeFor: count, tone and label", () => {
  assert.equal(badgeFor([]), null);
  const updates = buildQueue([thread("a"), thread("b")], flow());
  assert.deepEqual(badgeFor(updates), { count: 2, tone: "neutral", label: "2 unread threads" });
  const mine = buildQueue([thread("a"), thread("m")], flow({ awaiting: { m: NOW } }));
  assert.deepEqual(badgeFor(mine), { count: 2, tone: "warning", label: "2 unread threads · 1 needs you" });
  const urgent = buildQueue([thread("e", { status: "error" })], flow());
  assert.equal(badgeFor(urgent)?.tone, "critical");
});

const deal = (ids: string[], f = flow()) =>
  startSession(buildQueue(ids.map((id, index) => thread(id, { latestAttentionAt: NOW - 1000 + index })), f), null, NOW);

test("record moves on and skips handled cards; undo brings a card back", () => {
  let session = deal(["a", "b", "c"]);
  assert.equal(current(session)?.threadId, "a");
  session = record(session, "done", NOW + 1);
  assert.equal(current(session)?.threadId, "b");
  session = record(session, "kept", NOW + 2);
  session = record(session, "done", NOW + 3);
  assert.equal(current(session), null, "everything handled");
  assert.deepEqual(progress(session), { at: 3, of: 3, handled: 3 });
  const back = undo(session, NOW + 4)!;
  assert.equal(back.entry.kind, "one");
  assert.equal(current(back.session)?.threadId, "c");
  assert.equal(current(back.session)?.outcome, null);
  const twice = undo(back.session, NOW + 5)!;
  assert.equal(current(twice.session)?.threadId, "b");
});

test("a sent reply is an undo barrier", () => {
  let session = deal(["a", "b"]);
  session = record(session, "replied", NOW + 1);
  assert.equal(undoBlocked(session), true);
  assert.equal(undo(session, NOW + 2), null);
});

test("upcoming lists the next pending cards", () => {
  let session = deal(["a", "b", "c", "d"]);
  session = record(session, "done", NOW + 1);
  assert.deepEqual(upcoming(session, 2).map((entry) => entry.threadId), ["c", "d"]);
});

test("settle skips cards read elsewhere but keeps the one on screen", () => {
  const session = deal(["a", "b", "c"]);
  const live = new Map([
    ["a", thread("a", { isUnread: false })],
    ["b", thread("b", { isUnread: false })],
    ["c", thread("c")],
  ]);
  const settled = settle(session, live, flow(), NOW + 1);
  assert.equal(current(settled)?.threadId, "a", "the card you're reading stays");
  assert.equal(settled.items[1]!.outcome, "elsewhere");
  assert.equal(settled.items[2]!.outcome, null);
  assert.equal(settle(settled, live, flow(), NOW + 2), settled, "unchanged returns the same session");
  assert.equal(settle(session, live, flow(), NOW + 1, new Set(["b"])).items[1]!.outcome, null, "an undo in flight");
  const moved = record(settled, "done", NOW + 3);
  assert.equal(current(moved)?.threadId, "c");
});

test("freshIds and pullFresh deal new arrivals at the end without reordering", () => {
  let session = deal(["a", "b"]);
  session = record(session, "done", NOW + 10);
  const later = buildQueue(
    [
      thread("a", { latestAttentionAt: NOW + 20 }),
      thread("b", { latestAttentionAt: NOW - 999 }),
      thread("n", { latestAttentionAt: NOW + 5 }),
    ],
    flow(),
  );
  assert.deepEqual(freshIds(session, later), ["n", "a"], "pending b isn't new");
  session = pullFresh(session, later, NOW + 30);
  assert.deepEqual(session.items.map((entry) => entry.threadId), ["a", "b", "n", "a"]);
  assert.equal(current(session)?.threadId, "b", "still on the card you were on");
  assert.deepEqual(freshIds(session, later), []);
});

test("kept cards come back with requeueKept, not as new", () => {
  let session = deal(["a", "b"]);
  session = record(session, "kept", NOW + 1);
  session = record(session, "done", NOW + 2);
  const queue = buildQueue([thread("a", { latestAttentionAt: NOW + 50 })], flow());
  assert.deepEqual(freshIds(session, queue), []);
  session = requeueKept(session, NOW + 3);
  assert.equal(current(session)?.threadId, "a");
});

test("Mark all read clears updates only and undoes in one step", () => {
  let session = startSession(
    buildQueue([thread("i", { hasPendingInteraction: true }), thread("u1"), thread("u2", { latestAttentionAt: NOW })], flow()),
    null,
    NOW,
  );
  assert.deepEqual(bulkReadable(session).map((entry) => entry.threadId), ["u1", "u2"]);
  session = recordBulk(session, NOW + 1);
  assert.equal(current(session)?.threadId, "i");
  assert.deepEqual(summary(session), { done: 2, kept: 0, replied: 0, snoozed: 0, archived: 0, opened: 0, elsewhere: 0, pending: 1, total: 3 });
  const back = undo(session, NOW + 2)!;
  assert.equal(back.entry.kind, "bulk");
  assert.equal(summary(back.session).pending, 3);
});

test("resumable within the window, for the same scope, with cards left", () => {
  const session = deal(["a"]);
  assert.equal(resumable(session, null, NOW + 60_000), true);
  assert.equal(resumable(session, "ws1", NOW + 60_000), false);
  assert.equal(resumable(session, null, NOW + 16 * 60_000), false);
  assert.equal(resumable(record(session, "done", NOW), null, NOW + 1), false);
  assert.equal(resumable(null, null, NOW), false);
});

test("countSince counts turns and prompts after your last read", () => {
  const rows = [
    { kind: "conversation", role: "user", initiator: "user", createdAt: 100, turnId: "t1" },
    { kind: "turn", turnId: "t1", createdAt: 100, completedAt: 150, children: null },
    { kind: "conversation", role: "user", initiator: "user", createdAt: 200, turnId: "t2" },
    { kind: "turn", turnId: "t2", createdAt: 200, completedAt: 250, children: null },
    { kind: "conversation", role: "user", initiator: "agent", createdAt: 300, turnId: "t3" },
    { kind: "turn", turnId: "t3", createdAt: 300, completedAt: 350, children: null },
  ];
  assert.deepEqual(countSince(rows, 160, false), { turns: 2, yourPrompts: 1, otherPrompts: 1, more: false, firstAt: 200 });
  assert.deepEqual(countSince(rows, 120, false).turns, 3, "a turn that finished after you looked counts");
  assert.equal(countSince(rows, 50, true).more, true, "older rows exist and all of these are newer");
  assert.equal(countSince(rows, 160, true).more, false);
  assert.equal(countSince(rows, null, false).turns, 3);
  assert.deepEqual(countSince(rows, 400, false), { turns: 0, yourPrompts: 0, otherPrompts: 0, more: false, firstAt: null });
});

test("countSince falls back to assistant replies without turn ids, and walks children", () => {
  const rows = [
    { kind: "conversation", role: "assistant", createdAt: 10 },
    { kind: "conversation", role: "assistant", createdAt: 20 },
    { kind: "turn", createdAt: 30, children: [{ kind: "conversation", role: "user", initiator: "system", createdAt: 30 }] },
  ];
  assert.deepEqual(countSince(rows, 5, false), { turns: 2, yourPrompts: 0, otherPrompts: 1, more: false, firstAt: 10 });
});

test("swipeOutcome needs distance or speed in the swipe's direction", () => {
  assert.equal(swipeOutcome(200, 400, 0), "done");
  assert.equal(swipeOutcome(-200, 400, 0), "kept");
  assert.equal(swipeOutcome(60, 400, 0.1), null);
  assert.equal(swipeOutcome(60, 400, 0.9), "done");
  assert.equal(swipeOutcome(60, 400, -0.9), null, "flicked back");
  assert.equal(swipeOutcome(10, 400, 2), null, "a tap");
});
