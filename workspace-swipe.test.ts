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

// Sideways steps 16ms apart, as macOS sends them.
const stream = (track: ReturnType<typeof createSwipeTracker>, deltas: number[], start = 0) =>
  deltas.map((deltaX, index) => track(wheel(deltaX, start + index * 16))).filter((step) => step !== 0);
// Momentum after lifting your fingers: about 20 steps that fade out.
const fade = (from: number, steps = 20) => Array.from({ length: steps }, (_, index) => Math.max(1, Math.round(from * 0.85 ** index)));

test("a quick second swipe during the first one's momentum still switches", () => {
  const track = createSwipeTracker();
  assert.deepEqual(stream(track, [10, 30, 50, 40, ...fade(35), 12, 30, 50, 40]), [1, 1]);
});

test("momentum alone, however long, never switches twice", () => {
  const track = createSwipeTracker();
  assert.deepEqual(stream(track, [10, 30, 50, 40, ...fade(35, 60)]), [1]);
});

test("momentum that wobbles doesn't switch twice", () => {
  const track = createSwipeTracker();
  const wobbly = [32, 26, 30, 20, 24, 15, 19, 11, 14, 8, 12, 6, 9, 5, 8, 4, 7, 3, 6, 2, 5, 2, 4, 1];
  assert.deepEqual(stream(track, [10, 30, 50, 40, ...wobbly]), [1]);
});

test("a fast flick right after a switch doesn't skip a tab", () => {
  const track = createSwipeTracker();
  assert.deepEqual(stream(track, [20, 60, 90, 70, 40, 20, 10, 25, 60, 30, 15, 8]), [1]);
});

test("a swipe that speeds up after switching doesn't switch twice", () => {
  const track = createSwipeTracker();
  assert.deepEqual(stream(track, [5, 5, 10, 10, 15, 15, 20, 20, 25, 30, 35, 40]), [1]);
});

test("swiping back during the momentum switches back", () => {
  const track = createSwipeTracker();
  assert.deepEqual(stream(track, [10, 30, 50, 40, ...fade(35), -12, -30, -50, -40]), [1, -1]);
});
