// Where the server holds the workspace conductors (conductor.ts) while they
// load: the sink the watchers route PR news through, and the conductor_* RPC
// handlers. server.ts creates the conductor once the stores it reads exist.
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { Conductor } from "./conductor";
import type { ConductorSink } from "./conductor-routing";
import type { rpcContract } from "./rpc-contract";

export function createConductorWiring(settings: { get(): Promise<{ conductor: boolean }> }) {
  // Created further down, once the stores it reads exist; until then threads hear their own news.
  let conductor: Conductor | null = null;
  const loadedConductor = () => {
    if (!conductor) throw new Error("The conductor is still loading; try again in a moment.");
    return conductor;
  };
  const conductorSink: ConductorSink = {
    workspaceFor: async (threadId) => (conductor ? conductor.sink.workspaceFor(threadId) : null),
    deliver: async (threadId, workspaceId, events) => {
      if (!conductor) throw new Error("The conductor isn't loaded yet.");
      await conductor.sink.deliver(threadId, workspaceId, events);
    },
  };

  const rpc: Pick<
    PluginRpcHandlers<typeof rpcContract>,
    "conductor_list" | "conductor_page" | "conductor_briefs" | "conductor_feed" | "conductor_fleet" | "conductor_start" | "conductor_stop" | "conductor_wake"
  > = {
    conductor_list: async () => ({ enabled: (await settings.get()).conductor === true, conductors: await loadedConductor().status() }),
    conductor_page: ({ workspaceId }) => loadedConductor().page(workspaceId),
    conductor_briefs: async () => ({ briefs: conductor ? await conductor.briefs() : [] }),
    conductor_feed: ({ since }) => loadedConductor().feed(since),
    conductor_fleet: ({ workspaceId }) => loadedConductor().fleet(workspaceId),
    conductor_start: async ({ workspaceId, projectId, providerId, model }) => ({
      threadId: (await loadedConductor().start(workspaceId, { projectId, providerId, model })).threadId,
    }),
    conductor_stop: async ({ workspaceId }) => ({ ok: await loadedConductor().stop(workspaceId) }),
    conductor_wake: async ({ workspaceId }) => ({ result: await loadedConductor().wake(workspaceId, true) }),
  };

  return {
    conductorSink,
    rpc,
    /** The conductor, or null while it's loading. */
    current: (): Conductor | null => conductor,
    load: async (loading: Promise<Conductor>) => {
      conductor = await loading;
    },
  };
}
