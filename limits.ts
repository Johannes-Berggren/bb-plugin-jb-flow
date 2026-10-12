// Recognizes provider usage-limit messages ("You've hit your session limit ·
// resets 7:20pm (Europe/Oslo)") and works out when the limit resets, so the
// thread can be continued automatically. Times are read in the zone the
// message names ("(Europe/Oslo)"); without one, in server-local time.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export type LimitHit = { kind: "session" | "weekly"; resetsAt: number };

function clock(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text.trim());
  if (match === null) return null;
  let hour = Number(match[1]) % 12;
  if (match[3]!.toLowerCase() === "pm") hour += 12;
  return { hour, minute: Number(match[2] ?? 0) };
}

/** Wall-clock parts of `at` in `timeZone`. */
function partsIn(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return parts;
}

/** Epoch ms of a wall-clock time in `timeZone` (month is 0-based; overflow rolls over). */
function zoned(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const wanted = Date.UTC(year, month, day, hour, minute);
  let at = wanted;
  // Two passes settle the offset, also across a DST change.
  for (let pass = 0; pass < 2; pass += 1) {
    const p = partsIn(at, timeZone);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    at += wanted - seen;
  }
  return at;
}

function validZone(name: string | undefined): string | null {
  if (!name) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return null;
  }
}

/**
 * Returns the reset time for a session or weekly limit message, or null when
 * the text is not a limit message or the limit has no automatic reset (e.g. an
 * org's monthly spend limit, which needs a human to raise it).
 */
export function parseLimitHit(text: string, now: Date = new Date()): LimitHit | null {
  const match = /hit your (session|weekly) limit[^\n]*?resets\s+([^(\n·*]+)/i.exec(text);
  if (match === null) return null;
  const kind = match[1]!.toLowerCase() as LimitHit["kind"];
  const when = match[2]!.trim();
  const zone = validZone(/^\s*\(([^)\s]+)\)/.exec(text.slice(match.index + match[0].length))?.[1]);
  if (zone !== null) return parseInZone(kind, when, zone, now);

  // "Sep 29 at 9pm" / "Oct 6, 9am"
  const dated = /^([a-z]{3})[a-z]*\s+(\d{1,2})(?:,|\s+at)?\s+(.+)$/i.exec(when);
  if (dated) {
    const month = MONTHS.indexOf(dated[1]!.toLowerCase());
    const time = clock(dated[3]!);
    if (month === -1 || time === null) return null;
    const date = new Date(now.getFullYear(), month, Number(dated[2]), time.hour, time.minute);
    // A reset in "Jan" seen in December belongs to next year.
    if (date.getTime() < now.getTime() - 86_400_000) date.setFullYear(date.getFullYear() + 1);
    return { kind, resetsAt: date.getTime() };
  }

  // "7:20pm" / "10pm": the next occurrence of that time.
  const time = clock(when);
  if (time === null) return null;
  const date = new Date(now);
  date.setHours(time.hour, time.minute, 0, 0);
  if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
  return { kind, resetsAt: date.getTime() };
}

function parseInZone(kind: LimitHit["kind"], when: string, zone: string, now: Date): LimitHit | null {
  const today = partsIn(now.getTime(), zone);
  const dated = /^([a-z]{3})[a-z]*\s+(\d{1,2})(?:,|\s+at)?\s+(.+)$/i.exec(when);
  if (dated) {
    const month = MONTHS.indexOf(dated[1]!.toLowerCase());
    const time = clock(dated[3]!);
    if (month === -1 || time === null) return null;
    let resetsAt = zoned(zone, today.year, month, Number(dated[2]), time.hour, time.minute);
    // A reset in "Jan" seen in December belongs to next year.
    if (resetsAt < now.getTime() - 86_400_000) resetsAt = zoned(zone, today.year + 1, month, Number(dated[2]), time.hour, time.minute);
    return { kind, resetsAt };
  }
  const time = clock(when);
  if (time === null) return null;
  let resetsAt = zoned(zone, today.year, today.month - 1, today.day, time.hour, time.minute);
  if (resetsAt <= now.getTime()) resetsAt = zoned(zone, today.year, today.month - 1, today.day + 1, time.hour, time.minute);
  return { kind, resetsAt };
}
