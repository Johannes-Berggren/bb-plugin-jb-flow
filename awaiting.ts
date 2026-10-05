// Classifies an idle thread's final agent message: did it end by handing the
// next move to the user (a question, options to pick, a decision board, "reply
// go"), or is the work wrapped up? Read-but-unanswered asks otherwise look
// like finished threads ("Done") even though the agent is waiting on you.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseDecisionOptions } from "./decisions.ts";

// Phrases that hand the next step to the user. Kept specific: status reports
// mention "decision" or "blocked" without waiting on anyone.
const ASKS = new RegExp(
  [
    String.raw`\?\s*$`,
    String.raw`\b(reply|answer)\s+["“*]{0,2}(go|yes)\b`,
    String.raw`\bsay\s+["“*]{1,2}(go|yes)\b`, // quoted: "if they say yes" is about someone else
    String.raw`\b(want me to|should i|shall i|would you like|do you want|if you('d)? (want|like|prefer))\b`,
    String.raw`\bif you (place|send|run|give|share|paste|confirm|approve|sign)\b`,
    String.raw`\b(can|could|would) you\b`,
    String.raw`\b(let me know|tell me|please)\b`,
    String.raw`\byour (call|decision|input|answer|go-ahead)\b`,
    String.raw`\bdecisions? (needed|for you|board)\b`,
    String.raw`\b(decide|choose|pick|approve)\b`,
    String.raw`\bpaste (it|the text|them|his|her|their)\b`,
    String.raw`\b(waiting|blocked) (for|on|until) you\b`,
    String.raw`\bonce you('ve| have)?\b`,
    String.raw`\byou('ll)? need to\b`,
    String.raw`\bneeds? (you|your)\b`,
    String.raw`\b(you send it|unsent|in your drafts)\b`,
    String.raw`\bnext step:?\**\s*(send|sign|install|reply|review|approve|run)\b`,
  ].join("|"),
  "i",
);

const AWAITING_VERSION = 2;

/** True when the tail of the message hands the next step to the user. */
export function asksUser(text: string): boolean {
  const tail = text.trim().slice(-900);
  // Trailing numbered options are a choice for you, whatever the wording.
  return ASKS.test(tail) || parseDecisionOptions(text).length > 0;
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
      // Bump when the rules change, so open threads are re-classified once.
      if ((await kv.get<number>("awaitingVersion")) !== AWAITING_VERSION) {
        const threads = await bb.sdk.threads.list({ limit: 500 });
        for (const thread of threads) {
          if (signal.aborted) return;
          if (thread.archivedAt !== null || thread.status !== "idle" || thread.parentThreadId !== null) continue;
          const output = await bb.sdk.threads.output({ threadId: thread.id, signal }).catch(() => null);
          if (output?.output) await set(thread.id, asksUser(output.output));
        }
        if (!signal.aborted) await kv.set("awaitingVersion", AWAITING_VERSION);
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  return { all: get };
}
