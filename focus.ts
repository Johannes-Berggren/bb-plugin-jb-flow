// Tracks which thread the user is looking at, so external controllers (a
// Stream Deck, scripts) can act on "the focused thread" through the CLI
// instead of synthesizing keystrokes. Every BB window reports its focused pane
// over RPC; the most recent report from a window that has OS focus wins.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const focusReportSchema = z.object({
  clientId: z.string().min(1).max(64),
  threadId: z.string().nullable(),
  windowFocused: z.boolean(),
});
type FocusReport = z.infer<typeof focusReportSchema> & { at: number };

/** Reports older than this are ignored (a closed window stops reporting). */
const STALE_MS = 15 * 60_000;

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

export function needsAttention(thread: Thread): boolean {
  return (
    thread.status === "error" ||
    thread.hasPendingInteraction ||
    (thread.status === "idle" &&
      thread.latestAttentionAt !== null &&
      (thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt))
  );
}

export function createFocus(bb: BbPluginApi) {
  const reports = new Map<string, FocusReport>();

  function report(input: z.infer<typeof focusReportSchema>) {
    reports.set(input.clientId, { ...input, at: Date.now() });
  }

  function focusedThreadId(): string | null {
    const fresh = [...reports.values()].filter((entry) => Date.now() - entry.at < STALE_MS);
    const pick = (entries: FocusReport[]) =>
      entries.sort((a, b) => b.at - a.at).find((entry) => entry.threadId !== null)?.threadId ?? null;
    return pick(fresh.filter((entry) => entry.windowFocused)) ?? pick(fresh);
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
    const threads: Thread[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await bb.sdk.threads.list({ limit: 500, offset });
      threads.push(...page);
      if (page.length < 500) break;
    }
    return threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.visibility === "visible" &&
          thread.parentThreadId === null &&
          needsAttention(thread),
      )
      .sort((a, b) => (a.latestAttentionAt ?? 0) - (b.latestAttentionAt ?? 0));
  }

  return { report, focusedThreadId, requireFocused, needsMe };
}
