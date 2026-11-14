// Who hears about a PR event: the worker thread that asked, or its workspace's
// conductor. Pure, so the rules can be tested apart from gh and bb.
//
// A worker is woken only for news it must act on itself (a failure, review
// feedback, or green when it said it has more to do). Routine news (green,
// merged, closed, no checks, a released build) goes to the conductor, which
// merges, cleans up or forwards. Without a conductor everything goes to the
// worker, exactly as before.

/** What a CI/review watch found. */
export type CiNoteKind =
  | "merged"
  | "closed"
  | "green"
  | "failed"
  | "no-checks"
  | "review"
  | "changes-requested"
  | "comment"
  | "review-hint"
  | "timeout"
  | "unreadable";

/** What the worker will do once its checks pass, given to wait_for_ci. */
export const AFTER_GREEN = ["merge", "continue", "nothing"] as const;
export type AfterGreen = (typeof AFTER_GREEN)[number];

export type CiNote = {
  kind: CiNoteKind;
  /** The text the worker would read, unchanged from before notes had kinds. */
  text: string;
  repo: string;
  pr: number;
  afterGreen?: AfterGreen;
  /** The commit the news is about (checks), so a merge can't take a newer, unchecked push. */
  headSha?: string;
};

export type Route = "worker" | "conductor";

const WORKER_KINDS: ReadonlySet<CiNoteKind> = new Set(["failed", "review", "changes-requested", "comment", "review-hint"]);

export function routeNote(note: Pick<CiNote, "kind" | "afterGreen">): Route {
  if (WORKER_KINDS.has(note.kind)) return "worker";
  if (note.kind === "green") return note.afterGreen === "continue" ? "worker" : "conductor";
  return "conductor";
}

/** Splits one thread's notes. Without a conductor (`hasConductor` false) the worker gets all of them. */
export function splitNotes<T extends Pick<CiNote, "kind" | "afterGreen">>(
  notes: readonly T[],
  hasConductor: boolean,
): { worker: T[]; conductor: T[] } {
  if (!hasConductor) return { worker: [...notes], conductor: [] };
  const worker: T[] = [];
  const conductor: T[] = [];
  for (const note of notes) (routeNote(note) === "worker" ? worker : conductor).push(note);
  return { worker, conductor };
}

/** One event for a conductor's inbox. */
export type ConductorInboxEvent = {
  kind: string;
  text: string;
  meta?: Record<string, unknown>;
};

/**
 * Where routed events go. `workspaceFor` answers the workspace whose conductor
 * should hear about a thread, or null when it has none (then nothing changes).
 */
export type ConductorSink = {
  workspaceFor: (threadId: string) => Promise<string | null>;
  deliver: (threadId: string, workspaceId: string, events: readonly ConductorInboxEvent[]) => Promise<void>;
};

export function noteEvent(note: CiNote): ConductorInboxEvent {
  return {
    kind: note.kind,
    text: note.text,
    meta: {
      repo: note.repo,
      pr: note.pr,
      ...(note.afterGreen ? { afterGreen: note.afterGreen } : {}),
      ...(note.headSha ? { headSha: note.headSha } : {}),
    },
  };
}
