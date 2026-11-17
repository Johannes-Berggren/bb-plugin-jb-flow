// The live thread list, read two ways: every active, visible thread (for the
// digest, Your move and pruning), and a list cached for 10s for the deck and
// the conductor, dropped whenever a thread starts or stops.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { listLiveThreads } from "./thread-list";

export type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
export type ListedThread = Thread;

export function createThreadLists(bb: BbPluginApi) {
  async function listAllActiveThreads(): Promise<Thread[]> {
    const threads = await listLiveThreads(bb);
    // Filter as well: archived/hidden rows must never reach the digest.
    return threads.filter(
      (thread) => thread.archivedAt === null && thread.deletedAt === null && thread.visibility === "visible",
    );
  }

  let threadListCache: { at: number; threads: Promise<ListedThread[]> } | null = null;
  function listThreadsCached(): Promise<ListedThread[]> {
    if (threadListCache === null || Date.now() - threadListCache.at > 10_000) {
      const threads = listLiveThreads(bb);
      threadListCache = { at: Date.now(), threads };
      threads.catch(() => {
        threadListCache = null;
      });
    }
    return threadListCache.threads;
  }

  return {
    listAllActiveThreads,
    listThreadsCached,
    invalidate: () => {
      threadListCache = null;
    },
  };
}
