import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLimitHit } from "./limits.ts";

// Friday 2026-10-02 14:30 local time.
const now = new Date(2026, 9, 2, 14, 30);
const local = (m: number, d: number, h: number, min = 0) => new Date(2026, m - 1, d, h, min).getTime();

test("session limit with minutes", () => {
  assert.deepEqual(parseLimitHit("You've hit your session limit · resets 7:20pm (Europe/Oslo)", now), {
    kind: "session",
    resetsAt: local(10, 2, 19, 20),
  });
});

test("session limit, whole hour", () => {
  assert.equal(parseLimitHit("You've hit your session limit · resets 10pm (Europe/Oslo)", now)?.resetsAt, local(10, 2, 22));
  assert.equal(parseLimitHit("You've hit your session limit · resets 3pm", now)?.resetsAt, local(10, 2, 15));
});

test("a time earlier than now means tomorrow", () => {
  assert.equal(parseLimitHit("You've hit your session limit · resets 9am (Europe/Oslo)", now)?.resetsAt, local(10, 3, 9));
});

test("weekly limit with a date", () => {
  assert.deepEqual(parseLimitHit("You've hit your weekly limit · resets Oct 6 at 9pm (Europe/Oslo)", now), {
    kind: "weekly",
    resetsAt: local(10, 6, 21),
  });
});

test("spend limits and other text are not auto-continued", () => {
  assert.equal(
    parseLimitHit("You've hit your org's monthly spend limit · run /usage-credits to raise it", now),
    null,
  );
  assert.equal(parseLimitHit("All tests pass. Want me to open the PR?", now), null);
});

test("combined spend + session message uses the session reset", () => {
  const text =
    "You've hit your org's monthly spend limit · run /usage-credits to raise it, or visit claude.ai/admin-settings/usage · your session limit resets 7:20pm (Europe/Oslo)";
  // Not "hit your session limit" verbatim, and spend limits need a human: skip.
  assert.equal(parseLimitHit(text, now), null);
});
