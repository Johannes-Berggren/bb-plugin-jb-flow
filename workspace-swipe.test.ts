import assert from "node:assert/strict";
import { test } from "node:test";
import { createSwipeTracker, swipeTarget } from "./workspace-swipe.ts";

const order = ["web", "api", null, "unassigned"];

test("a swipe steps to the neighbouring tab and stops at the ends", () => {
  assert.equal(swipeTarget(order, "web", 1), "api");
  assert.equal(swipeTarget(order, "api", 1), null);
  assert.equal(swipeTarget(order, null, -1), "api");
  assert.equal(swipeTarget(order, "web", -1), undefined);
  assert.equal(swipeTarget(order, "unassigned", 1), undefined);
  assert.equal(swipeTarget(order, "removed", 1), undefined);
});

const wheel = (deltaX: number, timeStamp: number, deltaY = 0) => ({ deltaX, deltaY, timeStamp });

test("one gesture switches once, however long its momentum runs", () => {
  const track = createSwipeTracker();
  const steps = [0, 10, 20, 30, 40, 50, 60, 70].map((time) => track(wheel(30, time)));
  assert.deepEqual(steps.filter((step) => step !== 0), [1]);
});

test("a new gesture after a pause can switch again, in either direction", () => {
  const track = createSwipeTracker();
  for (const time of [0, 10, 20, 30]) track(wheel(40, time));
  const back = [400, 410, 420, 430].map((time) => track(wheel(-40, time)));
  assert.deepEqual(back.filter((step) => step !== 0), [-1]);
});

test("scrolling the list up and down never switches", () => {
  const track = createSwipeTracker();
  const steps = [0, 10, 20, 30, 40].map((time) => track(wheel(30, time, 60)));
  assert.deepEqual(steps.filter((step) => step !== 0), []);
});

test("a small sideways nudge doesn't switch", () => {
  const track = createSwipeTracker();
  assert.deepEqual([0, 10].map((time) => track(wheel(30, time))), [0, 0]);
});
