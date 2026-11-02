import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryReached, readField } from "./release-delivery.ts";

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
