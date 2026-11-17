// Snoozing a thread: it moves to the Snoozed section until it's due, then
// comes back to the section it came from, unread, with its note sent as a
// prompt. Records live in bb.storage.kv ("snoozes"); snooze-wake.ts decides
// what one wake pass does.
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { createAwaiting } from "./awaiting";
import { isGoneError } from "./ci-watch";
import { laneSections } from "./lanes";
import type { rpcContract, Snooze } from "./rpc-contract";
import { wakeDueSnoozes } from "./snooze-wake";
import { listLiveThreads } from "./thread-list";
import { formatWhen, parseWhen } from "./when";

const SNOOZED_SECTION_NAME = "😴 Snoozed";

type SnoozeDeps = { changed: () => void; awaiting: ReturnType<typeof createAwaiting> };

export function createSnoozes(bb: BbPluginApi, { changed, awaiting }: SnoozeDeps) {
  async function getSnoozes(): Promise<Record<string, Snooze>> {
    return (await bb.storage.kv.get<Record<string, Snooze>>("snoozes")) ?? {};
  }

  // The Snoozed section is created by the first snooze, not on install, so
  // people who never snooze don't get an empty section. Looked up by name and
  // cached briefly; the user may delete or recreate it at any time.
  let snoozedSectionId: string | null = null;
  let snoozedCheckedAt = 0;
  async function findSnoozedSection(): Promise<string | null> {
    if (Date.now() - snoozedCheckedAt < 10_000) return snoozedSectionId;
    const sections = await bb.sdk.threadSections.list();
    snoozedSectionId = sections.find((section) => section.name === SNOOZED_SECTION_NAME)?.id ?? null;
    snoozedCheckedAt = Date.now();
    return snoozedSectionId;
  }
  async function ensureSnoozedSection(): Promise<string> {
    snoozedCheckedAt = 0;
    const existing = await findSnoozedSection();
    if (existing !== null) return existing;
    snoozedSectionId = (await bb.sdk.threadSections.create({ name: SNOOZED_SECTION_NAME })).id;
    snoozedCheckedAt = Date.now();
    return snoozedSectionId;
  }

  // --- snooze ---------------------------------------------------------------

  // Every snoozes write goes through here: bulk snoozes and the every-minute
  // wake check run concurrently, and a stale read-then-write loses records.
  let snoozeLock: Promise<unknown> = Promise.resolve();
  function updateSnoozes(apply: (snoozes: Record<string, Snooze>) => void): Promise<void> {
    const run = snoozeLock.then(async () => {
      const snoozes = await getSnoozes();
      apply(snoozes);
      await bb.storage.kv.set("snoozes", snoozes);
    });
    snoozeLock = run.catch(() => undefined);
    return run;
  }

  async function snooze(threadId: string, when: string, note: string | null, until?: number): Promise<Snooze> {
    if (until !== undefined && until <= Date.now()) throw new Error(`"${when}" is in the past.`);
    const record = await snoozeUntil(threadId, until ?? parseWhen(when), note);
    return record;
  }

  async function snoozeUntil(
    threadId: string,
    until: number,
    note: string | null,
  ): Promise<Snooze> {
    const sectionId = await ensureSnoozedSection();
    const thread = await bb.sdk.threads.get({ threadId });
    const snoozes = await getSnoozes();
    const previous = snoozes[threadId];
    const record: Snooze = {
      until,
      note: note?.trim() || null,
      // Re-snoozing keeps the section the thread originally came from.
      fromSectionId:
        previous?.fromSectionId ?? (thread.sectionId === sectionId ? null : thread.sectionId),
      snoozedAt: Date.now(),
    };
    await bb.sdk.threads.update({ threadId, sectionId });
    await updateSnoozes((all) => {
      all[threadId] = record;
    });
    changed();
    return record;
  }

  /** What a wake needs to know about sections and hand-backs; read once per pass. */
  type WakeContext = { sectionIds: Set<string>; waitingSectionId: string | null; waitingOthers: Record<string, number> };
  async function wakeContext(reason: "due" | "manual"): Promise<WakeContext> {
    const [sections, lanes, waitingOthers] = await Promise.all([
      bb.sdk.threadSections.list(),
      reason === "due" ? laneSections(bb) : Promise.resolve({ waiting: undefined }),
      reason === "due" ? awaiting.waitingOthers() : Promise.resolve({}),
    ]);
    return { sectionIds: new Set(sections.map((section) => section.id)), waitingSectionId: lanes.waiting ?? null, waitingOthers };
  }

  async function wake(threadId: string, record: Snooze, reason: "due" | "manual", context?: WakeContext): Promise<void> {
    const { sectionIds, waitingSectionId, waitingOthers } = context ?? (await wakeContext(reason));
    let restoreTo = record.fromSectionId !== null && sectionIds.has(record.fromSectionId) ? record.fromSectionId : null;
    // Snoozed while waiting on someone ("when it wakes, I'll check for Sam's
    // reply"): wake into Waiting for others instead of the old section. The
    // flag is set when the thread went idle, from its last reply.
    // Only for a snooze that ran out; cancelling one puts the thread back where it was.
    if (reason === "due" && waitingSectionId !== null && threadId in waitingOthers) restoreTo = waitingSectionId;
    await bb.sdk.threads.update({ threadId, sectionId: restoreTo });
    if (reason === "due") await bb.sdk.threads.markUnread({ threadId });
  }

  async function unsnooze(threadId: string): Promise<boolean> {
    const snoozes = await getSnoozes();
    const record = snoozes[threadId];
    if (record === undefined) return false;
    await wake(threadId, record, "manual");
    await updateSnoozes((all) => {
      delete all[threadId];
    });
    changed();
    return true;
  }


  // Single flight: the check runs every minute, and a slow one (bb busy) must
  // not overlap the next and send a snooze note twice.
  let wakeRun: Promise<number> | null = null;
  const wakeDue = () => (wakeRun ??= wakeDueNow().finally(() => (wakeRun = null)));

  async function wakeDueNow(): Promise<number> {
    const snoozes = await getSnoozes();
    if (Object.keys(snoozes).length === 0) return 0;
    // No section (never created, or deleted): nothing can be in it.
    const snoozedSectionId = await findSnoozedSection();
    // One list of what's in Snoozed instead of a lookup per snoozed thread each
    // minute; only threads that left it are looked up one by one.
    const inSnoozed = new Map(
      snoozedSectionId === null
        ? []
        : (await listLiveThreads(bb, { sectionId: snoozedSectionId }).catch(() => [])).map((thread) => [thread.id, thread]),
    );
    let context: Promise<WakeContext> | null = null;
    const { done, noteFailures, woken } = await wakeDueSnoozes(snoozes, {
      now: () => Date.now(),
      snoozedSectionId,
      getThread: async (threadId) => inSnoozed.get(threadId) ?? bb.sdk.threads.get({ threadId }),
      isGoneError,
      markStarted: (threadId, record) =>
        updateSnoozes((all) => {
          if (all[threadId]?.snoozedAt === record.snoozedAt) all[threadId] = { ...all[threadId]!, wakeStarted: true };
        }),
      restore: async (threadId, record) => {
        // A failed read isn't kept: the next thread in this pass tries again.
        context ??= wakeContext("due").catch((error: unknown) => {
          context = null;
          throw error;
        });
        await wake(threadId, record, "due", await context);
      },
      sendNote: async (threadId, note) => {
        await bb.sdk.threads.send({
          threadId,
          mode: "queue-if-active",
          input: [{ type: "text", text: `⏰ Snooze reminder: ${note}`, mentions: [] }],
        });
      },
      warn: (message) => bb.log.warn(message),
    });
    // Against a fresh read, keyed by the record we saw, so a snooze set meanwhile
    // (or a re-snooze) survives.
    if (done.size > 0 || noteFailures.size > 0) {
      await updateSnoozes((all) => {
        for (const [threadId, snoozedAt] of done) if (all[threadId]?.snoozedAt === snoozedAt) delete all[threadId];
        for (const [threadId, { snoozedAt, failures }] of noteFailures) {
          if (all[threadId]?.snoozedAt === snoozedAt) all[threadId] = { ...all[threadId]!, noteFailures: failures };
        }
      });
      changed();
    }
    return woken;
  }

  const rpc: Pick<PluginRpcHandlers<typeof rpcContract>, "snooze" | "unsnooze"> = {
    snooze: ({ threadId, when, note, until }) => snooze(threadId, when, note, until),
    unsnooze: async ({ threadId }) => ({ removed: await unsnooze(threadId) }),
  };

  return { getSnoozes, findSnoozedSection, snooze, unsnooze, wakeDue, rpc };
}

/** The snooze_thread agent tool. */
export function registerSnoozeTool(bb: BbPluginApi, snooze: (threadId: string, when: string, note: string | null) => Promise<Snooze>) {
  bb.agents.registerTool({
    name: "snooze_thread",
    description:
      'Snooze the current BB thread until a later time. The thread leaves the user\'s active list and comes back unread when due. If a note is given it is sent to this thread as a prompt at wake time, so write it as an instruction to your future self (e.g. "Check whether Martin replied in #billing and summarize").',
    instructions:
      "When work in this thread is blocked on someone else or on a future date, offer to call snooze_thread (when: 2h, 3d, 1w, tomorrow, mon, next-week, or YYYY-MM-DD) with a note describing what to check on wake-up.",
    parameters: z.object({
      when: z
        .string()
        .describe("When to wake: 2h, 3d, 1w, tomorrow, mon…sun, next-week, or YYYY-MM-DD"),
      note: z.string().optional().describe("Instruction sent to this thread when it wakes"),
    }),
    async execute({ when, note }, ctx) {
      try {
        const record = await snooze(ctx.threadId, when, note ?? null);
        return `Snoozed until ${formatWhen(record.until)}${record.note ? ` with reminder: ${record.note}` : ""}.`;
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  });
}
