import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const statusReportSchema = z.object({
  goal: z.string().max(1000),
  done: z.string().max(1000),
  next: z.string().max(1000),
  blocked: z.string().max(1000),
  milestones: z
    .array(
      z.object({
        label: z.string().max(160),
        percent: z.number().min(0).max(100),
      }),
    )
    .max(12),
  /**
   * The report's "Next steps": steps to run with "go" (all, or "go 1,3"), a
   * decision answered with a number, or one where several can go together
   * ("multi", answered with "1,3"). Optional: older saved reports lack it.
   */
  steps: z
    .object({
      mode: z.enum(["go", "choice", "multi"]),
      question: z.string().max(300),
      items: z.array(z.string().max(300)).max(9),
      recommended: z.array(z.number()).max(9),
    })
    .nullable()
    .optional(),
  /** "**Due:** 2026-11-05 · why": a deadline the agent found. Optional: older saved reports lack it. */
  due: z.string().max(1000).optional(),
  /** "Doing now: …": the agent is already carrying on, nothing to pick. */
  doingNow: z.string().max(500).optional(),
  capturedAt: z.number(),
});
export const threadStatusSchema = z.object({
  threadId: z.string(),
  report: statusReportSchema.nullable(),
  latest: z.string().max(1000),
  latestAt: z.number(),
  replyHash: z.string(),
});
export type ThreadStatus = z.infer<typeof threadStatusSchema>;
export type StatusReport = z.infer<typeof statusReportSchema>;
/**
 * Text without Markdown: links, emphasis, code marks, and quote or heading markers
 * at the start of a line. Underscores inside words and "#" or ">" mid-text stay, so
 * `TAURI_SIGNING_KEY`, "PR #64" and "a -> b" read as written.
 */
export const plain = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+)?/gm, "")
    .replace(/[*`]+/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** Read a status report (Goal/Done/Next/Blocked/Progress). Never infer a global completion percentage. */
export function parseStatusReport(
  reply: string,
  capturedAt: number,
): StatusReport | null {
  const field = (name: string) => {
    const match = new RegExp(
      `^\\s*(?:[-*]\\s+)?\\*\\*${name}:\\*\\*\\s*(.*)$`,
      "im",
    ).exec(reply);
    const value = plain(match?.[1] ?? "").slice(0, 1000);
    return /^(?:n\/?a|none|not applicable)[.!]?$/i.test(value) ? "" : value;
  };
  const fields = {
    goal: field("Goal"),
    done: field("Done"),
    next: field("Next"),
    blocked: field("Blocked"),
  };
  // Require a report-shaped response; an incidental **Next:** isn't a status report.
  if (Object.values(fields).filter(Boolean).length < 2) return null;
  const section =
    /(?:^|\n)###\s+Progress\s*\r?\n([\s\S]*?)(?=\n###\s|$)/i.exec(reply)?.[1] ??
    "";
  const milestones: StatusReport["milestones"] = [];
  for (const line of section.split("\n")) {
    const match = /^\s*\[([█░]+)\]\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const percentText = /\b(\d{1,3}(?:\.\d+)?)%/.exec(match[2]!);
    const percent = percentText
      ? Number(percentText[1])
      : /\bdone\b/i.test(match[2]!)
        ? 100
        : (Array.from(match[1]!).filter((char) => char === "█").length /
            match[1]!.length) *
          100;
    if (percent < 0 || percent > 100) continue;
    const label = plain(
      match[2]!
        .replace(/\s*\d+(?:\.\d+)?%.*$/, "")
        .replace(/\s+done\s*$/i, "")
        .replace(/\s*←.*$/, ""),
    ).slice(0, 160);
    if (label) milestones.push({ label, percent });
    if (milestones.length === 12) break;
  }
  const due = field("Due");
  return { ...fields, milestones, ...parseNextSteps(reply), ...(due ? { due } : {}), capturedAt };
}

/**
 * Wording that lets the user pick several options: "Reply with the numbers,
 * e.g. 1,2,4", "pick one or more", "all that apply". The singular "Reply with
 * the number." doesn't match. Test it against the lines around a list, not
 * its items or earlier prose.
 */
export const MULTI_REPLY =
  /\b(?:reply|answer|respond|write|type|say|send|pick|choose|select|tick)\b[^.\n]{0,40}?\b(?:numbers|number\(s\)|one or more|several|multiple|any (?:of (?:them|these)|combination|number))(?![\w(])|\ball that apply\b|\be\.\s?g\.?,?\s*[*_`"“]*\d+\s*,\s*\d/i;

/** The "### Next steps" section: a go-list, a numbered decision, or "Doing now". */
export function parseNextSteps(reply: string): Pick<StatusReport, "steps" | "doingNow"> {
  const section =
    /(?:^|\n)#{2,4}\s+Next steps?\s*\r?\n([\s\S]*?)(?=\n#{1,4}\s|$)/i.exec(reply)?.[1] ?? "";
  if (!section.trim()) return {};
  const lines = section.split("\n").map((line) => line.replace(/^\s*(?:>\s?)+/, ""));
  const text = lines.join("\n");
  const doing = /\*\*Doing now:\*\*\s*(.+)/i.exec(text)?.[1];
  const question = /\*\*Decision needed:\*\*\s*(.+)/i.exec(text)?.[1];
  const items: string[] = [];
  const recommended: number[] = [];
  const around: string[] = [];
  for (const line of lines) {
    const match = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (!match) {
      around.push(line);
      continue;
    }
    // Past nine items, keep reading: the reply line after the list still counts.
    if (items.length === 9) continue;
    if (/\(recommended\)/i.test(match[2]!)) recommended.push(items.length + 1);
    items.push(plain(match[2]!.replace(/\s*\(recommended\)\s*/i, " ")).slice(0, 300));
  }
  // "**Recommended:** 1" or "1,3" names steps by number.
  const named = /\*\*Recommended:?\*\*:?\s*([\d,\s]+)(?:$|\n)/i.exec(text)?.[1];
  for (const n of named?.match(/\d+/g) ?? []) if (Number(n) <= items.length && !recommended.includes(Number(n))) recommended.push(Number(n));
  return {
    steps: items.length
      ? { mode: question ? (MULTI_REPLY.test(around.join("\n")) ? "multi" : "choice") : "go", question: question ? plain(question).slice(0, 300) : "", items, recommended }
      : null,
    ...(doing ? { doingNow: plain(doing).slice(0, 500) } : {}),
  };
}

export function recordThreadStatus(
  threadId: string,
  reply: string,
  previous: ThreadStatus | null,
  now: number,
): ThreadStatus | null {
  if (!reply.trim()) return previous;
  const replyHash = createHash("sha256").update(reply).digest("hex");
  if (previous?.replyHash === replyHash) return previous;
  return {
    threadId,
    report: parseStatusReport(reply, now) ?? previous?.report ?? null,
    latest: plain(reply).slice(0, 1000),
    latestAt: now,
    replyHash,
  };
}

/** A refresh asked for this soon after the last read returns the stored record. */
export const RECHECK_AFTER_MS = 10_000;

/** One bounded durable record per thread, shared by every BB window and device. */
export function createThreadStatus(bb: BbPluginApi, changed: () => void) {
  const pending = new Map<string, Promise<unknown>>();
  let disposed = false;
  bb.onDispose(() => {
    disposed = true;
  });
  const key = (id: string) => `thread-status:${id}`;
  // When each thread's reply was last read. Going idle captures it, and every
  // open window then asks for a refresh too; one read of a long reply is enough.
  const checkedAt = new Map<string, number>();
  const read = async (id: string) => {
    const parsed = threadStatusSchema.safeParse(
      await bb.storage.kv.get(key(id)),
    );
    return parsed.success && parsed.data.threadId === id ? parsed.data : null;
  };
  const serial = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const result = (pending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    pending.set(id, result);
    void result
      .finally(() => {
        if (pending.get(id) === result) pending.delete(id);
      })
      .catch(() => {});
    return result;
  };
  const capture = (id: string, supplied?: string | null) =>
    serial(id, async () => {
      if (disposed) return null;
      checkedAt.set(id, Date.now());
      const previous = await read(id);
      const reply =
        supplied === undefined
          ? await bb.sdk.threads.output({ threadId: id }).then(
              (result) => result.output,
              () => null,
            )
          : supplied;
      if (disposed) return previous;
      const next = recordThreadStatus(id, reply ?? "", previous, Date.now());
      if (next && next !== previous) {
        await bb.storage.kv.set(key(id), next);
        changed();
      }
      return next;
    });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    capture(thread.id, lastAssistantText).then(() => {}),
  );
  bb.events.on("thread.deleted", ({ thread }) =>
    serial(thread.id, async () => {
      checkedAt.delete(thread.id);
      if (!disposed) await bb.storage.kv.delete(key(thread.id));
    }),
  );
  return {
    get: (id: string, refresh = true) =>
      refresh && Date.now() - (checkedAt.get(id) ?? 0) > RECHECK_AFTER_MS
        ? capture(id)
        : serial(id, () => (disposed ? Promise.resolve(null) : read(id))),
  };
}
