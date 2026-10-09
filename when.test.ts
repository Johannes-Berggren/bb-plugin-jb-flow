import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWhen } from "./when.ts";

// Thursday 2026-10-01 14:30 local time.
const now = new Date(2026, 9, 1, 14, 30);
const local = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

test("relative offsets", () => {
  assert.equal(parseWhen("30m", now), now.getTime() + 30 * 60_000);
  assert.equal(parseWhen("2h", now), now.getTime() + 2 * 3_600_000);
  assert.equal(parseWhen("3d", now), now.getTime() + 3 * 86_400_000);
  assert.equal(parseWhen("1w", now), now.getTime() + 7 * 86_400_000);
});

test("named times", () => {
  assert.equal(parseWhen("today", now), local(2026, 10, 1, 17));
  assert.equal(parseWhen("tonight", now), local(2026, 10, 1, 20));
  assert.equal(parseWhen("tomorrow", now), local(2026, 10, 2, 8));
  assert.equal(parseWhen("next-week", now), local(2026, 10, 5, 8));
});

test("today after 17:00 falls back to +3h", () => {
  const late = new Date(2026, 9, 1, 18, 0);
  assert.equal(parseWhen("today", late), late.getTime() + 3 * 3_600_000);
});

test("weekdays are always in the future", () => {
  assert.equal(parseWhen("mon", now), local(2026, 10, 5, 8));
  assert.equal(parseWhen("Friday", now), local(2026, 10, 2, 8));
  assert.equal(parseWhen("thu", now), local(2026, 10, 8, 8));
  assert.equal(parseWhen("tue", now), local(2026, 10, 6, 8));
});

test("iso dates", () => {
  assert.equal(parseWhen("2026-10-12", now), local(2026, 10, 12, 8));
  assert.equal(parseWhen("2026-10-12T09:30", now), local(2026, 10, 12, 9, 30));
  assert.throws(() => parseWhen("2026-09-01", now), /past/);
});

test("garbage is rejected", () => {
  assert.throws(() => parseWhen("", now));
  assert.throws(() => parseWhen("someday", now), /Cannot parse/);
  assert.throws(() => parseWhen("0h", now), /future/);
});

test("only real day names are weekdays", () => {
  assert.throws(() => parseWhen("monster"));
  assert.throws(() => parseWhen("satisfied"));
  assert.doesNotThrow(() => parseWhen("thursday"));
  assert.doesNotThrow(() => parseWhen("tues"));
});
