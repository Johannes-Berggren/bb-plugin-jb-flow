// The Now queue: who holds each thread, which threads belong at the top of the
// sidebar, and in what order. Pure (no React, no SDK at runtime) so node:test
// covers it; the sidebar and the server share it.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";

/** Who holds the thread. Checked in this order, see `ballState`. */
export type BallState =
  | "blocked"
  | "running"
  | "yours"
  | "stalled"
  | "pr"
  | "go"
  | "watched"
  | "others"
  | "recent"
  | "cold";

export type NowThread = {
  id: string;
  busy: boolean;
  /** Stopped until you act: a prompt or permission, or a failed run. */
  blocked: "input" | "failed" | null;
  isUnread: boolean;
  snoozed: boolean;
  /** When the thread last wanted attention. Reading it doesn't move this, unlike `updatedAt`. */
  attentionAt: number;
};

export type NowFlow = Pick<FlowState, "awaiting" | "promised" | "waitingOthers" | "readyToGo" | "watching" | "threadPrs" | "focused">;

export type NowEntry = {
  thread: NowThread;
  state: BallState;
  focused: boolean;
  /** How long it has been in this state's hands, for the row and the order. */
  since: number;
};

/** A promise to report back counts as stalled after this long (matches awaiting.ts). */
const STALLED_AFTER_MS = 60 * 60_000;
/** A thread with nothing going on counts as cold after this long; before that it has only just finished. */
export const COLD_AFTER_MS = 4 * 60 * 60_000;

/** The states that want something from you. The rest are moving without you. */
const NOW_STATES: ReadonlySet<BallState> = new Set(["blocked", "yours", "stalled", "pr", "go", "cold"]);

/** PR states you can act on, worst first. */
const ACTIONABLE_PRS = ["checks_failed", "changes_requested", "conflicts", "ready_to_merge"] as const;
const PR_LABEL: Record<(typeof ACTIONABLE_PRS)[number], string> = {
  checks_failed: "checks failed",
  changes_requested: "changes requested",
  conflicts: "conflicts",
  ready_to_merge: "ready to merge",
};

const openPrs = (thread: NowThread, flow: NowFlow) =>
  (flow.threadPrs[thread.id] ?? []).filter((pr) => pr.state === "open" || pr.state === "draft");

const actionablePr = (thread: NowThread, flow: NowFlow) => {
  const attentions = openPrs(thread, flow).map((pr) => pr.attention as string);
  return ACTIONABLE_PRS.find((attention) => attentions.includes(attention));
};

export function ballState(thread: NowThread, flow: NowFlow, now: number): BallState {
  if (thread.blocked !== null) return "blocked";
  if (thread.busy) return "running";
  if (flow.awaiting[thread.id] !== undefined) return "yours";
  const watched = flow.watching[thread.id] !== undefined;
  const quiet = now - thread.attentionAt;
  if (flow.promised[thread.id] !== undefined && !watched && quiet > STALLED_AFTER_MS) return "stalled";
  if (actionablePr(thread, flow) !== undefined) return "pr";
  if (flow.readyToGo[thread.id] !== undefined) return "go";
  if (watched) return "watched";
  const open = openPrs(thread, flow);
  if (flow.waitingOthers[thread.id] !== undefined || (open.length > 0 && open.every((pr) => pr.attention === "review_requested"))) return "others";
  return quiet < COLD_AFTER_MS ? "recent" : "cold";
}

function entryFor(thread: NowThread, flow: NowFlow, now: number): NowEntry {
  const state = ballState(thread, flow, now);
  const asked = flow.awaiting[thread.id];
  return {
    thread,
    state,
    focused: flow.focused[thread.id] !== undefined,
    // An ask carries when it was first seen, which a backfill sets late; the thread's own time wins then.
    since: state === "yours" && asked !== undefined ? Math.min(asked, thread.attentionAt) : thread.attentionAt,
  };
}

/** Today's Needs me: blocked on you, or an ask you haven't read yet. */
const wantsYouAnyway = (entry: NowEntry) => entry.state === "blocked" || (entry.state === "yours" && entry.thread.isUnread);

/** Lower comes first. Gaps are kept for the deadline tiers. */
function tier(entry: NowEntry): number {
  if (entry.focused && entry.state === "blocked") return 1;
  // An agent waiting on your answer comes before a thread with no next step:
  // answering unblocks it at once, and a cold thread may simply be finished.
  if (entry.focused) return entry.state === "cold" ? 3.5 : 3;
  return 5;
}

export type NowQueue = { now: NowEntry[]; moving: NowEntry[] };

export function nowQueue(
  threads: readonly NowThread[],
  flow: NowFlow,
  options: {
    now: number;
    /** The open thread keeps its row until you open another, so it can't vanish mid-reply. */
    openThreadId?: string | null;
    /** The order last shown, to put the open thread back where it was. */
    previous?: readonly string[];
  },
): NowQueue {
  const entries = threads.filter((thread) => !thread.snoozed).map((thread) => entryFor(thread, flow, options.now));
  const now = entries
    .filter((entry) => wantsYouAnyway(entry) || (entry.focused && NOW_STATES.has(entry.state)))
    .sort((a, b) => tier(a) - tier(b) || a.since - b.since || (a.thread.id < b.thread.id ? -1 : a.thread.id > b.thread.id ? 1 : 0));

  const open = options.openThreadId ?? null;
  const index = open === null ? -1 : (options.previous ?? []).indexOf(open);
  if (index !== -1 && !now.some((entry) => entry.thread.id === open)) {
    const entry = entries.find((candidate) => candidate.thread.id === open);
    if (entry) now.splice(Math.min(index, now.length), 0, entry);
  }

  const inNow = new Set(now.map((entry) => entry.thread.id));
  const moving = entries
    .filter((entry) => entry.focused && !inNow.has(entry.thread.id))
    .sort((a, b) => a.since - b.since || (a.thread.id < b.thread.id ? -1 : 1));
  return { now, moving };
}

/** "12m", "44h", "3d": short enough for a sidebar row. */
export function waited(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const WATCH_LABEL = { ci: "CI watch", release: "release watch", continue: "auto-continue" } as const;

/** What the row says about who holds the thread, and for how long if it's you. */
export function reasonLabel(entry: NowEntry, flow: NowFlow, now: number): string {
  const age = waited(now - entry.since);
  switch (entry.state) {
    case "blocked":
      return `${entry.thread.blocked === "failed" ? "failed" : "needs input"} · ${age}`;
    case "running":
      return "running";
    case "yours":
      return `you · ${age}`;
    case "stalled":
      return `stalled · ${age}`;
    case "pr": {
      const attention = actionablePr(entry.thread, flow);
      return attention ? PR_LABEL[attention] : "PR";
    }
    case "go":
      return `your go · ${age}`;
    case "watched": {
      const kind = flow.watching[entry.thread.id]?.kind;
      return kind ? WATCH_LABEL[kind] : "watched";
    }
    case "others":
      return "waiting on others";
    case "recent":
      return "just finished";
    case "cold":
      return `no next step · ${age}`;
  }
}

/** The sidebar's view of a thread, in the shape the queue reads. */
export function sidebarNowThread(
  thread: Pick<PluginSidebarThread, "id" | "status" | "indicator" | "hasPendingInteraction" | "isUnread" | "latestAttentionAt">,
  snoozed: boolean,
): NowThread {
  return {
    id: thread.id,
    busy: thread.status === "active" || thread.status === "starting" || thread.status === "stopping",
    blocked:
      thread.hasPendingInteraction || thread.indicator === "waiting-for-input"
        ? "input"
        : thread.status === "error" || thread.indicator === "unread-error"
          ? "failed"
          : null,
    isUnread: thread.isUnread,
    snoozed,
    attentionAt: thread.latestAttentionAt,
  };
}
