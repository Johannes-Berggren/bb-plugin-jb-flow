// What the plugin will wake a thread for: auto-continue after a usage limit
// resets (on by setting, switchable per thread), release waiters and CI
// watches, as the labels the thread monitor and the Triage list show.
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { FlowState, rpcContract } from "./rpc-contract";
import { formatWhen } from "./when";
import type { createWatchers } from "./watchers";

/** Each thread's own auto-continue switch (thread monitor); absent = the setting. */
export function autoContinueOverridesFor(bb: BbPluginApi) {
  return async () =>
    (await bb.storage.kv.get<Record<string, boolean>>("autoContinueThreads")) ?? {};
}

type WakeupDeps = {
  settings: { get(): Promise<{ autoContinue: boolean }> };
  changed: () => void;
  watchers: ReturnType<typeof createWatchers>;
  autoContinueOverrides: () => Promise<Record<string, boolean>>;
};

export function createWakeups(bb: BbPluginApi, { settings, changed, watchers, autoContinueOverrides }: WakeupDeps) {
  async function watchingByThread() {
    const status = await watchers.status();
    const watching: FlowState["watching"] = {};
    const releaseProjects = new Map<string, string[]>();
    for (const waiter of Object.values(status.releaseWaiters)) {
      releaseProjects.set(waiter.threadId, [...(releaseProjects.get(waiter.threadId) ?? []), waiter.projectName]);
    }
    for (const [threadId, names] of releaseProjects) {
      watching[threadId] = { kind: "release", label: `Waiting for the next ${names.join(" / ")} release` };
    }
    for (const [threadId, entry] of Object.entries(status.autoContinue)) {
      watching[threadId] = { kind: "continue", label: `Limit hit; auto-continues ${formatWhen(entry.resetsAt + 90_000)}` };
    }
    for (const watch of Object.values(status.ciWatches)) {
      watching[watch.threadId] = { kind: "ci", label: `Watching ${watch.repo.split("/")[1]}#${watch.pr} (${watch.watchFor})` };
    }
    return watching;
  }

  const rpc: Pick<PluginRpcHandlers<typeof rpcContract>, "auto_continue_get" | "wakeups_get" | "wakeup_cancel" | "auto_continue_set"> = {
    auto_continue_get: async ({ threadId }) => ({
      enabled: (await autoContinueOverrides())[threadId] ?? (await settings.get()).autoContinue,
      scheduledAt: await watchers.autoContinueAt(threadId),
    }),
    wakeups_get: async ({ threadId }) => ({
      autoContinue: {
        enabled: (await autoContinueOverrides())[threadId] ?? (await settings.get()).autoContinue,
        scheduledAt: await watchers.autoContinueAt(threadId),
      },
      watches: await watchers.wakeupsFor(threadId),
    }),
    wakeup_cancel: async ({ threadId, kind, key }) => {
      await watchers.cancelWakeup(threadId, kind, key);
      return { ok: true };
    },
    auto_continue_set: async ({ threadId, enabled }) => {
      const overrides = await autoContinueOverrides();
      overrides[threadId] = enabled;
      await bb.storage.kv.set("autoContinueThreads", overrides);
      // Switched off with a "continue" already queued: take it back.
      if (!enabled) await watchers.cancelAutoContinue(threadId);
      changed();
      return { enabled, scheduledAt: enabled ? await watchers.autoContinueAt(threadId) : null };
    },
  };

  return { watchingByThread, rpc };
}
