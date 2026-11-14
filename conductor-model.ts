// The conductor's decisions and texts, apart from bb so they can be tested:
// when to wake it, what the wake-up says, what it's told to do, and the shape
// of the briefing it leaves for the user. conductor.ts wires it up.
import { z } from "zod";
import type { StoredConductorEvent } from "./conductor-store.ts";

/** Marks a conductor in its thread's plugin metadata. */
export const CONDUCTOR_ROLE = "conductor";

/** A workspace's conductor, as stored in kv `conductors`. */
export const conductorRecordSchema = z.object({
  enabled: z.boolean(),
  /** The conductor's thread, once spawned. */
  threadId: z.string().nullable(),
  /** Project the thread lives in; the workspace's first project when absent. */
  projectId: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  createdAt: z.number().optional(),
  lastWakeAt: z.number().optional(),
  /** Day (YYYY-MM-DD) of the last compacting wake-up. */
  compactedOn: z.string().optional(),
});
export type ConductorRecord = z.infer<typeof conductorRecordSchema>;

export const BRIEFING_KINDS = ["decision", "ready", "blocked", "fyi"] as const;
export const briefingItemSchema = z.object({
  threadId: z.string().min(1).max(200),
  kind: z.enum(BRIEFING_KINDS),
  /** What you need from the user, in a few words: the line they scan. */
  headline: z.string().max(120).optional(),
  /** What happened and what's needed, in a sentence or two. */
  summary: z.string().min(1).max(500),
  recommendation: z.string().max(300).optional(),
  /** The exact message to send the worker if the user accepts the recommendation. */
  reply: z.string().max(2000).optional(),
});
export const briefingSchema = z.object({
  at: z.number(),
  items: z.array(briefingItemSchema).max(40),
  handled: z.array(z.object({ threadId: z.string().max(200).nullable(), what: z.string().min(1).max(300) })).max(60),
  note: z.string().max(1000).optional(),
});
export type BriefingItem = z.infer<typeof briefingItemSchema>;

/** What the page shows around a briefing item, read from the thread itself. */
export const briefingContextSchema = z.object({
  status: z.string(),
  /** Since when the thread has waited on the user (or last asked for attention). */
  waitingSince: z.number().nullable(),
  dueAt: z.number().nullable(),
  dueReason: z.string().nullable(),
  goal: z.string().nullable(),
  next: z.string().nullable(),
  blocked: z.string().nullable(),
  prs: z.array(z.object({ repo: z.string(), number: z.number(), attention: z.string(), url: z.string(), title: z.string() })),
  /** The numbered options the worker ended on: one number ("choice"), several ("multi") or "go 1,3" ("go"). */
  options: z.array(z.object({ n: z.number(), text: z.string(), recommended: z.boolean() })),
  optionsMode: z.enum(["go", "choice", "multi"]).nullable(),
});
export type BriefingContext = z.infer<typeof briefingContextSchema>;

/** The line a briefing item is scanned by: its headline, or the first sentence of its summary. */
export function headlineOf(item: Pick<BriefingItem, "headline" | "summary">, max = 90): string {
  const text = item.headline?.trim() || item.summary.split(/(?<=[.!?])\s/)[0]!.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
export type Briefing = z.infer<typeof briefingSchema>;

/** Standing preferences the conductor keeps between sessions. */
export const MEMORY_MAX = 2000;
/** What one wake-up message may carry before pointing at conductor_inbox. */
export const WAKE_MAX_CHARS = 4000;
const EVENT_MAX_CHARS = 400;

/** A batch is due once its oldest event has waited the batch window. */
export function wakeDue(oldestCreatedAt: number | null, now: number, batchMs: number): boolean {
  return oldestCreatedAt !== null && now - oldestCreatedAt >= batchMs;
}

/** The first wake-up of a day compacts the conversation first, so a permanent thread stays small. */
export function compactToday(record: Pick<ConductorRecord, "compactedOn" | "lastWakeAt">, now: Date): { compact: boolean; day: string } {
  const day = localDay(now);
  return { compact: record.lastWakeAt !== undefined && record.compactedOn !== day, day };
}

export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One inbox event as a line: id, kind, thread, PR and intent, then the news. */
export function eventLine(event: StoredConductorEvent, title: string): string {
  const meta = event.meta as { repo?: unknown; pr?: unknown; afterGreen?: unknown };
  const pr = typeof meta.repo === "string" && typeof meta.pr === "number" ? ` · ${meta.repo}#${meta.pr}` : "";
  const intent = typeof meta.afterGreen === "string" ? ` · after_green: ${meta.afterGreen}` : "";
  return `#${event.id} [${event.kind}] "${oneLine(title || "Untitled", 80)}" (${event.threadId})${pr}${intent} — ${oneLine(event.text, EVENT_MAX_CHARS)}`;
}

/** The message that wakes a conductor for a batch of events. */
export function wakeMessage(
  events: readonly StoredConductorEvent[],
  titleOf: (threadId: string) => string,
  maxChars = WAKE_MAX_CHARS,
): string {
  const head = `[conductor inbox] ${events.length} new event${events.length === 1 ? "" : "s"}:`;
  const tail = "Handle them, acknowledge what you handled with conductor_inbox, and end with post_briefing.";
  const lines: string[] = [];
  let used = head.length + tail.length + 4;
  for (const [index, event] of events.entries()) {
    const line = eventLine(event, titleOf(event.threadId));
    if (used + line.length + 1 > maxChars && lines.length > 0) {
      lines.push(`… and ${events.length - index} more: call conductor_inbox.`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return `${head}\n${lines.join("\n")}\n\n${tail}`;
}

/** What a worker needs from you, as far as its own words say. */
export type ThreadAsk = {
  /** Who holds the next move (now-model's BallState): blocked, yours, go, stalled, … */
  ball: string;
  /** Its parsed status report, if its last reply had one. */
  report: { next: string; blocked: string; done: string; steps?: { mode: string; question: string; items: string[]; recommended: number[] } | null } | null;
  /** Its last reply. */
  latest: string;
  /** The numbered options it ended on (decisions.ts nextMove). */
  move: { mode: "go" | "choice" | "multi"; options: Array<{ n: number; text: string; recommended: boolean }> };
  /** Waiting on a question or permission, or its last turn failed. */
  pending: "input" | "failed" | null;
};

/** What "Nudge" sends a worker that promised to report back and went quiet. */
export const NUDGE_REPLY =
  "You said you'd report back, but this thread went idle and nothing is running. Check the current state now, then continue or tell me what's blocking.";

const clean = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const NOT_BLOCKED = /^(?:none|nothing|no|n\/a|-)\.?$/i;

/** The last real sentence of a reply, skipping dates, links-only lines and sign-offs. */
function lastSentence(text: string): string | null {
  const lines = text
    .trim()
    .split("\n")
    .map(clean)
    .filter((line) => line.length > 12 && !/^\d{4}-\d{2}-\d{2}|^_?\d{1,2}[./]\d{1,2}|^(?:goal|done|next|blocked|stack|progress)\b/i.test(line));
  const last = lines.at(-1);
  if (!last) return null;
  const sentences = last.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 12);
  return sentences.at(-1) ?? last;
}

/** The last line of a reply that asks something. */
function questionIn(text: string): string | null {
  const lines = text.trim().split("\n").slice(-20).reverse();
  const asking = lines.find((line) => /\?\s*\**\s*$/.test(line.trim()));
  return asking ? clean(asking) : null;
}

/**
 * A briefing item built from the worker's own words, with no agent involved:
 * the decision its report asks for and the option it recommends, or what it's
 * blocked on, or the question its reply ends with.
 */
export function briefFromThread(threadId: string, ask: ThreadAsk): BriefingItem | null {
  const { report } = ask;
  // The options in its stored report, when the reply's own text has none to offer.
  const steps = report?.steps;
  const move: ThreadAsk["move"] =
    ask.move.options.length > 0 || !steps || steps.items.length === 0
      ? ask.move
      : {
          mode: steps.mode === "go" || steps.mode === "multi" ? steps.mode : "choice",
          options: steps.items.map((text, index) => ({ n: index + 1, text, recommended: steps.recommended.includes(index + 1) })),
        };
  const tail = clip(clean(ask.latest).slice(-400), 300);
  const summaryOf = (fallback: string) => clip(clean(report?.done || tail || fallback), 500) || fallback;
  if (ask.ball === "stalled") {
    const headline = "Promised to report back, then went quiet";
    return { threadId, kind: "blocked", headline, summary: summaryOf(headline), recommendation: "Nudge it to check where it is and carry on", reply: NUDGE_REPLY };
  }
  if (ask.pending === "input") {
    const headline = "Waiting for your answer to a question or permission";
    return { threadId, kind: "blocked", headline, summary: summaryOf(headline) };
  }
  if (ask.pending === "failed") {
    const headline = "Its last turn failed";
    return { threadId, kind: "blocked", headline, summary: summaryOf(headline), recommendation: "Open it and retry" };
  }
  if (!["yours", "go", "blocked"].includes(ask.ball)) return null;
  const options = move.options;
  const picked = options.filter((option) => option.recommended);
  const question = clean(report?.steps?.question || "") || null;
  if (options.length > 0) {
    if (move.mode === "go") {
      const some = picked.length > 0 && picked.length < options.length;
      const headline = clip(question || clean(report?.next || "") || "Ready for your go", 120);
      return {
        threadId,
        kind: "ready",
        headline,
        summary: summaryOf(headline),
        recommendation: clip(some ? picked.map((option) => `${option.n}. ${clean(option.text)}`).join("; ") : "All the steps", 300),
        reply: some ? `go ${picked.map((option) => option.n).join(",")}` : "go",
      };
    }
    const headline = clip(question || questionIn(ask.latest) || clean(report?.next || "") || "Pick an option", 120);
    const reply = move.mode === "multi" ? picked.map((option) => option.n).join(",") : picked.length === 1 ? String(picked[0]!.n) : undefined;
    return {
      threadId,
      kind: "decision",
      headline,
      summary: summaryOf(headline),
      ...(picked.length > 0 ? { recommendation: clip(picked.map((option) => `${option.n}. ${clean(option.text)}`).join("; "), 300) } : {}),
      ...(reply ? { reply } : {}),
    };
  }
  const blocked = clean(report?.blocked || "");
  if (blocked && !NOT_BLOCKED.test(blocked)) {
    const headline = clip(blocked, 120);
    return { threadId, kind: "blocked", headline, summary: summaryOf(headline), ...(report?.next ? { recommendation: clip(clean(report.next), 300) } : {}) };
  }
  const headline = clip(questionIn(ask.latest) || clean(report?.next || "") || lastSentence(ask.latest) || "It handed the next step to you", 120);
  return { threadId, kind: "decision", headline, summary: summaryOf(headline) };
}

/** What the conductor's first message says: a cheap start, since briefs come from the workers' own reports. */
export function bootPrompt(workspaceName: string): string {
  return `You are now the conductor for the "${oneLine(workspaceName, 60)}" workspace. The user's briefs come from the workers' own status reports; you'll be woken only for judgement calls. Reply "Ready." and nothing else; don't call any tools now.`;
}

/** A conductor's message to a worker, so the worker carries on instead of answering back. */
export function relayText(message: string): string {
  return `[conductor] ${message.trim()}\n\n(Relayed by this workspace's conductor. Continue in your own thread as usual; don't message the conductor back.)`;
}

const ROLE = (workspaceName: string) => `## You are the conductor of the "${oneLine(workspaceName, 60)}" workspace
You run permanently for this bb workspace. Worker threads in it do the work. The plugin already merges and archives routine PRs, and briefs the user on every worker that needs them, from the workers' own status reports. You're woken only for judgement calls. Keep the work moving with as few worker wake-ups and user interruptions as possible.

Each time you're woken:
1. Read the events (conductor_inbox) and look at the threads they concern (fleet_status, thread_brief).
2. Routine PR work is already done for you: the plugin merges PRs whose workers said they merge once green, archives a thread when its last PR merged, and forwards to workers what they must act on. You only get what needs judgement: a merge GitHub refused, threads handing back to the user, anything unusual. Act on those with rerun_failed (a flaky failure, once) or thread_action (archive a thread with nothing left) when it's clearly right. Use merge_pr only when the worker said it merges once green and isn't running; anything else about merging goes in the briefing for the user.
3. Forward to a worker only what it must act on, with forward_to_thread: one clear instruction.
4. Never decide product, scope or outward-facing questions for the user, and never bypass branch protection or required reviews.
5. Acknowledge what you handled (conductor_inbox with ack). When something needs the user's judgement that a worker's own report doesn't already say, add it with post_briefing (a headline of at most 8 words, a one- or two-sentence summary, your recommendation, the exact reply for the worker) and list what you handled.

When the user writes to you:
- A bare item number or "go" means: send that item's recommended reply to its worker (forward_to_thread with mark_read).
- "2 go, 4 snooze 3d, 5: <text>": do each, with forward_to_thread or thread_action, then post_briefing again.
- Keep standing preferences they state with conductor_memory.
Act on other threads only through these tools, not \`bb thread tell\`. Keep your own replies short; the briefing is what the user reads.`;

/** The conductor's instructions, within bb's 4096-character limit; the user's own text is cut first. */
export function conductorInstructions(workspaceName: string, prompt: string, memory: string): string {
  const parts = [ROLE(workspaceName)];
  if (memory.trim()) parts.push(`## Standing preferences (from conductor_memory)\n\`\`\`\n${memory.trim().slice(0, MEMORY_MAX).replaceAll("```", "'''")}\n\`\`\``);
  const base = parts.join("\n\n");
  const extra = prompt.trim();
  if (!extra) return base;
  const room = 4096 - base.length - 40;
  return room > 0 ? `${base}\n\n## The user's instructions\n${extra.slice(0, room)}` : base;
}

/** gh's flag for the merge method a repo defaults to. */
export function mergeFlag(viewerDefault: string | null | undefined): "--squash" | "--merge" | "--rebase" {
  if (viewerDefault === "MERGE") return "--merge";
  if (viewerDefault === "REBASE") return "--rebase";
  return "--squash";
}

/** Run ids of a PR's failed GitHub Actions checks. */
export function failedRunIds(checks: ReadonlyArray<{ conclusion?: string | null; state?: string; detailsUrl?: string; targetUrl?: string }>): string[] {
  const ids = new Set<string>();
  for (const check of checks) {
    const failed = ["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"].includes(check.conclusion ?? "") || ["FAILURE", "ERROR"].includes(check.state ?? "");
    const run = /\/actions\/runs\/(\d+)/.exec(check.detailsUrl ?? check.targetUrl ?? "")?.[1];
    if (failed && run) ids.add(run);
  }
  return [...ids];
}
