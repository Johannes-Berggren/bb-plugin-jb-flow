import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, mergeIntent, type AutopilotInput } from "./autopilot.ts";

const input = (fields: Partial<AutopilotInput>): AutopilotInput => ({
  kind: "green",
  mergeIntent: false,
  pr: { state: "open", attention: "ready_to_merge" },
  otherOpenPrs: 0,
  mergedByAutopilot: false,
  ...fields,
});

test("a worker's own words count as merge intent", () => {
  assert.equal(mergeIntent("Next: merge once CI is green, then clean up."), true);
  assert.equal(mergeIntent("I'll merge when checks pass."), true);
  assert.equal(mergeIntent("Once CI is green I'm merging it."), true);
  assert.equal(mergeIntent("Turned on auto-merge."), true);
  assert.equal(mergeIntent(null, "Next: waiting for CI; merging after it passes"), true);
});

test("holding back, or no word on merging, is not intent", () => {
  assert.equal(mergeIntent("Don't merge until Sam has looked."), false);
  assert.equal(mergeIntent("Merge once green, but only after your approval."), false);
  assert.equal(mergeIntent("Wait for review before merging."), false);
  assert.equal(mergeIntent("CI is running. I'll report back."), false);
  assert.equal(mergeIntent(null, undefined), false);
});

test("green with merge intent merges; green without it is only noted", () => {
  assert.equal(decide(input({ afterGreen: "merge" })).action, "merge");
  assert.equal(decide(input({ mergeIntent: true })).action, "merge");
  assert.equal(decide(input({})).action, "record");
  assert.equal(decide(input({ afterGreen: "nothing", mergeIntent: true })).action, "record");
  assert.equal(decide(input({ kind: "no-checks", afterGreen: "merge" })).action, "merge");
});

test("an explicit after_green beats what the report says", () => {
  // "continue" is routed to the worker before autopilot; anything else stated is final.
  assert.equal(decide(input({ afterGreen: "nothing", mergeIntent: true })).action, "record");
});

test("a PR that can't merge goes to the conductor instead", () => {
  assert.equal(decide(input({ afterGreen: "merge", pr: { state: "open", attention: "conflicts" } })).action, "conductor");
  assert.equal(decide(input({ afterGreen: "merge", pr: { state: "open", attention: "changes_requested" } })).action, "conductor");
  assert.equal(decide(input({ afterGreen: "merge", pr: { state: "draft", attention: "draft" } })).action, "conductor");
});

test("a merged last PR that was meant to merge archives the thread; a stack goes on", () => {
  assert.equal(decide(input({ kind: "merged", mergedByAutopilot: true })).action, "archive");
  assert.equal(decide(input({ kind: "merged", afterGreen: "merge" })).action, "archive");
  assert.equal(decide(input({ kind: "merged", mergedByAutopilot: true, otherOpenPrs: 1 })).action, "forward");
  assert.equal(decide(input({ kind: "merged" })).action, "record");
});

test("what the worker must act on is forwarded", () => {
  for (const kind of ["closed", "timeout", "unreadable", "release"]) assert.equal(decide(input({ kind })).action, "forward", kind);
});

test("anything else is the conductor's call", () => {
  assert.equal(decide(input({ kind: "needs-you" })).action, "conductor");
});
