// Parses a human "when" into an epoch-ms timestamp, in server-local time.
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

export function parseWhen(input: string, now: Date = new Date()): number {
  const value = input.trim().toLowerCase();
  if (value === "") throw new Error("Missing time. Try 2h, 3d, tomorrow, mon, or 2026-10-05.");

  const relative = /^(\d+)\s*(m|min|h|d|w)$/.exec(value);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unitMs = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
      relative[2] as "m" | "min" | "h" | "d" | "w"
    ];
    if (amount <= 0) throw new Error(`"${input}" must be in the future.`);
    return now.getTime() + amount * unitMs;
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

  const weekday = WEEKDAYS.findIndex((day) => value.startsWith(day) && /^[a-z]+$/.test(value));
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
