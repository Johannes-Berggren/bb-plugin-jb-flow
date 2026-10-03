// Classifies an idle thread's final agent message: did it end by handing the
// next move to the user (a question, options to pick, a decision board, "reply
// go"), or is the work wrapped up? Read-but-unanswered asks otherwise look
// like finished threads ("Done") even though the agent is waiting on you.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const ASKS =
  /\?\s*$|\b(reply|answer|say)\s+\*{0,2}(go|yes)\b|\bwant me to\b|\bshould i\b|\bshall i\b|\bwould you like\b|\bdo you want\b|\b(can|could|would) you\b|\blet me know\b|\byour (call|decision|input)\b|\bdecision(s| board)?\b|\b(decide|choose|pick|approve|confirm)\b|\bpaste (it|the text|them)\b|\bwaiting (for|on) you\b|\bonce you('ve| have)?\b|\byou('ll)? need to\b|\bblocked\b|\bneeds? your\b/i;

/** True when the tail of the message hands the next step to the user. */
export function asksUser(text: string): boolean {
  const tail = text.trim().slice(-900);
  return ASKS.test(tail);
}

export function createAwaiting(bb: BbPluginApi, changed: () => void) {
  const kv = bb.storage.kv;
  const get = async () => (await kv.get<Record<string, number>>("awaiting")) ?? {};
  const set = async (threadId: string, value: boolean) => {
    const all = await get();
    if (value === (threadId in all)) return;
    if (value) all[threadId] = Date.now();
    else delete all[threadId];
    await kv.set("awaiting", all);
    changed();
  };

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => set(thread.id, asksUser(lastAssistantText ?? "")));
  bb.events.on("thread.active", ({ thread }) => set(thread.id, false));
  bb.events.on("thread.archived", ({ thread }) => set(thread.id, false));

  // Classify threads that went idle before the plugin was watching.
  bb.background.service("awaiting-backfill", {
    async start(signal) {
      if ((await kv.get<number>("awaitingVersion")) !== 1) {
        const threads = await bb.sdk.threads.list({ limit: 500 });
        for (const thread of threads) {
          if (signal.aborted) return;
          if (thread.archivedAt !== null || thread.status !== "idle" || thread.parentThreadId !== null) continue;
          const output = await bb.sdk.threads.output({ threadId: thread.id, signal }).catch(() => null);
          if (output?.output) await set(thread.id, asksUser(output.output));
        }
        if (!signal.aborted) await kv.set("awaitingVersion", 1);
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  return { all: get };
}
