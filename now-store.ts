// What you've marked as Focus (thread id → when). Stored apart from sections, so
// a thread keeps its section while it's in Focus. The name is `focused` because
// focus.ts already means "the window you're looking at".
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { matchLanes, type LaneSections } from "./lanes.ts";
import { listLiveThreads } from "./thread-list.ts";

const FOCUSED_KEY = "focused";
const SEEDED_KEY = "focusedSeeded";

type Store = {
  storage: { kv: Pick<BbPluginApi["storage"]["kv"], "get" | "set"> };
  sdk: {
    threadSections: { list(): Promise<readonly { id: string; name: string }[]> };
    threads: Parameters<typeof listLiveThreads<{ id: string }>>[0]["sdk"]["threads"];
  };
  events: { on(event: "thread.archived" | "thread.deleted", listener: (payload: { thread: { id: string } }) => unknown): unknown };
};

export function createNowStore(bb: Store, changed: () => void) {
  const kv = bb.storage.kv;
  // One queue, so a write never replaces another with a stale copy.
  let lock: Promise<unknown> = Promise.resolve();
  const queued = <T>(work: () => Promise<T>): Promise<T> => {
    const run = lock.then(work);
    lock = run.catch(() => undefined);
    return run;
  };
  const read = async () => (await kv.get<Record<string, number>>(FOCUSED_KEY)) ?? {};

  /**
   * Once, on first use: what's in your Priority lane starts in Focus. With no
   * such lane there's nothing to copy, so a new install starts empty. A failed
   * read tries again next time rather than dropping the threads.
   */
  const seeded = async () => {
    if ((await kv.get<boolean>(SEEDED_KEY)) === true) return;
    const sections = await bb.sdk.threadSections.list();
    const pinned = (await kv.get<LaneSections>("laneSections")) ?? {};
    const priority = matchLanes(sections, pinned).priority;
    if (priority !== undefined) {
      const threads = await listLiveThreads(bb, { sectionId: priority });
      if (threads.length > 0) {
        const all = await read();
        const at = Date.now();
        for (const thread of threads) all[thread.id] ??= at;
        await kv.set(FOCUSED_KEY, all);
      }
    }
    await kv.set(SEEDED_KEY, true);
  };

  const all = () =>
    queued(async () => {
      await seeded().catch(() => undefined);
      return read();
    });

  const set = async (threadId: string, focused: boolean) => {
    const moved = await queued(async () => {
      await seeded().catch(() => undefined);
      const current = await read();
      if (focused === (threadId in current)) return false;
      if (focused) current[threadId] = Date.now();
      else delete current[threadId];
      await kv.set(FOCUSED_KEY, current);
      return true;
    });
    if (moved) changed();
    return focused;
  };

  /** Drops every thread that isn't live any more. */
  const prune = async (isLive: (threadId: string) => boolean) => {
    const pruned = await queued(async () => {
      const current = await read();
      const gone = Object.keys(current).filter((threadId) => !isLive(threadId));
      if (gone.length === 0) return false;
      for (const threadId of gone) delete current[threadId];
      await kv.set(FOCUSED_KEY, current);
      return true;
    });
    if (pruned) changed();
  };

  const forget = ({ thread }: { thread: { id: string } }) => prune((threadId) => threadId !== thread.id);
  bb.events.on("thread.archived", forget);
  bb.events.on("thread.deleted", forget);

  return { all, set, prune };
}
