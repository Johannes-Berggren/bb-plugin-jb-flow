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
    String.raw`\b(decide|choose|approve)\b|\bpick (one|an option|between|which|a|the)\b(?! up)`,
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

const AWAITING_VERSION = 8;

/** True when the tail of the message hands the next step to the user. */
export function asksUser(text: string): boolean {
  // Conditional fallbacks ("If it still breaks, tell me what you did") aren't
  // asks; conditions addressed to you ("If you want, I can…") still are.
  const tail = text
    .trim()
    .slice(-900)
    .replace(/(^|[.!?\n]\s*)if (?!you\b)(?:[^.!?\n]|[.!?](?=\S))*[.!?]?/gi, "$1");
  // Trailing numbered options are a choice for you, whatever the wording.
  return ASKS.test(tail) || parseDecisionOptions(text).length > 0;
}

// The agent said it would come back on its own ("I'll report when it finishes",
// "I'm checking every 30 seconds"). If the thread then stays idle, nothing is
// actually running and the promise is stalled: you have to nudge it.
const PROMISES = new RegExp(
  [
    String.raw`\bi('ll| will) (report|tell you|let you know|update you|check back|ping you|confirm|post)\b[^.\n]{0,60}\b(when|once|after|as soon as)\b`,
    String.raw`\bi('ll| will) (report|let you know|tell you) (back|the result)`,
    String.raw`\bi'm (checking|watching|polling|monitoring|waiting for)\b`,
    String.raw`\bi'm (still )?waiting on (that|the|it)\b`,
    String.raw`\b(is|are) (running|still running) in the background\b`,
    String.raw`\bwill report when\b`,
  ].join("|"),
  "i",
);

/** True when the message ends with the agent promising to follow up by itself. */
export function promisesFollowUp(text: string): boolean {
  return PROMISES.test(text.trim().slice(-600)) && !asksUser(text);
}

// The next move is someone else's: a reviewer, a customer, a colleague. Names
// are capitalised words; "you" is excluded (that's an ask, handled above).
const PERSON = String.raw`(?:he|she|they|(?!You\b)\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+)?)`;
const WAITS = new RegExp(
  [
    String.raw`\b([Ww]aiting|[Ww]ait) (for|on) (?![Yy]ou\b|CI\b|ci\b|(the|that) CI\b|[Cc]hecks?\b|(the|that|it|a) (CI|build|deploy|release|certificate|run|job|result)\b|release\b|deploy\b)\w`,
    String.raw`\b([Oo]nce|[Ww]hen|[Uu]ntil|[Aa]fter) ${PERSON} (replies|responds|answers|confirms|approves|reviews|sends|signs|gets back|has (replied|answered|confirmed|reviewed))`,
    String.raw`\b(depends on|is up to|pending on|[Bb]locked on) ${PERSON}\b`,
    String.raw`\b(only )?pending reviewers?\b|\bawaiting (review|a reply|reply|response|approval|their|his|her)\b`,
    String.raw`\b(no|nothing|not) (reply|answer|response) (yet )?from\b`,
    String.raw`\b${PERSON} (can|needs to|has to|should|will) (now )?(push|send|review|approve|sign|reply|confirm|answer|check|merge|decide)\b`,
    String.raw`\b([Aa]sked|[Ee]mailed|[Pp]inged|[Mm]essaged|[Nn]udged) ${PERSON}\b[^.\n]{0,60}\b(waiting|reply|answer|back)\b`,
  ].join("|"),
  "u",
);

// "Tell me when he replies", "Reply go with his answer": your only part is to
// pass someone else's answer on, so the thread is really waiting on them.
const RELAY = new RegExp(
  [
    String.raw`\b(tell me|let me know|paste (it|his|her|their)?|reply|say)\b[^.\n]{0,50}\b(when|once|after) ${PERSON} (replies|answers|responds|confirms|gets back|has replied)`,
    String.raw`\b([Oo]nce|[Ww]hen|[Aa]fter) ${PERSON} (replies|answers|responds|confirms|gets back)[^.\n]{0,40}\b(tell me|let me know|say|reply|paste)\b`,
    String.raw`\b(with|paste) (his|her|their) (answer|reply|response)\b`,
  ].join("|"),
  "u",
);

export function relaysOthers(text: string): boolean {
  return RELAY.test(text.trim().slice(-600));
}

/** True when the message hands the next step to someone other than you. */
export function waitsOnOthers(text: string): boolean {
  if (relaysOthers(text)) return true;
  return WAITS.test(text.trim().slice(-700)) && !asksUser(text);
}

/** A promise counts as stalled after the thread has been idle this long. */
export const STALLED_AFTER_MS = 60 * 60_000;

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

  const getPromised = async () => (await kv.get<Record<string, number>>("promised")) ?? {};
  const setPromised = async (threadId: string, value: boolean) => {
    const all = await getPromised();
    if (value === (threadId in all)) return;
    if (value) all[threadId] = Date.now();
    else delete all[threadId];
    await kv.set("promised", all);
    changed();
  };
  const getWaiting = async () => (await kv.get<Record<string, number>>("waitingOthers")) ?? {};
  const setWaiting = async (threadId: string, value: boolean) => {
    const all = await getWaiting();
    if (value === (threadId in all)) return;
    if (value) all[threadId] = Date.now();
    else delete all[threadId];
    await kv.set("waitingOthers", all);
    changed();
  };
  const classify = async (threadId: string, text: string) => {
    await set(threadId, asksUser(text) && !relaysOthers(text));
    await setPromised(threadId, promisesFollowUp(text));
    await setWaiting(threadId, waitsOnOthers(text));
  };

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const text = lastAssistantText ?? "";
    await classify(thread.id, text);
    // A thread you filed under "Waiting for others" goes back to Active once a
    // turn ends without waiting on anyone (it asks you, or it's done).
    if (waitsOnOthers(text)) return;
    const current = await bb.sdk.threads.get({ threadId: thread.id }).catch(() => null);
    if (current?.sectionId == null) return;
    const sections = await bb.sdk.threadSections.list().catch(() => []);
    const waiting = sections.find((section) => /waiting/i.test(section.name));
    if (waiting && current.sectionId === waiting.id) await bb.sdk.threads.update({ threadId: thread.id, sectionId: null });
  });
  const clear = async ({ thread }: { thread: { id: string } }) => {
    await set(thread.id, false);
    await setPromised(thread.id, false);
    await setWaiting(thread.id, false);
  };
  bb.events.on("thread.active", clear);
  bb.events.on("thread.archived", clear);

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
          if (output?.output) await classify(thread.id, output.output);
        }
        if (!signal.aborted) await kv.set("awaitingVersion", AWAITING_VERSION);
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  return { all: get, promised: getPromised, waitingOthers: getWaiting };
}
