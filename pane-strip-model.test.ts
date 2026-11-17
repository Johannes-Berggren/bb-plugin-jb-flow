import { test } from "node:test";
import assert from "node:assert/strict";
import { paneInView, paneOrder, paneState, splitViewport } from "./pane-strip-model.ts";

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
