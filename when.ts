// Parses a human "when" into an epoch-ms timestamp, in the local time of
// whoever runs it: the browser for the snooze dialog, the server for the CLI.
//
// Accepted forms:
//   30m, 2h, 3d, 1w           relative offsets
//   today                     today 17:00 (or +3h if that has passed)
//   tonight                   today 20:00
//   tomorrow                  tomorrow 08:00
//   mon … sun / monday …      next such weekday 08:00 (never today)
//   next-week                 next Monday 08:00
//   2026-10-05, 2026-10-05T09:30   ISO date (date only → 08:00)

const MORNING_HOUR = 8;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_SUFFIX: Record<string, string> = {
  sun: "day",
  mon: "day",
  tue: "s|sday",
  wed: "nesday",
  thu: "r|rs|rsday",
  fri: "day",
  sat: "urday",
};

function atHour(date: Date, hour: number): Date {
  const next = new Date(date);
  next.setHours(hour, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** The snooze choices offered before free text. */
export const SNOOZE_PRESETS = [
  { label: "Later today", when: "today" },
  { label: "Tomorrow", when: "tomorrow" },
  { label: "Monday", when: "mon" },
  { label: "In 1 week", when: "1w" },
  { label: "In 2 weeks", when: "2w" },
] as const;

export function parseWhen(input: string, now: Date = new Date()): number {
  const value = input.trim().toLowerCase();
  if (value === "") throw new Error("Missing time. Try 2h, 3d, tomorrow, mon, or 2026-10-05.");

  const relative = /^(\d+)\s*(m|min|h|d|w)$/.exec(value);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2] as "m" | "min" | "h" | "d" | "w";
    if (amount <= 0) throw new Error(`"${input}" must be in the future.`);
    // Days and weeks are calendar days: same clock time across a DST change.
    if (unit === "d" || unit === "w") return addDays(now, amount * (unit === "w" ? 7 : 1)).getTime();
    return now.getTime() + amount * (unit === "h" ? 3_600_000 : 60_000);
  }

  if (value === "today") {
    const evening = atHour(now, 17);
    return evening > now ? evening.getTime() : now.getTime() + 3 * 3_600_000;
  }
  if (value === "tonight") {
    const night = atHour(now, 20);
    return night > now ? night.getTime() : now.getTime() + 3 * 3_600_000;
  }
  if (value === "tomorrow") return atHour(addDays(now, 1), MORNING_HOUR).getTime();
  if (value === "next-week" || value === "nextweek") {
    const delta = ((1 - now.getDay() + 7) % 7) || 7;
    return atHour(addDays(now, delta), MORNING_HOUR).getTime();
  }

  // "mon", "monday", "tues", "wednesday"; not "monster" or "satisfied".
  const weekday = WEEKDAYS.findIndex((day) => new RegExp(`^${day}(?:${DAY_SUFFIX[day]})?$`).test(value));
  if (weekday !== -1 && value.length <= 9) {
    const delta = ((weekday - now.getDay() + 7) % 7) || 7;
    return atHour(addDays(now, delta), MORNING_HOUR).getTime();
  }

  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoDate !== null) {
    const date = new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]), MORNING_HOUR);
    if (date <= now) throw new Error(`"${input}" is in the past.`);
    return date.getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/.test(value)) {
    const parsed = new Date(input.trim());
    if (Number.isNaN(parsed.getTime())) throw new Error(`Cannot parse "${input}".`);
    if (parsed <= now) throw new Error(`"${input}" is in the past.`);
    return parsed.getTime();
  }

  throw new Error(`Cannot parse "${input}". Try 2h, 3d, 1w, tomorrow, mon, next-week, or 2026-10-05.`);
}

export function formatWhen(timestamp: number, now: Date = new Date()): string {
  const date = new Date(timestamp);
  const days = Math.round((atHour(date, 0).getTime() - atHour(now, 0).getTime()) / 86_400_000);
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

// --- due dates -----------------------------------------------------------------------

/** The due choices offered before free text. */
export const DUE_PRESETS = [
  { label: "Today", when: "today" },
  { label: "Tomorrow", when: "tomorrow" },
  { label: "Friday", when: "fri" },
  { label: "In 1 week", when: "1w" },
] as const;

function endOfDay(date: Date): number {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

/**
 * Like parseWhen, for a deadline: a day means the end of that day, not 08:00, and
 * a date may be in the past, because a deadline can already have been missed.
 */
export function parseDue(input: string, now: Date = new Date()): number {
  const value = input.trim().toLowerCase();
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoDate !== null) {
    const [year, month, day] = [Number(isoDate[1]), Number(isoDate[2]), Number(isoDate[3])];
    const date = new Date(year, month - 1, day);
    // new Date rolls 2026-02-31 over into March.
    if (date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error(`"${input}" isn't a date.`);
    return endOfDay(date);
  }
  if (/^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}/.test(value)) {
    const parsed = new Date(input.trim().replace(" ", "T"));
    if (Number.isNaN(parsed.getTime())) throw new Error(`Cannot parse "${input}".`);
    return parsed.getTime();
  }
  if (value === "today" || value === "tonight") return endOfDay(now);
  // Hours and minutes are exact; anything longer means that day.
  if (/^\d+\s*(?:m|min|h)$/.test(value)) return parseWhen(value, now);
  return endOfDay(new Date(parseWhen(value, now)));
}

/** A status report's "**Due:** 2026-11-05 · invoices fall due". Dates only: agents write exact ones, and anything else is ignored. */
export function parseDueLine(line: string): { at: number; reason: string | null } | null {
  const match = /^(\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2})?)\s*(?:[·:–—-]\s*(.*))?$/.exec(line.trim());
  if (match === null) return null;
  try {
    return { at: parseDue(match[1]!), reason: match[2]?.trim() || null };
  } catch {
    return null;
  }
}

/** "due tomorrow", "due Fri", "due 12 Nov", "overdue", "2d overdue". */
export function formatDue(at: number, now: Date = new Date()): string {
  const date = new Date(at);
  const days = Math.round((atHour(date, 0).getTime() - atHour(now, 0).getTime()) / 86_400_000);
  if (days < 0) return `${-days}d overdue`;
  if (at < now.getTime()) return "overdue";
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days < 7) return `due ${date.toLocaleDateString("en-GB", { weekday: "short" })}`;
  return `due ${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
}
