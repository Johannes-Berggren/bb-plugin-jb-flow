import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverToWaiters, deliveryReached, readField, type WaiterDelivery } from "./release-delivery.ts";

test("delivery is reached by the same or a newer version", () => {
  assert.equal(deliveryReached("1.4.2", "v1.4.2"), true);
  assert.equal(deliveryReached("v1.4.3", "v1.4.2"), true);
  assert.equal(deliveryReached("1.10.0", "v1.9.9"), true);
  assert.equal(deliveryReached("1.4.1", "v1.4.2"), false);
});

test("an unreadable value is not delivery, and non-numeric tags must match exactly", () => {
  assert.equal(deliveryReached(undefined, "v1.4.2"), false);
  assert.equal(deliveryReached(null, "v1.4.2"), false);
  assert.equal(deliveryReached("nightly-5", "nightly-5"), true);
  assert.equal(deliveryReached("nightly-4", "nightly-5"), false);
});

test("fields are read by dotted path", () => {
  assert.equal(readField({ a: { version: "1.0.0" } }, "a.version"), "1.0.0");
  assert.equal(readField({ a: null }, "a.version"), undefined);
});

function deliveryFake(fields: Partial<WaiterDelivery> = {}) {
  const sent: string[] = [];
  const settled: string[] = [];
  const warnings: string[] = [];
  const delivery: WaiterDelivery = {
    send: async (threadId) => {
      sent.push(threadId);
    },
    threadGone: async () => false,
    settle: async (waiterId) => {
      settled.push(waiterId);
    },
    warn: (message) => warnings.push(message),
    ...fields,
  };
  return { delivery, sent, settled, warnings };
}

const waiters = [
  ["a@web", { threadId: "a" }],
  ["b@web", { threadId: "b" }],
] as const;

test("told waiters are forgotten", async () => {
  const { delivery, sent, settled } = deliveryFake();
  assert.deepEqual(await deliverToWaiters(waiters, delivery), { notified: 2, failed: 0 });
  assert.deepEqual(sent, ["a", "b"]);
  assert.deepEqual(settled, ["a@web", "b@web"]);
});

test("a waiter whose send failed stays registered, and the others still get theirs", async () => {
  const { delivery, settled, warnings } = deliveryFake({
    send: async (threadId) => {
      if (threadId === "a") throw new Error("HTTP 503");
    },
  });
  assert.deepEqual(await deliverToWaiters(waiters, delivery), { notified: 1, failed: 1 });
  assert.deepEqual(settled, ["b@web"]);
  assert.match(warnings[0]!, /release notify/);
});

test("a thread that's gone is forgotten without a send", async () => {
  const { delivery, sent, settled } = deliveryFake({ threadGone: async (threadId) => threadId === "a" });
  assert.deepEqual(await deliverToWaiters(waiters, delivery), { notified: 1, failed: 0 });
  assert.deepEqual(sent, ["b"]);
  assert.deepEqual(settled, ["a@web", "b@web"]);
});
