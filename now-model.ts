// The Now queue: who holds each thread, which threads belong at the top of the
// sidebar, and in what order. Pure (no React, no SDK at runtime) so node:test
// covers it; the sidebar and the server share it.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";
import { formatDue } from "./when.ts";
import { replyQueued } from "./needs-me.ts";

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

export type NowFlow = Pick<FlowState, "awaiting" | "promised" | "waitingOthers" | "readyToGo" | "watching" | "focused" | "due"> & {
  threadPrs: Record<string, readonly { state: string; attention: string }[]>;
};

export type NowEntry = {
  thread: NowThread;
  state: BallState;
  focused: boolean;
  /** How long it has been in this state's hands, for the row and the order. */
  since: number;
  /** Its deadline, if it has one. */
  dueAt: number | null;
};

/** A promise to report back counts as stalled after this long (matches awaiting.ts). */
const STALLED_AFTER_MS = 60 * 60_000;
/** A thread with nothing going on counts as cold after this long; before that it has only just finished. */
export const COLD_AFTER_MS = 4 * 60 * 60_000;
/** Due this close, a thread joins Now by itself if it wants something from you. */
const DUE_SOON_MS = 48 * 60 * 60_000;
/** Due this close, it joins unless an agent or a watch is already on it, so you can chase people in time. */
export const DUE_NOW_MS = 24 * 60 * 60_000;

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

export const DEFAULT_FOCUS_LIMIT = 7;
/** The limit from its setting, whatever was typed there. */
export const focusLimitOf = (setting: unknown) => Math.max(1, Number(setting) || DEFAULT_FOCUS_LIMIT);

const openPrs = (thread: NowThread, flow: NowFlow) =>
  (flow.threadPrs[thread.id] ?? []).filter((pr) => pr.state === "open" || pr.state === "draft");

const actionablePr = (thread: NowThread, flow: NowFlow) => {
  const attentions = openPrs(thread, flow).map((pr) => pr.attention);
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
    dueAt: flow.due[thread.id]?.at ?? null,
  };
}

/** Today's Needs me: blocked on you, or an ask you haven't read yet. */
const wantsYouAnyway = (entry: NowEntry) => entry.state === "blocked" || (entry.state === "yours" && entry.thread.isUnread);

const dueWithin = (entry: NowEntry, ms: number, now: number) => entry.dueAt !== null && entry.dueAt - now <= ms;

function belongsInNow(entry: NowEntry, now: number): boolean {
  if (wantsYouAnyway(entry)) return true;
  if (NOW_STATES.has(entry.state) && (entry.focused || dueWithin(entry, DUE_SOON_MS, now))) return true;
  return dueWithin(entry, DUE_NOW_MS, now) && entry.state !== "running" && entry.state !== "watched";
}

/** Lower comes first. */
function tier(entry: NowEntry, now: number): number {
  const dueSoon = dueWithin(entry, DUE_SOON_MS, now);
  if ((entry.focused || dueSoon) && entry.state === "blocked") return 1;
  if (dueWithin(entry, DUE_NOW_MS, now)) return 2;
  // An agent waiting on your answer comes before a thread with no next step:
  // answering unblocks it at once, and a cold thread may simply be finished.
  if (entry.focused) return entry.state === "cold" ? 3.5 : 3;
  if (dueSoon) return 4;
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
  const entries = threads
    .map((thread) => entryFor(thread, flow, options.now))
    // Snoozing hides a thread, unless its deadline is about to pass while it sleeps.
    .filter((entry) => !entry.thread.snoozed || dueWithin(entry, DUE_NOW_MS, options.now));
  const rank = (entry: NowEntry) => tier(entry, options.now);
  const now = entries
    .filter((entry) => belongsInNow(entry, options.now))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        // Deadlines go soonest first; everything else, longest wait first.
        (rank(a) === 2 || rank(a) === 4 ? a.dueAt! - b.dueAt! : 0) ||
        a.since - b.since ||
        (a.thread.id < b.thread.id ? -1 : a.thread.id > b.thread.id ? 1 : 0),
    );

  const open = options.openThreadId ?? null;
  const index = open === null ? -1 : (options.previous ?? []).indexOf(open);
  if (index !== -1 && !now.some((entry) => entry.thread.id === open)) {
    const entry = entries.find((candidate) => candidate.thread.id === open);
    if (entry) now.splice(Math.min(index, now.length), 0, entry);
  }

  const inNow = new Set(now.map((entry) => entry.thread.id));
  const moving = entries
    .filter((entry) => entry.focused && !entry.thread.snoozed && !inNow.has(entry.thread.id))
    .sort((a, b) => a.since - b.since || (a.thread.id < b.thread.id ? -1 : 1));
  return { now, moving };
}

/** Waiting on you right now: blocked, your answer, or a date that has passed. What a workspace tab counts. */
export const needsYouNow = (entries: readonly NowEntry[], now: number) =>
  entries.filter((entry) => entry.state === "blocked" || entry.state === "yours" || (entry.dueAt !== null && entry.dueAt < now)).length;

/**
 * The thread after this one, wrapping around. Threads stay in Now after you read
 * them, so "next" has to move on from where you are rather than start at the top.
 */
export function nextAfter(order: readonly string[], current: string | null): string | null {
  const index = current === null ? -1 : order.indexOf(current);
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(index + step) % order.length]!;
    if (candidate !== current) return candidate;
  }
  return null;
}

/** "12m", "44h", "3d": short enough for a sidebar row. */
export function waited(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const WATCH_LABEL = { ci: "CI watch", release: "release watch", continue: "auto-continue" } as const;

/** What the row says: the deadline if there is one, then who holds the thread. */
export function reasonLabel(entry: NowEntry, flow: NowFlow, now: number): string {
  const holder = holderLabel(entry, flow, now);
  return entry.dueAt === null ? holder : `${formatDue(entry.dueAt, new Date(now))} · ${holder.replace(" · ", " ")}`;
}

function holderLabel(entry: NowEntry, flow: NowFlow, now: number): string {
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
  thread: Pick<PluginSidebarThread, "id" | "status" | "indicator" | "hasPendingInteraction" | "isUnread" | "latestAttentionAt"> & { queuedWork?: string },
  snoozed: boolean,
): NowThread {
  return {
    id: thread.id,
    // A reply waiting in the queue counts as running: the next move is the agent's.
    busy: thread.status === "active" || thread.status === "starting" || thread.status === "stopping" || replyQueued(thread),
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

/** The server's view of a thread, which has read times rather than an unread flag. */
export function serverNowThread(
  thread: { id: string; status: string; hasPendingInteraction: boolean; latestAttentionAt: number | null; lastReadAt: number | null; createdAt: number; queuedWork?: string },
  snoozed: boolean,
): NowThread {
  return {
    id: thread.id,
    busy: thread.status === "active" || thread.status === "starting" || thread.status === "stopping" || replyQueued(thread),
    blocked: thread.hasPendingInteraction ? "input" : thread.status === "error" ? "failed" : null,
    isUnread: thread.latestAttentionAt !== null && (thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt),
    snoozed,
    attentionAt: thread.latestAttentionAt ?? thread.createdAt,
  };
}
