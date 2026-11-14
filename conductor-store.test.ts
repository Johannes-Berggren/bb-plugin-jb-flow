import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createConductorStore } from "./conductor-store.ts";
import { MIGRATIONS } from "./migrations.ts";

function store() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return createConductorStore(() => db as never);
}

const green = { kind: "green", text: "✅ CI is green on web-app#12 (abc1234): 3 checks passed.", meta: { repo: "acme/web-app", pr: 12 } };
const merged = { kind: "merged", text: "PR web-app#12 is now merged." };

test("the same event added twice is stored once", () => {
  const inbox = store();
  assert.equal(inbox.add("ws", "thr_a", [green], 1), 1);
  assert.equal(inbox.add("ws", "thr_a", [green, merged], 2), 1);
  assert.deepEqual(inbox.open("ws").map((event) => event.kind), ["green", "merged"]);
  assert.deepEqual(inbox.open("ws")[0]!.meta, { repo: "acme/web-app", pr: 12 });
});

test("the same news for another thread or workspace is its own event", () => {
  const inbox = store();
  inbox.add("ws", "thr_a", [merged], 1);
  inbox.add("ws", "thr_b", [merged], 1);
  inbox.add("other", "thr_a", [merged], 1);
  assert.equal(inbox.open("ws").length, 2);
  assert.equal(inbox.open("other").length, 1);
});

test("delivered events leave the undelivered list but stay open until acknowledged", () => {
  const inbox = store();
  inbox.add("ws", "thr_a", [green, merged], 1);
  const [first] = inbox.undelivered("ws");
  inbox.markDelivered([first!.id], 5);
  assert.deepEqual(inbox.undelivered("ws").map((event) => event.kind), ["merged"]);
  assert.equal(inbox.open("ws").length, 2);
  assert.equal(inbox.open("ws")[0]!.deliveredAt, 5);
});

test("a conductor can only acknowledge its own workspace's events", () => {
  const inbox = store();
  inbox.add("ws", "thr_a", [green], 1);
  const id = inbox.open("ws")[0]!.id;
  assert.equal(inbox.ack("other", [id], 9), 0);
  assert.equal(inbox.ack("ws", [id], 9), 1);
  assert.equal(inbox.ack("ws", [id], 10), 0, "already acknowledged");
  assert.deepEqual(inbox.open("ws"), []);
  assert.deepEqual(inbox.undelivered("ws"), [], "acknowledged events are never sent");
});

test("pruning forgets old events", () => {
  const inbox = store();
  inbox.add("ws", "thr_a", [green], 1);
  inbox.add("ws", "thr_a", [merged], 100);
  assert.equal(inbox.prune(50), 1);
  assert.deepEqual(inbox.open("ws").map((event) => event.kind), ["merged"]);
});

test("the activity log is per workspace, newest first, and pruned with the inbox", () => {
  const inbox = store();
  inbox.log("ws", "merge", "thr_a", "Merged acme/web-app#12", 10);
  inbox.log("ws", "archive", "thr_a", "Archived", 20);
  inbox.log("other", "merge", null, "Merged elsewhere", 15);
  assert.deepEqual(inbox.recentLog("ws").map((entry) => entry.kind), ["archive", "merge"]);
  assert.equal(inbox.recentLog("other")[0]!.threadId, null);
  inbox.prune(15);
  assert.deepEqual(inbox.recentLog("ws").map((entry) => entry.kind), ["archive"]);
});

test("an event added once gets an id; a retried one doesn't", () => {
  const inbox = store();
  const id = inbox.addOne("ws", "thr_a", green, 1);
  assert.equal(typeof id, "number");
  assert.equal(inbox.addOne("ws", "thr_a", green, 2), null);
});

test("the feed lists chosen kinds across workspaces, with what they saved", () => {
  const inbox = store();
  inbox.log("ws", "auto-merged", "thr_a", "Merged acme/web-app#12", 10, 900_000);
  inbox.log("other", "absorbed", "thr_b", "Green on api#3", 20, 1_200_000);
  inbox.log("ws", "briefing", null, "8 items", 30);
  inbox.log("ws", "auto-archived", "thr_a", "Archived", 5);
  const entries = inbox.feed(["auto-merged", "absorbed", "auto-archived"], 8);
  assert.deepEqual(entries.map((entry) => [entry.workspaceId, entry.kind, entry.savedTokens]), [
    ["other", "absorbed", 1_200_000],
    ["ws", "auto-merged", 900_000],
  ]);
});

test("open events of retired kinds can be cleared everywhere at once", () => {
  const inbox = store();
  inbox.add("ws", "thr_a", [{ kind: "needs-you", text: "a" }, { kind: "merge-refused", text: "b" }], 1);
  inbox.add("other", "thr_b", [{ kind: "finished", text: "c" }], 1);
  assert.equal(inbox.ackKinds(["needs-you", "finished"], 5), 2);
  assert.deepEqual(inbox.open("ws").map((event) => event.kind), ["merge-refused"]);
  assert.deepEqual(inbox.open("other"), []);
});
