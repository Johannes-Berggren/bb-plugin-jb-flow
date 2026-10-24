// Catch up's model: which unread threads are in the deck, their order, and the
// session behind it (each card's outcome, undo, new arrivals). Pure (no React,
// no SDK at runtime) so node:test covers it; catch-up.tsx renders it and owns
// every side effect. server.ts uses countSince for the "since you looked" line.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";

/** Opens Catch up; the command, the palette and the home page dispatch it. */
export const CATCH_UP_EVENT = "jb-flow:catch-up";

export type CatchUpThread = Pick<
  PluginSidebarThread,
  | "id"
  | "status"
  | "indicator"
  | "hasPendingInteraction"
  | "isUnread"
  | "isArchived"
  | "isHidden"
  | "parentThreadId"
  | "originKind"
  | "sectionId"
  | "latestAttentionAt"
  | "lastReadAt"
>;
export type CatchUpFlow = Pick<FlowState, "awaiting" | "snoozes" | "snoozedSectionId" | "threadPrs">;

const ACTIONABLE_PRS = new Set(["conflicts", "checks_failed", "changes_requested", "ready_to_merge"]);

export const isBusy = (thread: Pick<CatchUpThread, "status">) =>
  thread.status === "starting" || thread.status === "active" || thread.status === "stopping";
const waitsOnYou = (thread: Pick<CatchUpThread, "hasPendingInteraction" | "indicator">) =>
  thread.hasPendingInteraction || thread.indicator === "waiting-for-input";
const snoozed = (thread: Pick<CatchUpThread, "id" | "sectionId">, flow: CatchUpFlow | null) =>
  flow?.snoozes[thread.id] !== undefined || (flow?.snoozedSectionId != null && thread.sectionId === flow.snoozedSectionId);

/**
 * Unread, visible, awake and top-level (forks count: you made them). A running
 * thread joins when it finishes, unless it's already waiting on you.
 */
export function eligible(thread: CatchUpThread, flow: CatchUpFlow | null): boolean {
  if (!thread.isUnread || thread.isArchived || thread.isHidden || snoozed(thread, flow)) return false;
  if (thread.parentThreadId !== null && thread.originKind !== "fork") return false;
  return !isBusy(thread) || waitsOnYou(thread);
}

/** 0 needs your input · 1 failed · 2 your move · 3 a PR to act on · 4 an update. */
export type Tier = 0 | 1 | 2 | 3 | 4;
export const TIER_LABEL: Record<Tier, string> = {
  0: "Needs your input",
  1: "Failed",
  2: "Your move",
  3: "PR to act on",
  4: "Update",
};
export const needsYou = (tier: Tier) => tier <= 2;

export function tier(thread: CatchUpThread, flow: CatchUpFlow | null): Tier {
  if (waitsOnYou(thread)) return 0;
  if (thread.status === "error" || thread.indicator === "unread-error") return 1;
  if (flow?.awaiting[thread.id] !== undefined) return 2;
  const prs = flow?.threadPrs[thread.id] ?? [];
  if (prs.some((pr) => (pr.state === "open" || pr.state === "draft") && ACTIONABLE_PRS.has(pr.attention))) return 3;
  return 4;
}

export type Queued<T> = { thread: T; tier: Tier };

/** The deck's order: what needs you first, then oldest first, like Your move and the palette. */
export function buildQueue<T extends CatchUpThread>(
  threads: readonly T[],
  flow: CatchUpFlow | null,
  include: (thread: T) => boolean = () => true,
): Queued<T>[] {
  return threads
    .filter((thread) => eligible(thread, flow) && include(thread))
    .map((thread) => ({ thread, tier: tier(thread, flow) }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.thread.latestAttentionAt - b.thread.latestAttentionAt ||
        (a.thread.id < b.thread.id ? -1 : a.thread.id > b.thread.id ? 1 : 0),
    );
}

/** Unread threads still working: they join the deck when they finish. */
export function stillWorking<T extends CatchUpThread>(
  threads: readonly T[],
  flow: CatchUpFlow | null,
  include: (thread: T) => boolean = () => true,
): number {
  return threads.filter(
    (thread) =>
      thread.isUnread &&
      !thread.isArchived &&
      !thread.isHidden &&
      !snoozed(thread, flow) &&
      (thread.parentThreadId === null || thread.originKind === "fork") &&
      isBusy(thread) &&
      !waitsOnYou(thread) &&
      include(thread),
  ).length;
}

export type CatchUpBadge = { count: number; tone: "critical" | "warning" | "neutral"; label: string };

export function badgeFor(queue: readonly Queued<unknown>[]): CatchUpBadge | null {
  if (queue.length === 0) return null;
  const need = queue.filter((item) => needsYou(item.tier)).length;
  return {
    count: queue.length,
    tone: queue.some((item) => item.tier <= 1) ? "critical" : need > 0 ? "warning" : "neutral",
    label: `${queue.length} unread thread${queue.length === 1 ? "" : "s"}${need > 0 ? ` · ${need} need${need === 1 ? "s" : ""} you` : ""}`,
  };
}

// --- the session -------------------------------------------------------------------
// A snapshot of the queue when you start, so cards never reorder under you. New
// arrivals wait behind a "N new" pill; threads read elsewhere are skipped.

export type Outcome = "done" | "kept" | "replied" | "snoozed" | "archived" | "opened" | "elsewhere";
export type CatchUpItem = {
  threadId: string;
  tier: Tier;
  /** When you last read it (null: never), for "since you looked". */
  since: number | null;
  /** The thread's latest activity when the card was dealt; newer means unseen output. */
  seenAt: number;
  outcome: Outcome | null;
  actedAt: number | null;
};
export type UndoEntry = { kind: "one"; index: number; outcome: Outcome } | { kind: "bulk"; indices: number[] };
export type Session = {
  items: CatchUpItem[];
  /** The card on screen; items.length once everything is handled. */
  index: number;
  undo: UndoEntry[];
  /** Workspace the deck covers (null: all). */
  scope: string | null;
  touchedAt: number;
};

/** Reopening within this long, with cards left, carries on where you were. */
export const RESUME_MS = 15 * 60_000;

const item = (queued: Queued<CatchUpThread>): CatchUpItem => ({
  threadId: queued.thread.id,
  tier: queued.tier,
  since: queued.thread.lastReadAt,
  seenAt: queued.thread.latestAttentionAt,
  outcome: null,
  actedAt: null,
});

export function startSession(queue: readonly Queued<CatchUpThread>[], scope: string | null, now: number): Session {
  return { items: queue.map(item), index: 0, undo: [], scope, touchedAt: now };
}

export function resumable(session: Session | null, scope: string | null, now: number): session is Session {
  return (
    session !== null &&
    session.scope === scope &&
    now - session.touchedAt < RESUME_MS &&
    session.items.some((entry) => entry.outcome === null)
  );
}

export function current(session: Session): CatchUpItem | null {
  return session.items[session.index] ?? null;
}

/** The next card still to handle after `from`, wrapping round; items.length when none is left. */
function nextPending(items: readonly CatchUpItem[], from: number): number {
  for (let index = from + 1; index < items.length; index += 1) if (items[index]!.outcome === null) return index;
  for (let index = 0; index <= Math.min(from, items.length - 1); index += 1) if (items[index]!.outcome === null) return index;
  return items.length;
}

/** Up to `count` cards after the current one, to load ahead. */
export function upcoming(session: Session, count: number): CatchUpItem[] {
  const ahead: CatchUpItem[] = [];
  let index = session.index;
  while (ahead.length < count) {
    index = nextPending(session.items, index);
    if (index >= session.items.length || index === session.index) break;
    const next = session.items[index]!;
    if (ahead.includes(next)) break;
    ahead.push(next);
  }
  return ahead;
}

/** Handle the current card and move on. */
export function record(session: Session, outcome: Outcome, now: number): Session {
  const at = session.index;
  const entry = session.items[at];
  if (entry === undefined || entry.outcome !== null) return session;
  const items = session.items.map((candidate, index) => (index === at ? { ...candidate, outcome, actedAt: now } : candidate));
  return { ...session, items, index: nextPending(items, at), undo: [...session.undo, { kind: "one", index: at, outcome }], touchedAt: now };
}

/** A sent reply can't be taken back, so undo stops there. */
export const undoBlocked = (session: Session) => {
  const last = session.undo.at(-1);
  return last?.kind === "one" && last.outcome === "replied";
};

/** Take back the last action: its card is pending again and back on screen. */
export function undo(session: Session, now: number): { session: Session; entry: UndoEntry } | null {
  const entry = session.undo.at(-1);
  if (entry === undefined || undoBlocked(session)) return null;
  const indices = entry.kind === "one" ? [entry.index] : entry.indices;
  const items = session.items.map((candidate, index) =>
    indices.includes(index) ? { ...candidate, outcome: null, actedAt: null } : candidate,
  );
  return {
    session: { ...session, items, index: entry.kind === "one" ? entry.index : session.index, undo: session.undo.slice(0, -1), touchedAt: now },
    entry,
  };
}

/** The card was refreshed after new activity: what's on screen is now what was seen. */
export function reseen(session: Session, latestAttentionAt: number): Session {
  const at = session.index;
  if (session.items[at] === undefined || session.items[at]!.seenAt === latestAttentionAt) return session;
  return { ...session, items: session.items.map((candidate, index) => (index === at ? { ...candidate, seenAt: latestAttentionAt } : candidate)) };
}

/**
 * Cards still to come whose thread was read, archived or snoozed somewhere else
 * are skipped. The card on screen stays, so nothing vanishes while you read it,
 * and so do `ignore`d threads (an undo still marking them unread).
 */
export function settle(
  session: Session,
  live: ReadonlyMap<string, CatchUpThread>,
  flow: CatchUpFlow | null,
  now: number,
  ignore: ReadonlySet<string> = new Set(),
): Session {
  let changed = false;
  const items = session.items.map((candidate, index) => {
    if (candidate.outcome !== null || index === session.index || ignore.has(candidate.threadId)) return candidate;
    const thread = live.get(candidate.threadId);
    const gone = thread === undefined || !thread.isUnread || thread.isArchived || thread.isHidden || snoozed(thread, flow);
    if (!gone) return candidate;
    changed = true;
    return { ...candidate, outcome: "elsewhere" as const, actedAt: now };
  });
  if (!changed) return session;
  const stillHere = items[session.index];
  return { ...session, items, index: stillHere && stillHere.outcome === null ? session.index : nextPending(items, session.index) };
}

/**
 * Threads that became worth a card since the deck was dealt: new unread ones,
 * and ones you handled here that have had new activity since.
 */
export function freshIds(session: Session, queue: readonly Queued<CatchUpThread>[]): string[] {
  const latest = new Map<string, CatchUpItem>();
  for (const entry of session.items) latest.set(entry.threadId, entry);
  return queue
    .filter(({ thread }) => {
      const known = latest.get(thread.id);
      if (known === undefined) return true;
      if (known.outcome === null || known.outcome === "kept") return false;
      return known.actedAt !== null && thread.latestAttentionAt > known.actedAt;
    })
    .map(({ thread }) => thread.id);
}

/** Deal the new arrivals at the end, in queue order. */
export function pullFresh(session: Session, queue: readonly Queued<CatchUpThread>[], now: number): Session {
  const ids = new Set(freshIds(session, queue));
  if (ids.size === 0) return session;
  const items = [...session.items, ...queue.filter(({ thread }) => ids.has(thread.id)).map(item)];
  const atEnd = session.index >= session.items.length;
  return { ...session, items, index: atEnd ? session.items.length : session.index, touchedAt: now };
}

/** Go through the cards you kept unread again. */
export function requeueKept(session: Session, now: number): Session {
  const items = session.items.map((candidate) => (candidate.outcome === "kept" ? { ...candidate, outcome: null, actedAt: null } : candidate));
  const first = items.findIndex((candidate) => candidate.outcome === null);
  return { ...session, items, index: first === -1 ? items.length : first, undo: [], touchedAt: now };
}

/** Cards Mark all read may clear: updates and PRs. Anything that needs you stays. */
export function bulkReadable(session: Session): CatchUpItem[] {
  return session.items.filter((candidate) => candidate.outcome === null && !needsYou(candidate.tier));
}

export function recordBulk(session: Session, now: number): Session {
  const indices = session.items.flatMap((candidate, index) => (candidate.outcome === null && !needsYou(candidate.tier) ? [index] : []));
  if (indices.length === 0) return session;
  const items = session.items.map((candidate, index) => (indices.includes(index) ? { ...candidate, outcome: "done" as const, actedAt: now } : candidate));
  const stays = items[session.index]?.outcome === null;
  return {
    ...session,
    items,
    index: stays ? session.index : nextPending(items, session.index),
    undo: [...session.undo, { kind: "bulk", indices }],
    touchedAt: now,
  };
}

export type Summary = Record<Outcome, number> & { pending: number; total: number };

export function summary(session: Session): Summary {
  const counts: Summary = { done: 0, kept: 0, replied: 0, snoozed: 0, archived: 0, opened: 0, elsewhere: 0, pending: 0, total: session.items.length };
  for (const entry of session.items) {
    if (entry.outcome === null) counts.pending += 1;
    else counts[entry.outcome] += 1;
  }
  return counts;
}

/** Position for the header: the current card's number among everything dealt. */
export function progress(session: Session): { at: number; of: number; handled: number } {
  const handled = session.items.filter((entry) => entry.outcome !== null).length;
  return { at: Math.min(handled + 1, session.items.length), of: session.items.length, handled };
}

// --- "since you looked" ------------------------------------------------------------

type SinceRow = {
  kind: string;
  createdAt: number;
  completedAt?: number | null;
  turnId?: string | null;
  role?: string;
  initiator?: string;
  children?: readonly SinceRow[] | null;
};
export type Since = { turns: number; yourPrompts: number; otherPrompts: number; more: boolean; firstAt: number | null };

/**
 * What happened after `since` in a page of timeline rows: agent turns, prompts
 * you sent and prompts sent for you (CI results, snooze reminders). `more`
 * means even the oldest row in the page is newer, so the counts are a floor.
 */
export function countSince(rows: readonly SinceRow[], since: number | null, hasOlder: boolean): Since {
  const after = since ?? -Infinity;
  const turns = new Set<string>();
  let replies = 0;
  let yourPrompts = 0;
  let otherPrompts = 0;
  let firstAt: number | null = null;
  const visit = (row: SinceRow) => {
    const at = Math.max(row.createdAt, row.completedAt ?? 0);
    if (at > after) {
      firstAt = firstAt === null ? row.createdAt : Math.min(firstAt, row.createdAt);
      if (row.turnId) turns.add(row.turnId);
      if (row.kind === "conversation" && row.role === "assistant") replies += 1;
      if (row.kind === "conversation" && row.role === "user") {
        if (row.initiator === "user") yourPrompts += 1;
        else otherPrompts += 1;
      }
    }
    for (const child of row.children ?? []) visit(child);
  };
  for (const row of rows) visit(row);
  const oldest = rows.reduce((min, row) => Math.min(min, row.createdAt), Infinity);
  return {
    turns: turns.size > 0 ? turns.size : replies,
    yourPrompts,
    otherPrompts,
    more: hasOlder && rows.length > 0 && oldest > after,
    firstAt,
  };
}

// --- next steps on a card ----------------------------------------------------------

export type Steps = {
  mode: "go" | "choice";
  question: string;
  items: Array<{ n: number; text: string; recommended: boolean }>;
};

/** A card's steps from the reply's next move (see nextMove in decisions.ts); null when it offers none. */
export function stepsFrom(
  move: { mode: "go" | "choice"; options: ReadonlyArray<{ n: number; text: string; recommended: boolean }> },
  question = "",
): Steps | null {
  if (move.options.length === 0) return null;
  return { mode: move.mode, question, items: move.options.map((option) => ({ ...option })) };
}

/** Number keys tick steps to go with, or choose one option. */
export function togglePick(steps: Steps, picked: readonly number[], n: number): number[] {
  if (!steps.items.some((step) => step.n === n)) return [...picked];
  if (steps.mode === "choice") return picked[0] === n ? [] : [n];
  return picked.includes(n) ? picked.filter((value) => value !== n) : [...picked, n].sort((a, b) => a - b);
}

/** What sending the pick says: "go", "go 1,3", or an option's number. Null: nothing to send yet. */
export function goText(steps: Steps, picked: readonly number[]): string | null {
  if (steps.mode === "choice") return picked.length === 1 ? String(picked[0]) : null;
  return picked.length ? `go ${[...picked].sort((a, b) => a - b).join(",")}` : "go";
}

// --- touch -------------------------------------------------------------------------

/** A swipe far or fast enough commits: right marks read, left keeps it unread. */
export function swipeOutcome(dx: number, width: number, velocity: number): "done" | "kept" | null {
  const far = Math.abs(dx) > Math.max(48, width * 0.35);
  const fast = Math.abs(velocity) > 0.5 && Math.abs(dx) > 24 && Math.sign(velocity) === Math.sign(dx);
  if (!far && !fast) return null;
  return dx > 0 ? "done" : "kept";
}
