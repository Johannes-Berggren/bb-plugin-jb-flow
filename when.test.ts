import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWhen, formatDue, parseDue, parseDueLine } from "./when.ts";

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

test("days keep the clock time across a DST change", () => {
  const now = new Date(2026, 9, 23, 9, 30); // the weekend before EU clocks go back
  const later = new Date(parseWhen("3d", now));
  assert.equal(later.getHours(), 9);
  assert.equal(later.getMinutes(), 30);
  assert.equal(later.getDate(), 26);
});

const WED = new Date(2026, 10, 4, 16, 30);
const endOf = (year: number, month: number, day: number) => new Date(year, month, day, 23, 59, 59, 999).getTime();

test("a due day means the end of that day, not 08:00", () => {
  assert.equal(parseDue("2026-11-05", WED), endOf(2026, 10, 5));
  assert.equal(parseDue("today", WED), endOf(2026, 10, 4));
  assert.equal(parseDue("tomorrow", WED), endOf(2026, 10, 5));
  assert.equal(parseDue("fri", WED), endOf(2026, 10, 6));
  assert.equal(parseDue("1w", WED), endOf(2026, 10, 11));
});

test("a due date may already have passed", () => {
  assert.equal(parseDue("2026-11-01", WED), endOf(2026, 10, 1));
  assert.equal(parseDue("2026-11-01T09:00", WED), new Date(2026, 10, 1, 9, 0).getTime());
});

test("hours and exact times stay exact", () => {
  assert.equal(parseDue("2h", WED), WED.getTime() + 2 * 3_600_000);
  assert.equal(parseDue("2026-11-05 14:30", WED), new Date(2026, 10, 5, 14, 30).getTime());
});

test("a date that doesn't exist or can't be read is refused", () => {
  assert.throws(() => parseDue("2026-02-31", WED));
  assert.throws(() => parseDue("soon", WED));
});

test("a report's Due line gives a date and what falls due", () => {
  assert.deepEqual(parseDueLine("2026-11-05 · invoices fall due"), { at: endOf(2026, 10, 5), reason: "invoices fall due" });
  assert.deepEqual(parseDueLine("2026-11-05"), { at: endOf(2026, 10, 5), reason: null });
  assert.deepEqual(parseDueLine("2026-11-05 - board meeting"), { at: endOf(2026, 10, 5), reason: "board meeting" });
});

test("a Due line that isn't an exact date is ignored", () => {
  assert.equal(parseDueLine("sometime next week"), null);
  assert.equal(parseDueLine("Friday"), null);
  assert.equal(parseDueLine("2026-02-31 · no such day"), null);
});

test("deadlines read in days around today", () => {
  assert.equal(formatDue(endOf(2026, 10, 4), WED), "due today");
  assert.equal(formatDue(endOf(2026, 10, 5), WED), "due tomorrow");
  assert.equal(formatDue(endOf(2026, 10, 6), WED), "due Fri");
  assert.equal(formatDue(endOf(2026, 10, 20), WED), "due 20 Nov");
  assert.equal(formatDue(new Date(2026, 10, 4, 9).getTime(), WED), "overdue");
  assert.equal(formatDue(endOf(2026, 10, 2), WED), "2d overdue");
});
