import assert from "node:assert/strict";
import { test } from "node:test";
import { needsMe } from "./needs-me.ts";

const thread = (changes: Partial<Parameters<typeof needsMe>[0]> = {}): Parameters<typeof needsMe>[0] => ({
  id: "t",
  hasPendingInteraction: false,
  indicator: "none",
  isUnread: false,
  status: "idle",
  ...changes,
});

test("a prompt, a permission or a failure needs you", () => {
  assert.equal(needsMe(thread({ hasPendingInteraction: true }), {}), true);
  assert.equal(needsMe(thread({ indicator: "waiting-for-input" }), {}), true);
  assert.equal(needsMe(thread({ indicator: "unread-error" }), {}), true);
});

test("an unread reply that asks you something needs you", () => {
  assert.equal(needsMe(thread({ isUnread: true }), { t: 1 }), true);
});

test("an unread status update doesn't", () => {
  assert.equal(needsMe(thread({ isUnread: true }), {}), false);
  assert.equal(needsMe(thread({ isUnread: true }), undefined), false);
});

test("an ask you've read, or one on a thread still working, doesn't", () => {
  assert.equal(needsMe(thread(), { t: 1 }), false);
  assert.equal(needsMe(thread({ isUnread: true, status: "active" }), { t: 1 }), false);
});
