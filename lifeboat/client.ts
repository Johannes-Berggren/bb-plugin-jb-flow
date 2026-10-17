import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { lifeboatRpc, Operation, Snapshot } from "./contract";

export type Host = { id: string; name: string; connected: boolean };
export type ReadingState = {
  snapshot: Snapshot | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  setupRequired: boolean;
};
export type ClientState = {
  hosts: Host[];
  localHostId: string | null;
  inventoryLoaded: boolean;
  inventoryError: string | null;
  readings: Record<string, ReadingState>;
  now: number;
};
type Rpc = Pick<PluginRpcClient<typeof lifeboatRpc>, "call">;
export const EMPTY_READING: ReadingState = {
  snapshot: null,
  loading: false,
  busy: false,
  error: null,
  setupRequired: false,
};
const CACHE_MS = 30_000;

/** One read cache and polling clock per BB window, shared by every UI surface. */
export function createLifeboatClient() {
  const initial = (): ClientState => ({
    hosts: [],
    localHostId: null,
    inventoryLoaded: false,
    inventoryError: null,
    readings: {},
    now: Date.now(),
  });
  let state = initial();
  let rpc: Rpc | null = null;
  let references = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inventoryFlight: Promise<void> | null = null;
  let inventoryAt = 0;
  let connection: string | null = null;
  const listeners = new Set<() => void>();
  const demand = new Map<string, number>();
  const flights = new Map<string, Promise<boolean>>();
  const checkedAt = new Map<string, number>();
  let epoch = 0;
  const publish = (next: ClientState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const update = (id: string, change: Partial<ReadingState>) =>
    publish({
      ...state,
      readings: {
        ...state.readings,
        [id]: { ...(state.readings[id] ?? EMPTY_READING), ...change },
      },
    });
  async function discover(force = false): Promise<void> {
    if (
      !rpc ||
      (!force && state.inventoryLoaded && Date.now() - inventoryAt < CACHE_MS)
    )
      return;
    if (inventoryFlight) return inventoryFlight;
    const current = epoch;
    return (inventoryFlight = rpc
      .call("lifeboat_hosts", null)
      .then((inventory) => {
        if (current !== epoch) return;
        inventoryAt = Date.now();
        publish({
          ...state,
          ...inventory,
          inventoryLoaded: true,
          inventoryError: null,
        });
      })
      .catch(() => {
        if (current === epoch)
          publish({
            ...state,
            inventoryLoaded: true,
            inventoryError:
              "Could not load your Macs. Reconnect BB, then retry.",
          });
      })
      .finally(() => {
        if (current === epoch) inventoryFlight = null;
      }));
  }
  async function run(
    hostId: string,
    operation: Operation,
    force = false,
  ): Promise<boolean> {
    if (!rpc || !hostId) return false;
    if (flights.has(hostId))
      return operation.command === "status" ? flights.get(hostId)! : false;
    if (
      operation.command === "status" &&
      !force &&
      Date.now() - (checkedAt.get(hostId) ?? 0) < CACHE_MS
    )
      return true;
    const current = epoch;
    const host = state.hosts.find((host) => host.id === hostId);
    if (!host?.connected) {
      update(hostId, {
        error: "This Mac is offline. Connect it to BB, then retry.",
        loading: false,
      });
      return false;
    }
    const mutation = operation.command !== "status";
    update(hostId, {
      loading: !state.readings[hostId]?.snapshot,
      busy: mutation,
      error: null,
    });
    const task = rpc
      .call("lifeboat_run", { hostId, operation })
      .then((result) => {
        if (current !== epoch) return false;
        checkedAt.set(hostId, Date.now());
        if (result.ok) {
          update(hostId, {
            snapshot: result.state,
            setupRequired: false,
            error: null,
          });
          return true;
        }
        update(hostId, {
          error: result.error,
          setupRequired: result.setupRequired ?? false,
        });
        return false;
      })
      .catch(() => {
        if (current === epoch)
          update(hostId, {
            error:
              "BB lost touch with this Mac. Refresh before trying another account operation.",
          });
        return false;
      })
      .finally(() => {
        if (current === epoch) {
          flights.delete(hostId);
          update(hostId, { loading: false, busy: false });
        }
      });
    flights.set(hostId, task);
    return task;
  }
  async function tick() {
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    )
      return;
    publish({ ...state, now: Date.now() });
    await discover();
    await Promise.allSettled(
      [...demand.keys()].map((id) => run(id, { command: "status" })),
    );
  }
  const onVisibility = () => {
    void tick();
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acquire(nextRpc: Rpc) {
      rpc = nextRpc;
      references++;
      if (!timer) {
        timer = setInterval(() => {
          void tick();
        }, CACHE_MS);
        if (typeof document !== "undefined")
          document.addEventListener("visibilitychange", onVisibility);
      }
      void discover();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        references--;
        if (!references && timer) {
          clearInterval(timer);
          timer = null;
          if (typeof document !== "undefined")
            document.removeEventListener("visibilitychange", onVisibility);
        }
      };
    },
    watch(hostId: string) {
      demand.set(hostId, (demand.get(hostId) ?? 0) + 1);
      void run(hostId, { command: "status" });
      return () => {
        const next = (demand.get(hostId) ?? 1) - 1;
        if (next) demand.set(hostId, next);
        else demand.delete(hostId);
      };
    },
    discover,
    run,
    connectionChanged(next: string) {
      if (connection === next) return;
      const previous = connection;
      connection = next;
      if (next === "connected" && previous !== null)
        void discover(true).then(() => {
          for (const id of demand.keys()) {
            checkedAt.delete(id);
            void run(id, { command: "status" });
          }
        });
    },
    invalidate(hostId: string) {
      checkedAt.delete(hostId);
      if (demand.has(hostId)) void run(hostId, { command: "status" });
    },
    /** Also prevents replies from a disposed frontend generation updating its cache. */
    reset() {
      epoch++;
      if (timer) clearInterval(timer);
      timer = null;
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", onVisibility);
      connection = null;
      references = 0;
      rpc = null;
      inventoryFlight = null;
      inventoryAt = 0;
      flights.clear();
      checkedAt.clear();
      demand.clear();
      publish(initial());
    },
  };
}
export const lifeboatClient = createLifeboatClient();
