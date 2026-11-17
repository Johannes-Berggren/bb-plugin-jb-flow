import { test } from "node:test";
import assert from "node:assert/strict";
import { queuePicks } from "./pane-commands-model.ts";
import { statusAge, STATUS_OUTDATED_MS } from "./status-age.ts";

test("the queue fills the split in order, skipping what is already open", () => {
  // One pane open on something else: seven more fit.
  assert.deepEqual(queuePicks(["a", "b", "c"], ["x"], 1), ["a", "b", "c"]);
  assert.deepEqual(queuePicks(["a", "b", "c"], ["b", null], 2), ["a", "c"]);
  // Nine waiting, one pane: the seven most urgent.
  const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  assert.deepEqual(queuePicks(nine, [null], 1), nine.slice(0, 7));
  // Five panes open: three more.
  assert.deepEqual(queuePicks(nine, ["a", null, null, null, null], 5), ["b", "c", "d"]);
});

test("a full split, an empty queue and a queue that is already open pick nothing", () => {
  assert.deepEqual(queuePicks(["a", "b"], Array.from({ length: 8 }, () => null), 8), []);
  assert.deepEqual(queuePicks([], ["x"], 1), []);
  assert.deepEqual(queuePicks(["a", "b"], ["a", "b"], 2), []);
  // A repeated id is opened once.
  assert.deepEqual(queuePicks(["a", "a", "b"], [null], 1), ["a", "b"]);
});

test("a status report is out of date when missing, replied past, or old", () => {
  const now = 10 * STATUS_OUTDATED_MS;
  assert.equal(statusAge(null, now), "missing");
  assert.equal(statusAge(undefined, now), "missing");
  assert.equal(statusAge({ report: null, latestAt: now }, now), "missing");
  const report = { capturedAt: now - 3_600_000 };
  assert.equal(statusAge({ report, latestAt: report.capturedAt }, now), null);
  // The reply that carried the report lands a little after it was captured.
  assert.equal(statusAge({ report, latestAt: report.capturedAt + 30_000 }, now), null);
  assert.equal(statusAge({ report, latestAt: report.capturedAt + 120_000 }, now), "replied-since");
  const old = { capturedAt: now - STATUS_OUTDATED_MS - 1 };
  assert.equal(statusAge({ report: old, latestAt: old.capturedAt }, now), "old");
});
