// The state behind the Triage thread list (FlowState, one read for the whole
// sidebar), tags and section settings, and dropping a gone thread's per-thread
// data so the stored maps stop growing.
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { createActivity } from "./activity";
import type { createAwaiting } from "./awaiting";
import { laneSections } from "./lanes";
import type { LocalConfig } from "./local-config";
import type { createMachines } from "./machines";
import type { createNowStore } from "./now-store";
import type { createPrTracker } from "./prs";
import type { FlowState, rpcContract, Snooze } from "./rpc-contract";
import type { Thread } from "./thread-cache";
import { listLiveThreads } from "./thread-list";

type TriageStateDeps = {
  localConfig: Pick<LocalConfig, "projectShortNames" | "stripProjectPrefixes">;
  changed: () => void;
  awaiting: ReturnType<typeof createAwaiting>;
  machines: ReturnType<typeof createMachines>;
  prTracker: ReturnType<typeof createPrTracker>;
  watchingByThread: () => Promise<FlowState["watching"]>;
  findSnoozedSection: () => Promise<string | null>;
  getSnoozes: () => Promise<Record<string, Snooze>>;
  nowStore: ReturnType<typeof createNowStore>;
  activity: ReturnType<typeof createActivity>;
  getKept: () => Promise<Record<string, number>>;
  autoContinueOverrides: () => Promise<Record<string, boolean>>;
  listAllActiveThreads: () => Promise<Thread[]>;
};

export function createTriageState(
  bb: BbPluginApi,
  {
    localConfig,
    changed,
    awaiting,
    machines,
    prTracker,
    watchingByThread,
    findSnoozedSection,
    getSnoozes,
    nowStore,
    activity,
    getKept,
    autoContinueOverrides,
    listAllActiveThreads,
  }: TriageStateDeps,
) {
  async function getTags(): Promise<Record<string, string[]>> {
    return (await bb.storage.kv.get<Record<string, string[]>>("tags")) ?? {};
  }

  let stateBuild: Promise<FlowState> | null = null;
  async function buildState(): Promise<FlowState> {
    // Independent reads; one round trip instead of seventeen in a row.
    const [
      awaitingAll,
      promised,
      waitingOthers,
      readyToGo,
      sectionOrder,
      sectionProjects,
      lanes,
      machineMap,
      threadPrs,
      watching,
      snoozedSectionId,
      snoozes,
      tags,
      focused,
      due,
    ] = await Promise.all([
      awaiting.all(),
      awaiting.promised(),
      awaiting.waitingOthers(),
      awaiting.readyToGo(),
      bb.storage.kv.get<string[]>("sectionOrder"),
      bb.storage.kv.get<Record<string, string>>("sectionProjects"),
      laneSections(bb),
      machines.read(),
      prTracker.byThread(),
      watchingByThread(),
      findSnoozedSection(),
      getSnoozes(),
      getTags(),
      nowStore.all(),
      nowStore.dueAll(),
    ]);
    return {
      awaiting: awaitingAll,
      promised,
      waitingOthers,
      readyToGo,
      sectionOrder: sectionOrder ?? [],
      sectionProjects: sectionProjects ?? {},
      laneSections: lanes,
      machines: machineMap,
      threadPrs,
      running: activity.snapshot(),
      watching,
      projectShortNames: localConfig.projectShortNames,
      stripProjectPrefixes: localConfig.stripProjectPrefixes,
      snoozedSectionId,
      snoozes,
      tags,
      focused,
      due,
    };
  }

  // Tags, "keep" marks and dev-server runs are per thread; drop them once the
  // thread is archived or deleted so the stored maps (sent with every state
  // load) stop growing and the tag filter only offers tags still in use.
  async function forgetThreads(isGone: (threadId: string) => boolean) {
    const tags = await getTags();
    const kept = await getKept();
    const runs = (await bb.storage.kv.get<Record<string, { threadId: string }>>("devRuns")) ?? {};
    const continues = await autoContinueOverrides();
    const goneContinues = Object.keys(continues).filter(isGone);
    if (goneContinues.length > 0) {
      for (const threadId of goneContinues) delete continues[threadId];
      await bb.storage.kv.set("autoContinueThreads", continues);
    }
    const goneTags = Object.keys(tags).filter(isGone);
    const goneKept = Object.entries(kept).filter(([threadId, until]) => isGone(threadId) || until < Date.now());
    const goneRuns = Object.entries(runs).filter(([, run]) => isGone(run.threadId));
    if (goneTags.length + goneKept.length + goneRuns.length === 0) return;
    for (const threadId of goneTags) delete tags[threadId];
    for (const [threadId] of goneKept) delete kept[threadId];
    for (const [key] of goneRuns) delete runs[key];
    await bb.storage.kv.set("tags", tags);
    await bb.storage.kv.set("kept", kept);
    await bb.storage.kv.set("devRuns", runs);
    changed();
  }
  async function pruneThreadData() {
    const live = new Set((await listAllActiveThreads()).map((thread) => thread.id));
    await forgetThreads((threadId) => !live.has(threadId));
    await awaiting.prune((threadId) => live.has(threadId));
    await nowStore.prune((threadId) => live.has(threadId));
  }

  const rpc: Pick<
    PluginRpcHandlers<typeof rpcContract>,
    "state_get" | "tags_set" | "section_order_set" | "section_project_set" | "migrate_areas"
  > = {
    // Concurrent callers (every open window refetches on the same publish) share one build.
    state_get: () => (stateBuild ??= buildState().finally(() => (stateBuild = null))),
    tags_set: async ({ threadId, tags }) => {
      const all = await getTags();
      const unique = [...new Set(tags)];
      if (unique.length === 0) delete all[threadId];
      else all[threadId] = unique;
      await bb.storage.kv.set("tags", all);
      changed();
      return { tags: unique };
    },
    section_order_set: async ({ order }) => {
      await bb.storage.kv.set("sectionOrder", order);
      changed();
      return { ok: true };
    },
    section_project_set: async ({ section, projectId }) => {
      const current = (await bb.storage.kv.get<Record<string, string>>("sectionProjects")) ?? {};
      const { [section]: _previous, ...rest } = current;
      await bb.storage.kv.set("sectionProjects", projectId === null ? rest : { ...rest, [section]: projectId });
      changed();
      return { ok: true };
    },
    migrate_areas: async ({ sectionIds, moveToSectionId }) => {
      const sections = await bb.sdk.threadSections.list();
      const tags = await getTags();
      let tagged = 0;
      for (const sectionId of sectionIds) {
        const section = sections.find((candidate) => candidate.id === sectionId);
        if (section === undefined) continue;
        const tag = section.name.replace(/^[^\p{L}\p{N}]+/u, "").trim();
        for (const thread of await listLiveThreads(bb, { sectionId })) {
          tags[thread.id] = [...new Set([...(tags[thread.id] ?? []), tag])];
          await bb.sdk.threads.update({ threadId: thread.id, sectionId: moveToSectionId });
          tagged += 1;
        }
      }
      await bb.storage.kv.set("tags", tags);
      changed();
      return { tagged };
    },
  };

  return { forgetThreads, pruneThreadData, rpc };
}
