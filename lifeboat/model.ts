import type { Account, Snapshot, UsageWindow } from "./contract";

export const STALE_MS = 30 * 60_000;
export type AccountStatus =
  | "ready"
  | "near-limit"
  | "limited"
  | "stale"
  | "reset-due"
  | "unknown"
  | "attention";
export const STATUS_LABEL: Record<AccountStatus, string> = {
  ready: "Ready",
  "near-limit": "Running low",
  limited: "At limit",
  stale: "Reading is old",
  "reset-due": "Reset due",
  unknown: "No reading yet",
  attention: "Needs attention",
};
export function primaryWindows(account: Account): UsageWindow[] {
  return (
    account.reading?.windows.filter(
      (window) => window.kind === "session" || window.kind === "weekly",
    ) ?? []
  );
}
export function accountStatus(
  account: Account,
  now: number,
  issue?: string,
): AccountStatus {
  if (issue) return "attention";
  const reading = account.reading;
  if (!reading || !reading.windows.length) return "unknown";
  if (reading.risk === "stale") return "attention";
  if (now - Date.parse(reading.lastRefreshed) > STALE_MS) return "stale";
  const windows = primaryWindows(account);
  if (
    windows.some(
      (window) => window.resetsAt && Date.parse(window.resetsAt) <= now,
    )
  )
    return "reset-due";
  if (!windows.length) return "unknown";
  const used = Math.max(...windows.map((window) => window.usedPercent));
  return used >= 100 ? "limited" : used >= 80 ? "near-limit" : "ready";
}
export function remaining(account: Account): number | null {
  const windows = primaryWindows(account);
  return windows.length
    ? Math.max(
        0,
        100 - Math.max(...windows.map((window) => window.usedPercent)),
      )
    : null;
}
export function recommended(
  snapshot: Snapshot,
  provider: Account["provider"],
  now: number,
): Account | null {
  return (
    snapshot.accounts
      .filter(
        (account) =>
          account.provider === provider &&
          !account.isActive &&
          accountStatus(account, now, snapshot.issues[account.id]) ===
            "ready" &&
          account.reading?.windows.every(
            (window) =>
              window.usedPercent < 100 &&
              (!window.resetsAt || Date.parse(window.resetsAt) > now),
          ),
      )
      .sort(
        (a, b) =>
          (remaining(b) ?? -1) - (remaining(a) ?? -1) ||
          a.priority - b.priority,
      )[0] ?? null
  );
}
export function resetLabel(window: UsageWindow, now: number): string {
  if (!window.resetsAt) return "Reset time unavailable";
  const delta = Date.parse(window.resetsAt) - now;
  if (delta <= 0) return "Reset due · refresh to confirm";
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 1440)
    return `Resets in ${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `Resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(Date.parse(window.resetsAt))}`;
}
export function ageLabel(at: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function bytesLabel(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}
export type ChartPoint = {
  at: number;
  used: number;
  resetAt: string | null | undefined;
};
/** Separate paths across resets and missing data; never connect different windows. */
export function historySegments(
  snapshot: Snapshot,
  accountId: string,
  windowId: string,
): ChartPoint[][] {
  const points = snapshot.history
    .filter((record) => record.accountID === accountId)
    .flatMap((record) => {
      const window = record.windows.find((window) => window.id === windowId);
      return window
        ? [
            {
              at: Date.parse(record.timestamp),
              used: window.usedPercent,
              resetAt: window.resetDate,
            },
          ]
        : [];
    })
    .sort((a, b) => a.at - b.at);
  const segments: ChartPoint[][] = [];
  for (const point of points) {
    const current = segments[segments.length - 1];
    const previous = current?.[current.length - 1];
    if (
      !previous ||
      point.used < previous.used - 0.5 ||
      point.at - previous.at > 12 * 3600_000 ||
      (previous.resetAt &&
        point.resetAt &&
        Date.parse(point.resetAt) - Date.parse(previous.resetAt) > 30 * 60_000)
    ) {
      segments.push([point]);
    } else current!.push(point);
  }
  return segments;
}
