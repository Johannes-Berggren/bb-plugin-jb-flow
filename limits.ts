// Recognizes provider usage-limit messages ("You've hit your session limit ·
// resets 7:20pm (Europe/Oslo)") and works out when the limit resets, so the
// thread can be continued automatically. Times are server-local.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export type LimitHit = { kind: "session" | "weekly"; resetsAt: number };

function clock(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text.trim());
  if (match === null) return null;
  let hour = Number(match[1]) % 12;
  if (match[3]!.toLowerCase() === "pm") hour += 12;
  return { hour, minute: Number(match[2] ?? 0) };
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
