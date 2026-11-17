// The daily digest of stale threads: unsectioned threads idle for staleDays,
// with the last agent message as a summary, "keep" marks that hold a thread
// out of it for a while, and archiving threads in bulk from it.
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { Conductor } from "./conductor";
import type { Digest, DigestItem, rpcContract, Snooze } from "./rpc-contract";
import { quietFor, staleThreads } from "./sidebar-groups";
import type { Thread } from "./thread-cache";

const DAY_MS = 86_400_000;

type StaleDigestDeps = {
  settings: { get(): Promise<{ staleDays: number }> };
  changed: () => void;
  getSnoozes: () => Promise<Record<string, Snooze>>;
  listAllActiveThreads: () => Promise<Thread[]>;
  /** Null until the conductor has loaded. */
  conductor: () => Pick<Conductor, "isConductor"> | null;
};

export function createStaleDigest(bb: BbPluginApi, { settings, changed, getSnoozes, listAllActiveThreads, conductor }: StaleDigestDeps) {
  async function getKept(): Promise<Record<string, number>> {
    return (await bb.storage.kv.get<Record<string, number>>("kept")) ?? {};
  }

  async function summarize(threadId: string): Promise<string> {
    try {
      const outline = await bb.sdk.threads.conversationOutline({ threadId });
      const last =
        [...outline.items].reverse().find((item) => item.role === "assistant") ??
        outline.items.at(-1);
      return (last?.preview ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    } catch {
      return "";
    }
  }

  async function buildDigest(): Promise<Digest> {
    const now = Date.now();
    const kept = await getKept();
    const snoozes = await getSnoozes();
    // Read per build so a changed setting applies without a reload.
    const { staleDays } = await settings.get();
    const stale = staleThreads(await listAllActiveThreads(), { now, staleMs: staleDays * DAY_MS, keptUntil: kept, snoozed: snoozes });

    const items: DigestItem[] = [];
    // Small batches keep the outline reads from hammering the server.
    for (let index = 0; index < stale.length; index += 8) {
      const batch = stale.slice(index, index + 8);
      const summaries = await Promise.all(batch.map((thread) => summarize(thread.id)));
      batch.forEach((thread, offset) => {
        items.push({
          threadId: thread.id,
          projectId: thread.projectId,
          title: thread.title ?? thread.titleFallback ?? "Untitled",
          idleDays: Math.floor(quietFor(thread, now) / DAY_MS),
          summary: summaries[offset] ?? "",
        });
      });
    }
    const digest = { generatedAt: now, items };
    await bb.storage.kv.set("digest", digest);
    changed();
    return digest;
  }

  async function readDigest(refresh: boolean): Promise<Digest> {
    const cached = await bb.storage.kv.get<Digest>("digest");
    if (refresh || cached === null || cached === undefined) return buildDigest();
    const kept = await getKept();
    const now = Date.now();
    return { ...cached, items: cached.items.filter((item) => (kept[item.threadId] ?? 0) < now) };
  }

  async function archive(threadIds: string[]) {
    const failed: string[] = [];
    // A conductor is permanent; archiving one in bulk would only bring it straight back.
    threadIds = threadIds.filter((threadId) => !conductor()?.isConductor(threadId));
    // bb archives a thread's subthreads with it; they leave the digest too.
    const archived = new Set<string>();
    for (const threadId of threadIds) {
      const result = await bb.sdk.threads.archive({ threadId }).catch(() => null);
      if (result === null) {
        failed.push(threadId);
        continue;
      }
      archived.add(threadId);
      for (const id of result?.archivedThreadIds ?? []) archived.add(id);
    }
    const cached = await bb.storage.kv.get<Digest>("digest");
    if (cached) {
      await bb.storage.kv.set("digest", {
        ...cached,
        items: cached.items.filter((item) => !archived.has(item.threadId)),
      });
    }
    changed();
    return { archived: threadIds.length - failed.length, failed };
  }

  const rpc: Pick<PluginRpcHandlers<typeof rpcContract>, "digest_list" | "digest_keep" | "archive"> = {
    digest_list: ({ refresh }) => readDigest(refresh),
    digest_keep: async ({ threadIds, days }) => {
      const kept = await getKept();
      const until = Date.now() + days * DAY_MS;
      for (const threadId of threadIds) kept[threadId] = until;
      await bb.storage.kv.set("kept", kept);
      changed();
      return { kept: threadIds.length };
    },
    archive: ({ threadIds }) => archive(threadIds),
  };

  return { getKept, buildDigest, readDigest, archive, rpc };
}
