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
