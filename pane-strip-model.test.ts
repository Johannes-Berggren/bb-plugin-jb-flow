import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitsYou, edgeHints, paneInView, paneOrder, paneState, splitViewport } from "./pane-strip-model.ts";

const thread = (overrides: Partial<Parameters<typeof paneState>[0]> = {}) => ({
  status: "idle",
  indicator: "none",
  hasPendingInteraction: false,
  isUnread: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 },
  ...overrides,
});

test("a pane's state is the most urgent thing about its thread", () => {
  assert.equal(paneState(thread()), "idle");
  assert.equal(paneState(thread({ isUnread: true })), "unread");
  assert.equal(paneState(thread({ status: "active" })), "working");
  assert.equal(paneState(thread({ status: "starting", isUnread: true })), "working");
  // Background work counts as working even when the turn has ended.
  assert.equal(paneState(thread({ activity: { workflows: 0, backgroundAgents: 1, backgroundCommands: 0 } })), "working");
  assert.equal(paneState(thread({ status: "error" })), "error");
  assert.equal(paneState(thread({ indicator: "unread-error", isUnread: true })), "error");
  // A question beats everything, including a running turn.
  assert.equal(paneState(thread({ status: "active", hasPendingInteraction: true })), "needs-you");
  assert.equal(paneState(thread({ indicator: "waiting-for-input", status: "error" })), "needs-you");
});

test("panes read left to right, then top to bottom", () => {
  const pane = (id: string, x: number, y: number) => ({ id, rect: { x, y, width: 0.25, height: 0.5 } });
  const ordered = paneOrder([pane("d", 0.5, 0), pane("b", 0.25, 0), pane("c", 0.25, 0.5), pane("a", 0, 0)]);
  assert.deepEqual(ordered.map((entry) => entry.id), ["a", "b", "c", "d"]);
});

test("the viewport is null until the split is wider than its view", () => {
  assert.equal(splitViewport({ scrollLeft: 0, clientWidth: 1280, scrollWidth: 1280 }), null);
  assert.equal(splitViewport({ scrollLeft: 0, clientWidth: 1280, scrollWidth: 1280.5 }), null);
  assert.deepEqual(splitViewport({ scrollLeft: 640, clientWidth: 1280, scrollWidth: 2560 }), { left: 0.25, right: 0.75 });
});

test("a pane is in view when at least half of it is", () => {
  const viewport = { left: 0.25, right: 0.75 };
  assert.equal(paneInView({ x: 0.25, width: 0.25 }, viewport), true);
  assert.equal(paneInView({ x: 0.5, width: 0.25 }, viewport), true);
  assert.equal(paneInView({ x: 0, width: 0.25 }, viewport), false);
  assert.equal(paneInView({ x: 0.75, width: 0.25 }, viewport), false);
  // Half in, half out still counts; a sliver doesn't.
  assert.equal(paneInView({ x: 0.125, width: 0.25 }, viewport), true);
  assert.equal(paneInView({ x: 0.05, width: 0.25 }, viewport), false);
  // Nothing scrolls: everything is in view.
  assert.equal(paneInView({ x: 0.9, width: 0.1 }, null), true);
});

test("a thread whose last message asks you something waits on you, read or not", () => {
  assert.equal(paneState(thread(), true), "needs-you");
  assert.equal(paneState(thread({ isUnread: true }), true), "needs-you");
  // Running again, or failed: that is what it is doing now.
  assert.equal(paneState(thread({ status: "active" }), true), "working");
  assert.equal(paneState(thread({ status: "error" }), true), "error");

  const awaiting = { t1: 1 };
  assert.equal(awaitsYou({ id: "t1", status: "idle" }, awaiting), true);
  assert.equal(awaitsYou({ id: "t2", status: "idle" }, awaiting), false);
  assert.equal(awaitsYou({ id: "t1", status: "active" }, awaiting), false);
  // Your answer is already queued: the ask is no longer on you.
  assert.equal(awaitsYou({ id: "t1", status: "idle", queuedWork: "waiting" }, awaiting), false);
  assert.equal(awaitsYou({ id: "t1", status: "idle" }, undefined), false);
});

test("edge hints count the panes beyond each edge and point at the nearest that waits on you", () => {
  const pane = (index: number, needsYou = false) => ({ rect: { x: index / 6, width: 1 / 6 }, needsYou });
  const panes = [pane(0, true), pane(1), pane(2), pane(3), pane(4), pane(5, true)];
  // Everything fits: no hints.
  assert.deepEqual(edgeHints(panes, null), { left: null, right: null });
  // Panes 2 and 3 in view.
  const hints = edgeHints(panes, { left: 2 / 6, right: 4 / 6 });
  assert.deepEqual(hints.left, { count: 2, needsYou: 1, target: { x: 0, width: 1 / 6 } });
  assert.deepEqual(hints.right, { count: 2, needsYou: 1, target: { x: 5 / 6, width: 1 / 6 } });
  // Nothing waits on you: the nearest pane.
  const quiet = edgeHints(panes.map((entry) => ({ ...entry, needsYou: false })), { left: 0, right: 2 / 6 });
  assert.equal(quiet.left, null);
  assert.deepEqual(quiet.right, { count: 4, needsYou: 0, target: { x: 2 / 6, width: 1 / 6 } });
});
