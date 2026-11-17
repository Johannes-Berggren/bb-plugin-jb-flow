// What `bb jb-flow deck` shows an external controller (a Stream Deck): the
// focused thread and its open decision, Needs me, Your move, the PR radar and
// the top of Now, in one call.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { createAwaiting } from "./awaiting";
import { parseDecisionOptions } from "./decisions";
import { needsAttention, type createFocus } from "./focus";
import type { createNowQueue } from "./now-queue";
import type { createPrCi } from "./pr-ci";
import type { ListedThread } from "./thread-cache";

type DeckDeps = {
  settings: { get(): Promise<{ nowQueue: boolean }> };
  listThreadsCached: () => Promise<ListedThread[]>;
  awaiting: ReturnType<typeof createAwaiting>;
  prRadar: ReturnType<typeof createPrCi>["prRadar"];
  focus: ReturnType<typeof createFocus>;
  findSnoozedSection: () => Promise<string | null>;
  currentNow: ReturnType<typeof createNowQueue>["currentNow"];
};

export function createDeck(bb: BbPluginApi, { settings, listThreadsCached, awaiting, prRadar, focus, findSnoozedSection, currentNow }: DeckDeps) {
  // --- cheap snapshots for external controllers (Stream Deck) ------------------
  // The deck polls every few seconds while agents keep bb busy, so these read
  // cached data: one thread list per 10s, no message bodies except the focused
  // thread's (re-read only when it changes).

  // Re-parse the focused thread's options only when it changes.
  let decisionCache: { key: string; options: ReturnType<typeof parseDecisionOptions> } | null = null;
  async function decisionsFor(threadId: string | null) {
    const thread = threadId === null ? null : await bb.sdk.threads.get({ threadId }).catch(() => null);
    // Same rule as the composer buttons: only an idle thread is waiting on an answer.
    let options: ReturnType<typeof parseDecisionOptions> = [];
    if (thread !== null && thread.status === "idle") {
      const cacheKey = `${thread.id}:${thread.updatedAt}`;
      if (decisionCache?.key !== cacheKey) {
        const output = await bb.sdk.threads.output({ threadId: thread.id }).catch(() => ({ output: null }));
        decisionCache = { key: cacheKey, options: parseDecisionOptions(output.output ?? "") };
      }
      options = decisionCache.options;
    }
    return { threadId: thread?.id ?? null, title: thread?.title ?? null, status: thread?.status ?? null, options };
  }

  /** Everything the deck shows, in one call. */
  async function deckSnapshot() {
    const [threads, waiting, radar, focused, snoozedSection] = await Promise.all([
      listThreadsCached(),
      awaiting.all(),
      prRadar(),
      decisionsFor(focus.focusedThreadId()),
      findSnoozedSection(),
    ]);
    // Snoozed threads stay hidden until they wake, as in the sidebar and `needs-me`.
    const open = threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        thread.visibility === "visible" &&
        thread.parentThreadId === null &&
        (snoozedSection === null || thread.sectionId !== snoozedSection),
    );
    const needs = open.filter((thread) => needsAttention(thread, waiting));
    const needIds = new Set(needs.map((thread) => thread.id));
    const moves = open
      .filter((thread) => thread.status === "idle" && waiting[thread.id] !== undefined && !needIds.has(thread.id))
      .map((thread) => Math.min(waiting[thread.id]!, thread.updatedAt));
    const nowEnabled = (await settings.get()).nowQueue;
    const queue = nowEnabled ? await currentNow(threads) : { now: [] };
    return {
      focused,
      needsMe: { count: needs.length },
      yourMove: { count: moves.length, oldestSince: moves.length ? Math.min(...moves) : null },
      prRadar: { broken: radar.broken.length, ready: radar.ready.length },
      ...(nowEnabled ? { now: { count: queue.now.length, top: queue.now[0] ?? null } } : {}),
    };
  }

  return { decisionsFor, deckSnapshot };
}
