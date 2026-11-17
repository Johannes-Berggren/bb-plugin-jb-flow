// Now, next and Your move on the server: the ranked Now queue (as the
// sidebar shows it, across every workspace), where "next" goes, the threads
// waiting on a decision from you, Focus and deadlines, which agents set with
// set_thread_due or a status report's **Due:** line.
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { createAwaiting } from "./awaiting";
import type { createFocus } from "./focus";
import { replyQueued } from "./needs-me";
import { nextNeedsMe } from "./next-needs-me";
import { nextAfter, nowQueue, reasonLabel, serverNowThread } from "./now-model";
import type { createNowStore } from "./now-store";
import type { createPrTracker } from "./prs";
import type { FlowState, rpcContract } from "./rpc-contract";
import type { ListedThread, Thread } from "./thread-cache";
import { listLiveThreads } from "./thread-list";
import { parseStatusReport } from "./thread-status";
import { formatDue, formatWhen, parseDue, parseDueLine } from "./when";

type NowStore = ReturnType<typeof createNowStore>;

/** A status report's "**Due:**" line sets the thread's deadline. */
export function registerDueFromStatus(bb: BbPluginApi, { settings, nowStore }: { settings: { get(): Promise<{ nowQueue: boolean }> }; nowStore: NowStore }) {
  // A status report's "**Due:**" line sets the deadline. Leaving it out later keeps the date.
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (!lastAssistantText || !(await settings.get()).nowQueue) return;
    const line = parseStatusReport(lastAssistantText, 0)?.due;
    const parsed = line ? parseDueLine(line) : null;
    if (parsed) await nowStore.setDue(thread.id, parsed.at, parsed.reason, "agent");
  });
}

type NowQueueDeps = {
  settings: { get(): Promise<{ nowQueue: boolean }> };
  awaiting: ReturnType<typeof createAwaiting>;
  prTracker: ReturnType<typeof createPrTracker>;
  nowStore: NowStore;
  focus: ReturnType<typeof createFocus>;
  findSnoozedSection: () => Promise<string | null>;
  watchingByThread: () => Promise<FlowState["watching"]>;
  listAllActiveThreads: () => Promise<Thread[]>;
};

export function createNowQueue(
  bb: BbPluginApi,
  { settings, awaiting, prTracker, nowStore, focus, findSnoozedSection, watchingByThread, listAllActiveThreads }: NowQueueDeps,
) {
  /** The sidebar's Now, across every workspace. Tabs belong to each browser window, not the server. */
  async function currentNow(threads: readonly ListedThread[]) {
    const [waiting, promised, waitingOthers, readyToGo, watching, threadPrs, focused, due, snoozedSection] = await Promise.all([
      awaiting.all(),
      awaiting.promised(),
      awaiting.waitingOthers(),
      awaiting.readyToGo(),
      watchingByThread(),
      prTracker.byThread(),
      nowStore.all(),
      nowStore.dueAll(),
      findSnoozedSection(),
    ]);
    const flow = { awaiting: waiting, promised, waitingOthers, readyToGo, watching, threadPrs, focused, due };
    const now = Date.now();
    const rows = threads
      .filter((thread) => thread.archivedAt === null && thread.deletedAt === null && thread.visibility === "visible" && thread.parentThreadId === null && thread.pinnedAt === null)
      .map((thread) => serverNowThread(thread, snoozedSection !== null && thread.sectionId === snoozedSection));
    const queue = nowQueue(rows, flow, { now });
    const titles = new Map(threads.map((thread) => [thread.id, thread.title ?? thread.titleFallback ?? ""]));
    const describe = (entry: (typeof queue.now)[number]) => ({
      id: entry.thread.id,
      title: titles.get(entry.thread.id) ?? "",
      state: entry.state,
      reason: reasonLabel(entry, flow, now),
      focused: entry.focused,
      dueAt: entry.dueAt,
    });
    return { now: queue.now.map(describe), moving: queue.moving.map(describe) };
  }

  /** The threads "next" walks through, most urgent first: Now, or Needs me with Now off. */
  async function queueOrder(): Promise<string[]> {
    const needs = await focus.needsMe();
    if (!(await settings.get()).nowQueue) return needs.map((thread) => thread.id);
    const { now } = await currentNow(await listLiveThreads(bb));
    // Pinned threads aren't in Now, but one that's blocked still needs you.
    return [...new Set([...now.map((entry) => entry.id), ...needs.map((thread) => thread.id)])];
  }

  /** Where "next" goes. With Now off, the first thread that needs you, as before. */
  async function nextThread(current: string | null, skip: string | null): Promise<string | null> {
    const order = await queueOrder();
    if (!(await settings.get()).nowQueue) return order.find((id) => id !== skip) ?? null;
    return nextAfter(order, current);
  }

  async function yourMove({ withAsk = true }: { withAsk?: boolean } = {}) {
    const waiting = await awaiting.all();
    const snoozedSection = await findSnoozedSection();
    // One list instead of a get per entry; outputs fetched in parallel below.
    const byId = new Map((await listAllActiveThreads()).map((thread) => [thread.id, thread]));
    const candidates = Object.entries(waiting).flatMap(([threadId, since]) => {
      const thread = byId.get(threadId);
      if (!thread || thread.status !== "idle" || replyQueued(thread) || (snoozedSection !== null && thread.sectionId === snoozedSection)) return [];
      return [{ thread, since }];
    });
    const asks = new Map<string, string>();
    if (withAsk) {
      for (let index = 0; index < candidates.length; index += 8) {
        await Promise.all(
          candidates.slice(index, index + 8).map(async ({ thread }) => {
            const output = await bb.sdk.threads.output({ threadId: thread.id }).catch(() => ({ output: null }));
            // The ask is at the end of the message: show its last meaningful lines.
            const ask = (output.output ?? "")
              .split("\n")
              .map((line) => line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`>#]+/g, "").trim())
              .filter((line) => line.length > 0 && !/^\d{1,2}[./]\d{1,2}[./]\d{2,4}|^\d{4}-\d{2}-\d{2}|^stamped/i.test(line))
              .slice(-3)
              .join(" ")
              .slice(0, 240);
            asks.set(thread.id, ask);
          }),
        );
      }
    }
    const items = candidates.map(({ thread, since }) => ({
      threadId: thread.id,
      title: thread.title ?? thread.titleFallback ?? "Untitled",
      projectId: thread.projectId,
      // Date the ask by the thread's last activity: backfilled entries carry the
      // classification time, not when the agent actually asked.
      since: Math.min(since, thread.updatedAt),
      ask: asks.get(thread.id) ?? "",
    }));
    items.sort((a, b) => a.since - b.since);
    return { items };
  }

  const rpc: Pick<PluginRpcHandlers<typeof rpcContract>, "focus_set" | "due_set" | "next_needs_me" | "needs_me_queue" | "your_move"> = {
    focus_set: async ({ threadId, focused }) => ({ focused: await nowStore.set(threadId, focused) }),
    due_set: async ({ threadId, at, reason }) => ({ ok: (await nowStore.setDue(threadId, at, reason, "you")).applied }),
    next_needs_me: ({ archiveThreadId }) =>
      nextNeedsMe(archiveThreadId, {
        nextThread,
        focusedThreadId: () => focus.focusedThreadId(),
        getThread: (threadId) => bb.sdk.threads.get({ threadId }),
        archive: (threadId) => bb.sdk.threads.archive({ threadId }),
        open: (threadId) => bb.sdk.threads.open({ threadId, file: null }),
      }),
    needs_me_queue: async () => ({ threadIds: (await queueOrder()).slice(0, 40) }),
    your_move: () => yourMove(),
  };

  return { currentNow, nextThread, yourMove, rpc };
}

/** The set_thread_due agent tool. */
export function registerDueTool(bb: BbPluginApi, nowStore: NowStore) {
  bb.agents.registerTool({
    name: "set_thread_due",
    description:
      "Record a real deadline for the current BB thread, or clear one that no longer applies. The thread then rises in the user's sidebar as the date gets close. A date the user set themselves can't be changed from here.",
    instructions:
      "When this work has a real outside deadline (an invoice due date, a contract date, a customer meeting, a date someone else set), call set_thread_due with the date and what falls due. Never invent a date, and don't use it for your own goals or estimates. Call it with when: none once the deadline no longer applies.",
    parameters: z.object({
      when: z.string().describe("YYYY-MM-DD (the end of that day) or YYYY-MM-DDTHH:MM, or none to clear"),
      reason: z.string().max(300).optional().describe("What falls due, in a few words. Required when setting a date."),
    }),
    async execute({ when, reason }, ctx) {
      try {
        if (when.trim().toLowerCase() === "none") {
          const { applied } = await nowStore.setDue(ctx.threadId, null, null, "agent");
          return applied ? "Deadline cleared." : "The user set this deadline, so it wasn't changed. Tell them if it no longer applies.";
        }
        if (!reason?.trim()) throw new Error("Say what falls due in reason.");
        const at = parseDue(when);
        const { applied, due } = await nowStore.setDue(ctx.threadId, at, reason.trim(), "agent");
        if (applied) return `Deadline set: ${formatDue(at)} (${formatWhen(at)}).`;
        return due
          ? `The user set this deadline to ${formatWhen(due.at)}, so it wasn't changed. Tell them if you think it's wrong.`
          : "The user already cleared this date, so it wasn't set again. Tell them if you think it does apply.";
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  });
}
