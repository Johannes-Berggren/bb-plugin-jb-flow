// Whether a thread's last status report still describes it. Shared by the
// thread monitor and "Update status in every open pane".

/** A report older than this is asked for again. */
export const STATUS_OUTDATED_MS = 6 * 3_600_000;

/** Why a report is out of date; null while it is current. */
export type StatusAge = "missing" | "replied-since" | "old" | null;

export function statusAge(
  status: { report: { capturedAt: number } | null; latestAt: number } | null | undefined,
  now: number,
): StatusAge {
  if (!status?.report) return "missing";
  // The agent has said more since: a minute's grace covers the report's own reply.
  if (status.latestAt > status.report.capturedAt + 60_000) return "replied-since";
  return now - status.report.capturedAt > STATUS_OUTDATED_MS ? "old" : null;
}

export const STATUS_AGE_LABEL: Record<Exclude<StatusAge, null>, string> = {
  missing: "No status report yet",
  "replied-since": "The agent replied after its last report",
  old: "The last report is more than 6 hours old",
};
