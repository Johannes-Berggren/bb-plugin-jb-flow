// Which machine each thread runs on (its environment's host), for the sidebar's
// machine filter. Cached briefly: state_get runs on every change.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const machinesSchema = z.object({
  /** Machines that run at least one live thread. */
  hosts: z.array(z.object({ id: z.string(), name: z.string(), connected: z.boolean() })),
  /** Thread id → host id. */
  threadHosts: z.record(z.string(), z.string()),
  /** Environment id → host id, so a new thread resolves before the next refresh. */
  environmentHosts: z.record(z.string(), z.string()),
  /** The machine BB itself runs on (this host daemon's id). */
  localHostId: z.string().nullable(),
});
export type Machines = z.infer<typeof machinesSchema>;

const CACHE_MS = 30_000;

function readLocalHostId(dataDir: string): string | null {
  try {
    // bb's data dir, not ~/.bb: a second instance (or a dev build) has its own.
    return readFileSync(join(dataDir, "host-id"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function createMachines(bb: BbPluginApi) {
  let cached: { at: number; value: Machines } | null = null;
  const localHostId = readLocalHostId(bb.server.experimental_dataDir);
  async function read(): Promise<Machines> {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    const [threads, environments, hosts] = await Promise.all([
      bb.sdk.threads.list({ limit: 500 }),
      bb.sdk.environments.list(),
      bb.sdk.hosts.list(),
    ]);
    const envHost = new Map(environments.map((environment) => [environment.id, environment.hostId]));
    const threadHosts: Record<string, string> = {};
    for (const thread of threads) {
      if (thread.archivedAt !== null || thread.environmentId === null) continue;
      const hostId = envHost.get(thread.environmentId);
      if (hostId) threadHosts[thread.id] = hostId;
    }
    const used = new Set(Object.values(threadHosts));
    const value: Machines = {
      hosts: hosts
        .filter((host) => used.has(host.id))
        .map((host) => ({ id: host.id, name: host.name, connected: host.status === "connected" })),
      threadHosts,
      environmentHosts: Object.fromEntries(environments.map((environment) => [environment.id, environment.hostId])),
      localHostId,
    };
    cached = { at: Date.now(), value };
    return value;
  }
  return {
    read: () => read().catch(() => cached?.value ?? { hosts: [], threadHosts: {}, environmentHosts: {}, localHostId }),
    /** A thread started or moved: recompute on the next read. */
    invalidate: () => {
      cached = null;
    },
  };
}
