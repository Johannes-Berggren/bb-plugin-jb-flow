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
const plain = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Read the Stream Deck Status template. Never infer a global completion percentage. */
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
  return { ...fields, milestones, capturedAt };
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

/** One bounded durable record per thread, shared by every BB window and device. */
export function createThreadStatus(bb: BbPluginApi, changed: () => void) {
  const pending = new Map<string, Promise<unknown>>();
  let disposed = false;
  bb.onDispose(() => {
    disposed = true;
  });
  const key = (id: string) => `thread-status:${id}`;
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
      if (!disposed) await bb.storage.kv.delete(key(thread.id));
    }),
  );
  return {
    get: (id: string, refresh = true) =>
      refresh
        ? capture(id)
        : serial(id, () => (disposed ? Promise.resolve(null) : read(id))),
  };
}
