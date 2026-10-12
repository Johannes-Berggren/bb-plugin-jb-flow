import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLimitHit } from "./limits.ts";

// Friday 2026-10-02 14:30 in Oslo (CEST, UTC+2), whatever zone the tests run in.
const now = new Date(Date.UTC(2026, 9, 2, 12, 30));
/** Oslo wall-clock time in early October 2026 (UTC+2). */
const local = (m: number, d: number, h: number, min = 0) => Date.UTC(2026, m - 1, d, h - 2, min);
/** Same day as `now`, in the zone the tests run in: messages without a zone use it. */
const serverLocal = (h: number) => {
  const date = new Date(now);
  date.setHours(h, 0, 0, 0);
  if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
  return date.getTime();
};

test("session limit with minutes", () => {
  assert.deepEqual(parseLimitHit("You've hit your session limit · resets 7:20pm (Europe/Oslo)", now), {
    kind: "session",
    resetsAt: local(10, 2, 19, 20),
  });
});

test("session limit, whole hour", () => {
  assert.equal(parseLimitHit("You've hit your session limit · resets 10pm (Europe/Oslo)", now)?.resetsAt, local(10, 2, 22));
  assert.equal(parseLimitHit("You've hit your session limit · resets 3pm", now)?.resetsAt, serverLocal(15));
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

test("the reset time is read in the zone the message names", () => {
  // 14:30 UTC on 2 Oct 2026 is 10:30 in New York (EDT, UTC-4).
  const at = new Date(Date.UTC(2026, 9, 2, 14, 30));
  assert.equal(
    parseLimitHit("You've hit your session limit · resets 7:20pm (America/New_York)", at)?.resetsAt,
    Date.UTC(2026, 9, 2, 23, 20),
  );
  assert.equal(
    parseLimitHit("You've hit your weekly limit · resets Oct 6 at 9pm (Asia/Tokyo)", at)?.resetsAt,
    Date.UTC(2026, 9, 6, 12, 0),
  );
});
