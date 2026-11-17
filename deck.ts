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
import { WORKSPACE_COLOR_HEX, workspaceForThread, type WorkspaceState } from "./workspaces";

type DeckDeps = {
  settings: { get(): Promise<{ nowQueue: boolean }> };
  listThreadsCached: () => Promise<ListedThread[]>;
  awaiting: ReturnType<typeof createAwaiting>;
  prRadar: ReturnType<typeof createPrCi>["prRadar"];
  focus: ReturnType<typeof createFocus>;
  findSnoozedSection: () => Promise<string | null>;
  currentNow: ReturnType<typeof createNowQueue>["currentNow"];
  workspaces: { read(): Promise<WorkspaceState> };
};

export function createDeck(bb: BbPluginApi, { settings, listThreadsCached, awaiting, prRadar, focus, findSnoozedSection, currentNow, workspaces }: DeckDeps) {
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

  // Workspaces change rarely and reading them walks every thread assignment: once per 10s, like the thread list.
  let workspaceCache: { at: number; state: Promise<WorkspaceState> } | null = null;
  function workspacesCached(): Promise<WorkspaceState> {
    if (workspaceCache === null || Date.now() - workspaceCache.at > 10_000) {
      const state = workspaces.read();
      workspaceCache = { at: Date.now(), state };
      // A failed read must not be served for the next 10s.
      state.catch(() => {
        if (workspaceCache?.state === state) workspaceCache = null;
      });
    }
    return workspaceCache.state;
  }

  /** The focused thread's workspace, with its color by name and as sRGB so a deck key can wear it. */
  function workspaceOf(threadId: string | null, threads: readonly ListedThread[], state: WorkspaceState) {
    const thread = threadId === null ? undefined : threads.find((candidate) => candidate.id === threadId);
    const id = thread ? workspaceForThread(thread, state, threads) : null;
    const workspace = state.workspaces.find((candidate) => candidate.id === id);
    if (!workspace) return null;
    return { id: workspace.id, name: workspace.name, color: workspace.color ?? null, hex: workspace.color ? WORKSPACE_COLOR_HEX[workspace.color] : null };
  }

  /** Everything the deck shows, in one call. */
  async function deckSnapshot() {
    const [threads, waiting, radar, focusedThread, snoozedSection, workspaceState] = await Promise.all([
      listThreadsCached(),
      awaiting.all(),
      prRadar(),
      decisionsFor(focus.focusedThreadId()),
      findSnoozedSection(),
      workspacesCached().catch((): WorkspaceState => ({ workspaces: [], threadWorkspaces: {} })),
    ]);
    const focused = { ...focusedThread, workspace: workspaceOf(focusedThread.threadId, threads, workspaceState) };
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
