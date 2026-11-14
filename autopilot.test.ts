import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, followUpsAfterMerge, mergeIntent, nothingLeft, type AutopilotInput } from "./autopilot.ts";

const input = (fields: Partial<AutopilotInput>): AutopilotInput => ({
  kind: "green",
  mergeIntent: false,
  pr: { state: "open", attention: "ready_to_merge" },
  otherOpenPrs: 0,
  followUps: false,
  nothingLeft: false,
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

test("only the worker's own 'nothing pending' archives a thread whose last PR merged", () => {
  assert.equal(decide(input({ kind: "merged", nothingLeft: true })).action, "archive");
  // Meaning to merge isn't proof the work is done (a release thread still had to check the deploy).
  assert.equal(decide(input({ kind: "merged", afterGreen: "merge" })).action, "record");
  assert.equal(decide(input({ kind: "merged", mergeIntent: true })).action, "record");
  assert.equal(decide(input({ kind: "merged", nothingLeft: true, otherOpenPrs: 1 })).action, "forward");
  assert.equal(decide(input({ kind: "merged", followUps: true })).action, "forward");
});

test("green with more steps after the merge wakes the worker instead of merging for it", () => {
  assert.equal(decide(input({ afterGreen: "merge", followUps: true })).action, "forward");
  assert.equal(decide(input({ mergeIntent: true, followUps: true })).action, "forward");
});

test("follow-up steps are read from the worker's own words", () => {
  // Real phrasings from a night of use: each had more to do after the merge.
  assert.equal(followUpsAfterMerge("Once its CI is green I'll merge it, bring it into the cycle branch, rerun the desktop lane and open the cycle's PR."), true);
  assert.equal(followUpsAfterMerge("Once `ci` is green on the reviewed head I'll merge it and close out the cycle."), true);
  assert.equal(followUpsAfterMerge("Once green I'll merge #2799, then start a staging deploy."), true);
  // ...and these had nothing after it.
  assert.equal(followUpsAfterMerge("The CI watcher is on the new commit, and I'll merge once it's green."), false);
  assert.equal(followUpsAfterMerge("#2801 merges itself once CI is green."), false);
  assert.equal(followUpsAfterMerge("Merge once CI is green; nothing pending after that."), false);
  assert.equal(followUpsAfterMerge(null, undefined), false);
});

test("nothing left means the worker said so", () => {
  assert.equal(nothingLeft("Nothing pending."), true);
  assert.equal(nothingLeft("Nothing else; all done."), true);
  assert.equal(nothingLeft("Once a reviewer approves, check the prod deploy."), false);
  assert.equal(nothingLeft(null), false);
});

test("what the worker must act on is forwarded", () => {
  for (const kind of ["closed", "timeout", "unreadable", "release"]) assert.equal(decide(input({ kind })).action, "forward", kind);
});

test("anything else is the conductor's call", () => {
  assert.equal(decide(input({ kind: "needs-you" })).action, "conductor");
});
