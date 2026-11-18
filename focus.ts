// Tracks which thread the user is looking at, so external controllers (a
// Stream Deck, scripts) can act on "the focused thread" through the CLI
// instead of synthesizing keystrokes. Every BB window reports its focused pane
// over RPC. The window you last physically used (click, key, pointer) wins: with
// BB open on two Macs, both windows can have OS focus on their own machine.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { listLiveThreads } from "./thread-list";
import { replyQueued } from "./needs-me";
import { forest } from "./subthreads";

export const focusReportSchema = z.object({
  clientId: z.string().min(1).max(64),
  threadId: z.string().nullable(),
  windowFocused: z.boolean(),
  /** Last click, key press or pointer movement in that window (ms). */
  interactedAt: z.number().optional(),
  /** Where the window runs, for `bb jb-flow focus-clients`. */
  origin: z.string().max(200).optional(),
  /** The focused pane's place in a split, left to right (1-based), and how many panes are open. */
  panes: z.object({ index: z.number().int().min(1).max(32), total: z.number().int().min(2).max(32) }).optional(),
  userAgent: z.string().max(300).optional(),
});
type FocusReport = z.infer<typeof focusReportSchema> & { at: number };

/** Reports older than this are ignored (a closed window stops reporting). */
const STALE_MS = 15 * 60_000;

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

/**
 * Failed, blocked on a prompt, or finished unread with a last message that asks
 * you something (`awaiting`). Unread status updates don't count.
 */
export function needsAttention(thread: Thread, awaiting: Record<string, number>): boolean {
  return (
    thread.status === "error" ||
    thread.hasPendingInteraction ||
    (thread.status === "idle" &&
      awaiting[thread.id] !== undefined &&
      !replyQueued(thread) &&
      thread.latestAttentionAt !== null &&
      (thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt))
  );
}

export function createFocus(
  bb: BbPluginApi,
  getAwaiting: () => Promise<Record<string, number>>,
  getSnoozedSectionId: () => Promise<string | null>,
) {
  const reports = new Map<string, FocusReport>();

  // Last known focus survives plugin reloads and quiet windows, so a deck key
  // pressed while another app is in front still reaches the thread you left.
  let lastFocused: string | null = null;
  void bb.storage.kv.get<string>("lastFocused").then((value) => {
    lastFocused ??= value ?? null;
  });

  function report(input: z.infer<typeof focusReportSchema>) {
    reports.set(input.clientId, { ...input, at: Date.now() });
    const current = focusedThreadId();
    if (current !== null && current !== lastFocused) {
      lastFocused = current;
      void bb.storage.kv.set("lastFocused", current);
    }
  }

  /** The report of the window you last used, if any is fresh. */
  function current(): FocusReport | undefined {
    const fresh = [...reports.values()].filter((entry) => Date.now() - entry.at < STALE_MS && entry.threadId !== null);
    // Most recently used window first. Without recent use, a window on this
    // machine (where the deck is plugged in) beats a remote one, then OS focus.
    const local = (entry: FocusReport) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(entry.origin ?? "");
    fresh.sort(
      (a, b) =>
        (b.interactedAt ?? 0) - (a.interactedAt ?? 0) ||
        Number(local(b)) - Number(local(a)) ||
        Number(b.windowFocused) - Number(a.windowFocused) ||
        b.at - a.at,
    );
    return fresh[0];
  }

  function focusedThreadId(): string | null {
    return current()?.threadId ?? lastFocused;
  }

  /** Where the focused pane sits in that window's split; null without a split. */
  function focusedPanes(): { index: number; total: number } | null {
    return current()?.panes ?? null;
  }

  /** Debug view of the windows reporting focus. */
  function clients() {
    return [...reports.values()].sort((a, b) => (b.interactedAt ?? 0) - (a.interactedAt ?? 0));
  }

  async function requireFocused(): Promise<string> {
    const threadId = focusedThreadId();
    if (threadId === null) {
      throw new Error("No focused thread. Open a thread in BB (the window must have reported focus).");
    }
    return threadId;
  }

  /** Threads that need the user, oldest attention first (inbox order). */
  async function needsMe() {
    const threads = await listLiveThreads(bb);
    const awaiting = await getAwaiting();
    // Snoozed threads stay hidden until they wake, as in the sidebar.
    const snoozedSectionId = await getSnoozedSectionId();
    const live = threads.filter((thread) => thread.archivedAt === null && thread.deletedAt === null && thread.visibility === "visible");
    // Subthreads count too, as in the Triage list's Needs me; each goes with its row's snooze.
    return forest(live)
      .members.filter(({ thread, row }) => (snoozedSectionId === null || row.sectionId !== snoozedSectionId) && needsAttention(thread, awaiting))
      .map(({ thread }) => thread)
      .sort((a, b) => (a.latestAttentionAt ?? 0) - (b.latestAttentionAt ?? 0));
  }

  return { report, focusedThreadId, focusedPanes, requireFocused, needsMe, clients };
}
